import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { BrowserUseCdpDriver } from "../src/browser-use-cdp-driver";
import { InMemoryJobStore, type Job } from "../src/job";
import {
	NavigationPolicyError,
	RestrictedBrowserTools,
} from "../src/restricted-browser";

const targetUrl = "https://www.selenium.dev/selenium/web/web-form.html";
const job: Job = {
	id: "browser-use-smoke",
	companyId: "browser-use-smoke",
	companyName: "BrowserUse smoke fixture",
	targetUrl,
	targetDomain: "selenium.dev",
	payload: {},
	status: "running",
	attemptCount: 1,
	runToken: "browser-use-smoke",
	result: null,
	createdAt: "2026-08-28T00:00:00.000Z",
	updatedAt: "2026-08-28T00:00:00.000Z",
};

interface ObservedField {
	elementId: string;
	name: string | null;
	type: string | null;
	value: string;
}

interface ObservedForm {
	fields: ObservedField[];
}

describe("BrowserUseCdpDriver real CDP smoke", () => {
	test("observes and fills a form without submitting", async () => {
		const apiKey = (env as { BROWSER_USE_API_KEY?: string })
			.BROWSER_USE_API_KEY;
		if (!apiKey) {
			throw new Error("BROWSER_USE_API_KEY is required for this opt-in test");
		}

		const driver = await BrowserUseCdpDriver.connect(apiKey, job);
		try {
			const store = new InMemoryJobStore();
			await store.create(job, job.createdAt);
			await store.claimRun(job.id, job.runToken ?? "", job.updatedAt);
			const tools = await RestrictedBrowserTools.create(
				driver,
				store,
				job.id,
				job.runToken ?? "",
			);
			await tools.navigate(targetUrl);

			const observation = await tools.observe();
			const forms = observation.forms as ObservedForm[];
			const nameField = forms
				.flatMap((form) => form.fields)
				.find((field) => field.name === "my-text");
			const submitControl = forms
				.flatMap((form) => form.fields)
				.find((field) => field.type === "submit");

			expect(observation.url).toBe(targetUrl);
			expect(nameField).toBeDefined();
			expect(submitControl).toBeDefined();
			if (!nameField || !submitControl) {
				throw new Error("Expected smoke form controls were not observed");
			}

			await tools.fill(nameField.elementId, "Form Agent Smoke Test");
			const filled = (await tools.observe()).forms as ObservedForm[];
			expect(
				filled
					.flatMap((form) => form.fields)
					.find((field) => field.name === "my-text")?.value,
			).toBe("Form Agent Smoke Test");

			await expect(tools.click(submitControl.elementId)).rejects.toThrow(
				"The browser element is unavailable or incompatible",
			);
			await expect(
				tools.navigate("https://example.com"),
			).rejects.toBeInstanceOf(NavigationPolicyError);
			await expect(driver.navigate("https://example.com")).rejects.toThrow(
				"Browser navigation failed",
			);
		} finally {
			await driver.close();
		}
	});
});
