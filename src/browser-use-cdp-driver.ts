import { assertAllowedBrowserRequest } from "./browser-network-policy";
import { hasNewSubmissionConfirmation } from "./browser-submit-confirmation";
import { BrowserUseCdpConnection } from "./browser-use-cdp";
import type { Job } from "./job";
import {
	BrowserElementError,
	type BrowserObservation,
	type BrowserSubmitResult,
	type RestrictedBrowserDriver,
} from "./restricted-browser";

const MAX_PAGE_TEXT = 20_000;
const CONFIRMATION_WAIT_MS = 5_000;

interface TargetInfo {
	targetId: string;
	type: string;
}

interface AttachedTarget {
	sessionId: string;
	targetInfo: TargetInfo;
	waitingForDebugger: boolean;
}

interface EvaluateResult {
	result: { value?: unknown };
	exceptionDetails?: unknown;
}

interface PausedRequest {
	requestId: string;
	request: { url: string; method: string };
}

export class BrowserUseCdpDriver implements RestrictedBrowserDriver {
	#targetDomain: string | undefined;
	#submissionRequestAllowed = false;
	#submissionRequestCount = 0;
	#targetPolicyError: Error | undefined;

	private constructor(
		private readonly connection: BrowserUseCdpConnection,
		private readonly sessionId: string,
	) {}

	static async connect(
		apiKey: string,
		_job: Job,
		endpoint = "wss://connect.browser-use.com",
	): Promise<BrowserUseCdpDriver> {
		if (!apiKey) throw new Error("Browser Use API key is required");
		const url = new URL(endpoint);
		if (url.protocol !== "wss:" || url.hostname !== "connect.browser-use.com") {
			throw new Error("Invalid Browser Use CDP endpoint");
		}
		url.searchParams.set("apiKey", apiKey);
		url.searchParams.set("proxyCountryCode", "jp");
		url.searchParams.set("timeout", "15");

		const connection = await BrowserUseCdpConnection.connect(url.toString());
		try {
			const { targetInfos } = await connection.send<{
				targetInfos: TargetInfo[];
			}>("Target.getTargets");
			let targetId = targetInfos.find(
				(target) => target.type === "page",
			)?.targetId;
			if (!targetId) {
				targetId = (
					await connection.send<{ targetId: string }>("Target.createTarget", {
						url: "about:blank",
					})
				).targetId;
			}
			const { sessionId } = await connection.send<{ sessionId: string }>(
				"Target.attachToTarget",
				{ targetId, flatten: true },
			);
			const driver = new BrowserUseCdpDriver(connection, sessionId);
			await driver.#initialize();
			return driver;
		} catch (error) {
			connection.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		this.connection.close();
	}

	async restrictToDomain(targetDomain: string): Promise<void> {
		if (this.#targetDomain && this.#targetDomain !== targetDomain) {
			throw new Error("Browser domain scope cannot be changed");
		}
		this.#targetDomain ??= targetDomain;
	}

	currentUrl(): Promise<string> {
		return this.#evaluate<string>("location.href");
	}

	async navigate(url: string): Promise<void> {
		const result = await this.#send<{ errorText?: string }>("Page.navigate", {
			url,
		});
		if (result.errorText) throw new Error("Browser navigation failed");
		await this.#waitForReadyState();
	}

	async observe(): Promise<BrowserObservation> {
		const snapshot = await this.#evaluate<{
			forms: unknown[];
			pageText: string;
		}>(OBSERVE_EXPRESSION);
		return { url: await this.currentUrl(), ...snapshot };
	}

	async clickNonSubmit(elementId: string): Promise<void> {
		const result = await this.#evaluateElementAction<{
			ok: boolean;
			submitLike: boolean;
		}>(elementId, CLICK_EXPRESSION);
		if (!result.ok) throw new BrowserElementError();
		if (result.submitLike) {
			throw new Error("Submit controls require the submit tool");
		}
	}

	async fill(elementId: string, value: string): Promise<void> {
		const result = await this.#evaluateElementAction<{ ok: boolean }>(
			elementId,
			FILL_EXPRESSION,
			value,
		);
		if (!result.ok) throw new BrowserElementError();
	}

	async select(elementId: string, value: string): Promise<void> {
		const result = await this.#evaluateElementAction<{ ok: boolean }>(
			elementId,
			SELECT_EXPRESSION,
			value,
		);
		if (!result.ok) throw new BrowserElementError();
	}

	async validateSubmit(elementId: string): Promise<void> {
		const valid = await this.#evaluateElementAction<boolean>(
			elementId,
			VALIDATE_SUBMIT_EXPRESSION,
		);
		if (!valid) throw new BrowserElementError();
	}

	async submit(elementId: string): Promise<BrowserSubmitResult> {
		await this.validateSubmit(elementId);
		const beforeText = await this.#bodyText();
		this.#submissionRequestAllowed = true;
		this.#submissionRequestCount = 0;
		try {
			const clicked = await this.#evaluateElementAction<boolean>(
				elementId,
				SUBMIT_EXPRESSION,
			);
			if (!clicked) throw new BrowserElementError();
			const deadline = Date.now() + CONFIRMATION_WAIT_MS;
			while (Date.now() < deadline) {
				const afterText = await this.#bodyText().catch(() => "");
				if (hasNewSubmissionConfirmation(beforeText, afterText)) {
					return { outcome: "sent", formUrl: await this.currentUrl() };
				}
				await delay(250);
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

	async #initialize(): Promise<void> {
		await denyRelatedBrowserTargets(
			this.connection,
			this.sessionId,
			(error) => {
				this.#targetPolicyError ??= error;
			},
		);
		this.connection.on("Fetch.requestPaused", (params, sessionId) => {
			if (sessionId === this.sessionId) {
				void this.#handlePausedRequest(params as PausedRequest);
			}
		});
		await this.#send("Page.enable");
		await this.#send("Runtime.enable");
		await this.#send("Network.enable");
		await this.#send("Network.setBypassServiceWorker", { bypass: true });
		await this.#send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
		await this.#send("Page.addScriptToEvaluateOnNewDocument", {
			source: BLOCK_BROWSER_ESCAPE_EXPRESSION,
		});
		await this.#evaluate(BLOCK_BROWSER_ESCAPE_EXPRESSION);
	}

	async #handlePausedRequest(paused: PausedRequest): Promise<void> {
		try {
			if (!this.#targetDomain) {
				throw new Error("Browser domain scope is not configured");
			}
			const unsafeRequest = !["GET", "HEAD", "OPTIONS"].includes(
				paused.request.method.toUpperCase(),
			);
			assertAllowedBrowserRequest(
				paused.request.url,
				this.#targetDomain,
				paused.request.method,
				this.#submissionRequestAllowed && this.#submissionRequestCount === 0,
			);
			if (unsafeRequest) this.#submissionRequestCount += 1;
			await this.#send("Fetch.continueRequest", {
				requestId: paused.requestId,
			});
		} catch {
			await this.#send("Fetch.failRequest", {
				requestId: paused.requestId,
				errorReason: "BlockedByClient",
			}).catch(() => undefined);
		}
	}

	async #waitForReadyState(): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const readyState = await this.#evaluate<string>(
				"document.readyState",
			).catch(() => "loading");
			if (readyState === "interactive" || readyState === "complete") return;
			await delay(100);
		}
		throw new Error("Browser page did not become ready");
	}

	#bodyText(): Promise<string> {
		return this.#evaluate<string>(
			`(document.body?.innerText ?? "").slice(0, ${MAX_PAGE_TEXT})`,
		);
	}

	#evaluateElementAction<TResult>(
		elementId: string,
		actionExpression: string,
		value?: string,
	): Promise<TResult> {
		return this.#evaluate<TResult>(
			`(${actionExpression})(${JSON.stringify(elementId)}, ${JSON.stringify(value ?? "")})`,
		);
	}

	async #evaluate<TResult>(expression: string): Promise<TResult> {
		const result = await this.#send<EvaluateResult>("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			throw new Error("Browser page evaluation failed");
		}
		return result.result.value as TResult;
	}

	#send<TResult = unknown>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<TResult> {
		if (this.#targetPolicyError) {
			return Promise.reject(this.#targetPolicyError);
		}
		return this.connection.send<TResult>(method, params, this.sessionId);
	}
}

export async function denyRelatedBrowserTargets(
	connection: Pick<BrowserUseCdpConnection, "on" | "send">,
	parentSessionId: string,
	onPolicyFailure: (error: Error) => void,
): Promise<void> {
	connection.on("Target.attachedToTarget", (params, sessionId) => {
		if (sessionId !== parentSessionId) return;
		const attached = params as AttachedTarget;
		if (!attached.waitingForDebugger) {
			onPolicyFailure(new Error("A related browser target was not paused"));
		}
		void connection
			.send<{ success: boolean }>("Target.closeTarget", {
				targetId: attached.targetInfo.targetId,
			})
			.then((result) => {
				if (!result.success) {
					onPolicyFailure(
						new Error("A related browser target could not be closed"),
					);
				}
			})
			.catch(() => {
				onPolicyFailure(
					new Error("A related browser target could not be closed"),
				);
			});
	});
	await connection.send(
		"Target.setAutoAttach",
		{
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
		},
		parentSessionId,
	);
}

export const BLOCK_BROWSER_ESCAPE_EXPRESSION = `(() => {
  class BlockedNetworkConstructor { constructor() { throw new Error("Browser network escape is disabled"); } }
  for (const name of ["WebSocket", "Worker", "SharedWorker"]) {
    Object.defineProperty(globalThis, name, { value: BlockedNetworkConstructor, configurable: false, writable: false });
  }
  Object.defineProperty(globalThis, "open", { value: () => null, configurable: false, writable: false });
  try {
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        value: () => Promise.reject(new Error("Service workers are disabled")),
        configurable: false,
        writable: false
      });
    }
  } catch {}
})()`;

const OBSERVE_EXPRESSION = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const labelFor = (element) => {
    const explicit = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : null;
    return (explicit?.textContent?.trim() || element.closest("label")?.textContent?.trim() || element.getAttribute("aria-label") || "").slice(0, 500);
  };
  let fieldIndex = 0;
  const forms = Array.from(document.forms).filter(visible).slice(0, 10).map((form, formIndex) => {
    const fields = Array.from(form.querySelectorAll("input, textarea, select, button"))
      .filter(visible).slice(0, Math.max(0, 100 - fieldIndex)).map((element) => {
        const elementId = "fa-" + formIndex + "-" + fieldIndex++;
        element.dataset.formAgentId = elementId;
        return {
          elementId,
          tag: element.tagName.toLowerCase(),
          type: element.type || null,
          name: element.name || null,
          label: labelFor(element),
          placeholder: element.placeholder || null,
          required: Boolean(element.required),
          value: element.type === "password" ? "" : element.value || "",
          options: element.tagName === "SELECT" ? Array.from(element.options).slice(0, 100).map((option) => ({ value: option.value, label: option.text.slice(0, 500) })) : []
        };
      });
    return { action: form.action, method: form.method, fields };
  });
  return { forms, pageText: (document.body?.innerText ?? "").slice(0, ${MAX_PAGE_TEXT}) };
})()`;

const ELEMENT_LOOKUP = `
  const elements = Array.from(document.querySelectorAll("[data-form-agent-id]"))
    .filter((element) => element.dataset.formAgentId === elementId)
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  const element = elements.length === 1 ? elements[0] : null;`;

const CLICK_EXPRESSION = `(elementId) => {${ELEMENT_LOOKUP}
  if (!element) return { ok: false, submitLike: false };
  const submitLike = (element.tagName === "BUTTON" && (!element.type || element.type === "submit")) || (element.tagName === "INPUT" && ["submit", "image"].includes(element.type));
  if (!submitLike) element.click();
  return { ok: true, submitLike };
}`;

const FILL_EXPRESSION = `(elementId, value) => {${ELEMENT_LOOKUP}
  if (!element || !["INPUT", "TEXTAREA"].includes(element.tagName)) return { ok: false };
  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return { ok: false };
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}`;

const SELECT_EXPRESSION = `(elementId, value) => {${ELEMENT_LOOKUP}
  if (!element) return { ok: false };
  if (element.tagName === "SELECT") {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (element.type === "checkbox") {
    element.checked = value === "true" || value === "checked" || value === element.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (element.type === "radio" && value === element.value) {
    element.checked = true;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  return { ok: false };
}`;

const VALIDATE_SUBMIT_EXPRESSION = `(elementId) => {${ELEMENT_LOOKUP}
  if (!element) return false;
  const submitLike = (element.tagName === "BUTTON" && (!element.type || element.type === "submit")) || (element.tagName === "INPUT" && ["submit", "image"].includes(element.type));
  const target = (element.getAttribute("formtarget") ?? element.form?.getAttribute("target") ?? "").trim().toLowerCase();
  return submitLike && (target === "" || target === "_self");
}`;

const SUBMIT_EXPRESSION = `(elementId) => {${ELEMENT_LOOKUP}
  if (!element) return false;
  const target = (element.getAttribute("formtarget") ?? element.form?.getAttribute("target") ?? "").trim().toLowerCase();
  if (target !== "" && target !== "_self") return false;
  element.click();
  return true;
}`;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
