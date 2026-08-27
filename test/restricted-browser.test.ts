import { describe, expect, test } from "bun:test";
import { InMemoryJobStore, type JobInput } from "../src/job";
import {
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
	targetUrl: "https://example.com/contact",
	targetDomain: "example.com",
	payload: { message: "Hello" },
};

describe("RestrictedBrowserTools", () => {
	test("allows only the target domain and its subdomains", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);

		await tools.navigate("https://contact.example.com/form");
		await expect(
			tools.navigate("https://example.com.evil.test/form"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("rejects a redirect outside the target domain", async () => {
		const driver = new FakeDriver();
		driver.redirectTo = "https://evil.test/collect";
		const tools = await createTools(driver);

		await expect(
			tools.navigate("https://example.com/contact"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("submits once only after acquiring D1-compatible permission", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = new RestrictedBrowserTools(
			driver,
			store,
			input.id,
			"run-token-1",
			input.targetDomain,
			() => "2026-08-28T00:00:02.000Z",
		);

		const sent = await tools.submit();

		expect(sent.status).toBe("sent");
		expect(driver.submitCount).toBe(1);
		await expect(tools.submit()).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(1);
	});

	test("does not touch the browser when submission permission is missing", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const tools = new RestrictedBrowserTools(
			driver,
			store,
			input.id,
			"run-token-1",
			input.targetDomain,
		);

		await expect(tools.submit()).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(0);
	});

	test("marks an unknown browser result uncertain and never retries", async () => {
		const driver = new FakeDriver();
		driver.submitError = new Error("connection lost");
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = new RestrictedBrowserTools(
			driver,
			store,
			input.id,
			"run-token-1",
			input.targetDomain,
			() => "2026-08-28T00:00:02.000Z",
		);

		await expect(tools.submit()).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SUBMIT_RESULT_UNKNOWN");
		await expect(tools.submit()).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(1);
	});
});

async function createTools(
	driver: FakeDriver,
): Promise<RestrictedBrowserTools> {
	const store = new InMemoryJobStore();
	await store.create(input, "2026-08-28T00:00:00.000Z");
	return new RestrictedBrowserTools(
		driver,
		store,
		input.id,
		"run-token-1",
		input.targetDomain,
	);
}

class FakeDriver implements RestrictedBrowserDriver {
	url = input.targetUrl;
	redirectTo: string | null = null;
	submitCount = 0;
	submitError: Error | null = null;
	submitResult: BrowserSubmitResult = {
		outcome: "sent",
		formUrl: input.targetUrl,
	};

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

	async submit(): Promise<BrowserSubmitResult> {
		this.submitCount += 1;
		if (this.submitError) {
			throw this.submitError;
		}
		return this.submitResult;
	}
}
