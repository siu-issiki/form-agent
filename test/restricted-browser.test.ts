import { describe, expect, test } from "bun:test";
import type { AgentTools } from "../src/agent-runtime";
import { assertAllowedBrowserRequest } from "../src/browser-network-policy";
import { InMemoryJobStore, type JobInput } from "../src/job";
import {
	BrowserElementError,
	type BrowserSubmitResult,
	NavigationPolicyError,
	type RestrictedBrowserDriver,
	RestrictedBrowserTools,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
} from "../src/restricted-browser";

const input: JobInput = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://acme.co.jp/contact",
	targetDomain: "acme.co.jp",
	payload: { message: "Hello" },
};

describe("RestrictedBrowserTools", () => {
	test("blocks unsafe requests until submission is authorized", () => {
		expect(() =>
			assertAllowedBrowserRequest(
				"https://form-agent.dev/contact",
				"form-agent.dev",
				"POST",
				false,
			),
		).toThrow();
		expect(() =>
			assertAllowedBrowserRequest(
				"https://form-agent.dev/contact",
				"form-agent.dev",
				"POST",
				true,
			),
		).not.toThrow();
	});

	test("allows only public HTTPS read-only subresources before form input", () => {
		expect(() =>
			assertAllowedBrowserRequest(
				"https://cdn.jsdelivr.net/form.js",
				"form-agent.dev",
				"GET",
				false,
				true,
			),
		).not.toThrow();
		expect(() =>
			assertAllowedBrowserRequest(
				"https://cdn.jsdelivr.net/collect",
				"form-agent.dev",
				"POST",
				false,
				true,
			),
		).toThrow();
		expect(() =>
			assertAllowedBrowserRequest(
				"https://localhost/form.js",
				"form-agent.dev",
				"GET",
				false,
				true,
			),
		).toThrow();
	});

	test("blocks every browser request after a dry-run interaction starts", () => {
		expect(() =>
			assertAllowedBrowserRequest(
				"https://form-agent.dev/collect?value=entered",
				"form-agent.dev",
				"GET",
				false,
				false,
				true,
			),
		).toThrow(NavigationPolicyError);
	});
	test("allows only the target domain and its subdomains", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);

		await tools.navigate("https://contact.acme.co.jp/form");
		await expect(
			tools.navigate("https://acme.co.jp.evil.test/form"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("rejects a redirect outside the target domain", async () => {
		const driver = new FakeDriver();
		driver.redirectTo = "https://evil.test/collect";
		const tools = await createTools(driver);

		await expect(
			tools.navigate("https://acme.co.jp/contact"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("submits once only after acquiring D1-compatible permission", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
			() => "2026-08-28T00:00:02.000Z",
		);
		await tools.fill("fa-0-0", "Hello");

		const sent = await tools.submit("fa-0-1");

		expect(sent.status).toBe("sent");
		expect(driver.submitCount).toBe(1);
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(1);
	});

	test("rejects submit before any successful input", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			BrowserElementError,
		);
		expect(driver.submitCount).toBe(0);
	});

	test("does not touch the browser when submission permission is missing", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await expect(
			RestrictedBrowserTools.create(driver, store, input.id, "run-token-1"),
		).rejects.toBeInstanceOf(SubmissionNotAuthorizedError);
		expect(driver.submitCount).toBe(0);
	});

	test("validates the selected submit control before claiming permission", async () => {
		const driver = new FakeDriver();
		driver.submitValidationError = new Error("not a submit control");
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
		);
		await tools.fill("fa-0-0", "Hello");

		await expect(tools.submit("fa-0-1")).rejects.toThrow();

		expect((await store.find(input.id))?.status).toBe("running");
		expect(driver.submitCount).toBe(0);
	});

	test("marks an unknown browser result uncertain and never retries", async () => {
		const driver = new FakeDriver();
		driver.submitError = new Error("connection lost");
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
			() => "2026-08-28T00:00:02.000Z",
		);
		await tools.fill("fa-0-0", "Hello");

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SUBMIT_RESULT_UNKNOWN");
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(1);
	});

	test("derives the domain from the persisted job and installs a network policy", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);
		const agentTools: AgentTools = tools;

		expect(driver.restrictedDomain).toBe(input.targetDomain);
		await agentTools.navigate(input.targetUrl);
	});

	test("rejects a persisted target domain that does not match the target URL", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(
			{ ...input, targetDomain: "com" },
			"2026-08-28T00:00:00.000Z",
		);
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		await expect(
			RestrictedBrowserTools.create(driver, store, input.id, "run-token-1"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("allows a subdomain target URL and a redirect to the apex domain", async () => {
		const driver = new FakeDriver();
		driver.url = "https://www.acme.co.jp/contact";
		const store = new InMemoryJobStore();
		await store.create(
			{ ...input, targetUrl: driver.url },
			"2026-08-28T00:00:00.000Z",
		);
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
		);

		driver.redirectTo = "https://acme.co.jp/contact";
		await tools.navigate("https://www.acme.co.jp/contact");
		expect(await driver.currentUrl()).toBe("https://acme.co.jp/contact");
	});

	test("rejects a public suffix as the target domain", async () => {
		const driver = new FakeDriver();
		driver.url = "https://co.uk/contact";
		const store = new InMemoryJobStore();
		await store.create(
			{ ...input, targetUrl: driver.url, targetDomain: "co.uk" },
			"2026-08-28T00:00:00.000Z",
		);
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		await expect(
			RestrictedBrowserTools.create(driver, store, input.id, "run-token-1"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("rejects special-use and internal target domains", async () => {
		for (const targetDomain of [
			"foo.localhost",
			"evil.local",
			"example.internal",
			"example.invalid",
		]) {
			const driver = new FakeDriver();
			driver.url = `http://${targetDomain}/contact`;
			const store = new InMemoryJobStore();
			await store.create(
				{ ...input, targetUrl: driver.url, targetDomain },
				"2026-08-28T00:00:00.000Z",
			);
			await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

			await expect(
				RestrictedBrowserTools.create(driver, store, input.id, "run-token-1"),
			).rejects.toBeInstanceOf(NavigationPolicyError);
		}
	});

	test("does not persist a sent result for an outside form URL", async () => {
		const driver = new FakeDriver();
		driver.submitResult = {
			outcome: "sent",
			formUrl: "https://evil.test/collect",
		};
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
		);
		await tools.fill("fa-0-0", "Hello");

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SUBMIT_TARGET_INVALID");
	});
});

async function createTools(
	driver: FakeDriver,
): Promise<RestrictedBrowserTools> {
	const store = new InMemoryJobStore();
	await store.create(input, "2026-08-28T00:00:00.000Z");
	await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
	return RestrictedBrowserTools.create(driver, store, input.id, "run-token-1");
}

class FakeDriver implements RestrictedBrowserDriver {
	url = input.targetUrl;
	restrictedDomain: string | null = null;
	redirectTo: string | null = null;
	submitCount = 0;
	submitError: Error | null = null;
	submitValidationError: Error | null = null;
	submitResult: BrowserSubmitResult = {
		outcome: "sent",
		formUrl: input.targetUrl,
	};

	async restrictToDomain(targetDomain: string): Promise<void> {
		this.restrictedDomain = targetDomain;
	}

	async currentUrl(): Promise<string> {
		return this.url;
	}

	async navigate(url: string): Promise<void> {
		this.url = this.redirectTo ?? url;
	}

	async observe() {
		return { url: this.url, forms: [] };
	}

	async clickNonSubmit(): Promise<void> {}

	async fill(): Promise<void> {}

	async select(): Promise<void> {}

	async validateSubmit(): Promise<void> {
		if (this.submitValidationError) {
			throw this.submitValidationError;
		}
	}

	async submit(): Promise<BrowserSubmitResult> {
		this.submitCount += 1;
		if (this.submitError) {
			throw this.submitError;
		}
		return this.submitResult;
	}
}
