import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "@cloudflare/playwright";
import { assertAllowedBrowserRequest } from "./browser-network-policy";
import {
	hasNewSubmissionConfirmation,
	SUBMISSION_CONFIRMATION_PATTERN,
} from "./browser-submit-confirmation";
import type { Job } from "./job";
import {
	BrowserElementError,
	type BrowserObservation,
	type BrowserSubmitResult,
	type RestrictedBrowserDriver,
} from "./restricted-browser";

interface BrowserElement {
	id: string;
	tagName: string;
	dataset: Record<string, string>;
	textContent: string | null;
	getAttribute(name: string): string | null;
	getBoundingClientRect(): { width: number; height: number };
	closest(selector: string): BrowserElement | null;
	querySelectorAll(selector: string): ArrayLike<BrowserElement>;
}

interface BrowserInputElement extends BrowserElement {
	type: string;
	name: string;
	placeholder: string;
	required: boolean;
	value: string;
}

interface BrowserFormElement extends BrowserElement {
	action: string;
	method: string;
}

interface BrowserOptionElement {
	value: string;
	text: string;
}

interface BrowserSelectElement extends BrowserInputElement {
	options: ArrayLike<BrowserOptionElement>;
}

declare const document: {
	forms: ArrayLike<BrowserFormElement>;
	body?: { innerText: string };
	querySelector(selector: string): BrowserElement | null;
};
declare const CSS: { escape(value: string): string };
declare function getComputedStyle(element: BrowserElement): {
	display: string;
	visibility: string;
};

const MAX_FORMS = 10;
const MAX_FIELDS = 100;
const MAX_PAGE_TEXT = 20_000;

export class BrowserUsePlaywrightDriver implements RestrictedBrowserDriver {
	#targetDomain: string | undefined;
	#submissionRequestAllowed = false;
	#submissionRequestCount = 0;

	private constructor(
		private readonly browser: Browser,
		private readonly context: BrowserContext,
		private readonly page: Page,
	) {}

	static async connect(
		apiKey: string,
		_job: Job,
		endpoint = "wss://connect.browser-use.com",
	): Promise<BrowserUsePlaywrightDriver> {
		if (!apiKey) {
			throw new Error("Browser Use API key is required");
		}
		const url = new URL(endpoint);
		if (url.protocol !== "wss:" || url.hostname !== "connect.browser-use.com") {
			throw new Error("Invalid Browser Use CDP endpoint");
		}
		url.searchParams.set("apiKey", apiKey);
		url.searchParams.set("proxyCountryCode", "jp");
		url.searchParams.set("timeout", "15");

		const browser = await chromium.connectOverCDP(url.toString());
		try {
			const context = browser.contexts()[0] ?? (await browser.newContext());
			const page = context.pages()[0] ?? (await context.newPage());
			page.setDefaultNavigationTimeout(30_000);
			page.setDefaultTimeout(10_000);
			return new BrowserUsePlaywrightDriver(browser, context, page);
		} catch (error) {
			await browser.close().catch(() => undefined);
			throw error;
		}
	}

	async close(): Promise<void> {
		await this.browser.close();
	}

	async restrictToDomain(targetDomain: string): Promise<void> {
		if (this.#targetDomain && this.#targetDomain !== targetDomain) {
			throw new Error("Browser domain scope cannot be changed");
		}
		if (this.#targetDomain) {
			return;
		}
		this.#targetDomain = targetDomain;
		await this.context.route("**/*", async (route) => {
			try {
				const request = route.request();
				const unsafeRequest = !["GET", "HEAD", "OPTIONS"].includes(
					request.method().toUpperCase(),
				);
				assertAllowedBrowserRequest(
					request.url(),
					targetDomain,
					request.method(),
					this.#submissionRequestAllowed && this.#submissionRequestCount === 0,
				);
				if (unsafeRequest) {
					this.#submissionRequestCount += 1;
				}
				await route.continue();
			} catch {
				await route.abort("blockedbyclient");
			}
		});
		await this.context.routeWebSocket("**/*", (webSocket) =>
			webSocket.close({ code: 1008, reason: "WebSocket access is disabled" }),
		);
		const cdp = await this.context.newCDPSession(this.page);
		await cdp.send("Network.setBypassServiceWorker", { bypass: true });
	}

	async currentUrl(): Promise<string> {
		return this.page.url();
	}

	async navigate(url: string): Promise<void> {
		await this.page.goto(url, { waitUntil: "domcontentloaded" });
	}

	async observe(): Promise<BrowserObservation> {
		const snapshot = await this.page.evaluate(
			({ maxForms, maxFields, maxPageText }) => {
				const visible = (element: BrowserElement) => {
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return (
						rect.width > 0 &&
						rect.height > 0 &&
						style.display !== "none" &&
						style.visibility !== "hidden"
					);
				};
				const labelFor = (element: BrowserElement) => {
					const id = element.id;
					const explicit = id
						? document.querySelector(`label[for="${CSS.escape(id)}"]`)
						: null;
					return (
						explicit?.textContent?.trim() ||
						element.closest("label")?.textContent?.trim() ||
						element.getAttribute("aria-label") ||
						""
					).slice(0, 500);
				};
				let fieldIndex = 0;
				const forms = Array.from(document.forms)
					.filter(visible)
					.slice(0, maxForms)
					.map((form, formIndex) => {
						const fields = Array.from(
							form.querySelectorAll("input, textarea, select, button"),
						)
							.filter(visible)
							.slice(0, Math.max(0, maxFields - fieldIndex))
							.map((element) => {
								const elementId = `fa-${formIndex}-${fieldIndex++}`;
								element.dataset.formAgentId = elementId;
								const input = element as BrowserInputElement;
								const select = element as BrowserSelectElement;
								return {
									elementId,
									tag: element.tagName.toLowerCase(),
									type: input.type || null,
									name: input.name || null,
									label: labelFor(element),
									placeholder: input.placeholder || null,
									required: input.required,
									value: input.type === "password" ? "" : input.value || "",
									options:
										element.tagName === "SELECT"
											? Array.from(select.options)
													.slice(0, 100)
													.map((option) => ({
														value: option.value,
														label: option.text.slice(0, 500),
													}))
											: [],
								};
							});
						return {
							action: form.action,
							method: form.method,
							fields,
						};
					});
				return {
					forms,
					pageText: (document.body?.innerText ?? "").slice(0, maxPageText),
				};
			},
			{
				maxForms: MAX_FORMS,
				maxFields: MAX_FIELDS,
				maxPageText: MAX_PAGE_TEXT,
			},
		);
		return { url: this.page.url(), ...snapshot };
	}

	async clickNonSubmit(elementId: string): Promise<void> {
		const locator = this.#element(elementId);
		const submitLike = await locator.evaluate((element) => {
			const input = element as unknown as BrowserInputElement;
			return (
				(element.tagName === "BUTTON" &&
					(!input.type || input.type === "submit")) ||
				(element.tagName === "INPUT" &&
					["submit", "image"].includes(input.type))
			);
		});
		if (submitLike) {
			throw new Error("Submit controls require the submit tool");
		}
		await locator.click();
	}

	async fill(elementId: string, value: string): Promise<void> {
		await this.#element(elementId).fill(value);
	}

	async select(elementId: string, value: string): Promise<void> {
		const locator = this.#element(elementId);
		const kind = await locator.evaluate((element) => {
			const input = element as unknown as BrowserInputElement;
			return { tag: input.tagName, type: input.type, value: input.value };
		});
		if (kind.tag === "SELECT") {
			await locator.selectOption(value);
			return;
		}
		if (kind.type === "checkbox") {
			await locator.setChecked(
				value === "true" || value === "checked" || value === kind.value,
			);
			return;
		}
		if (kind.type === "radio" && value === kind.value) {
			await locator.check();
			return;
		}
		throw new Error("Element does not support the requested selection");
	}

	async validateSubmit(elementId: string): Promise<void> {
		const locator = this.#element(elementId);
		if ((await locator.count()) !== 1 || !(await locator.isVisible())) {
			throw new BrowserElementError();
		}
		const submitLike = await locator.evaluate((element) => {
			const input = element as unknown as BrowserInputElement;
			return (
				(input.tagName === "BUTTON" &&
					(!input.type || input.type === "submit")) ||
				(input.tagName === "INPUT" && ["submit", "image"].includes(input.type))
			);
		});
		if (!submitLike) {
			throw new BrowserElementError();
		}
	}

	async submit(elementId: string): Promise<BrowserSubmitResult> {
		await this.validateSubmit(elementId);
		const submitControl = this.#element(elementId);
		const beforeText = await this.#bodyText();
		this.#submissionRequestAllowed = true;
		this.#submissionRequestCount = 0;
		try {
			await submitControl.click();
			await this.page
				.waitForFunction(
					(pattern) =>
						new RegExp(pattern, "i").test(document.body?.innerText ?? ""),
					SUBMISSION_CONFIRMATION_PATTERN,
					{ timeout: 5_000 },
				)
				.catch(() => undefined);
			await this.page
				.waitForLoadState("domcontentloaded", { timeout: 5_000 })
				.catch(() => undefined);
			const afterUrl = this.page.url();
			if (hasNewSubmissionConfirmation(beforeText, await this.#bodyText())) {
				return { outcome: "sent", formUrl: afterUrl };
			}
		} finally {
			this.#submissionRequestAllowed = false;
		}
		return {
			outcome: "uncertain",
			reasonCode: "SUBMIT_RESULT_UNKNOWN",
			reason: "The page did not provide a reliable submission confirmation.",
		};
	}

	#element(elementId: string) {
		return this.page
			.locator(`[data-form-agent-id="${elementId}"]`)
			.and(this.page.locator(":visible"));
	}

	#bodyText(): Promise<string> {
		return this.page
			.locator("body")
			.innerText()
			.then((text) => text.slice(0, MAX_PAGE_TEXT));
	}
}
