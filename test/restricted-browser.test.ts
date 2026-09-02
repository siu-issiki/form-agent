import { describe, expect, test } from "bun:test";
import type { AgentTools } from "../src/agent-runtime";
import { assertAllowedBrowserRequest } from "../src/browser-network-policy";
import { InMemoryJobStore, type JobInput } from "../src/job";
import {
	BrowserElementError,
	BrowserSubmitDiagnosticError,
	type BrowserSubmitResult,
	createBrowserSubmitDiagnosticError,
	detectProhibitedReasonCodes,
	detectProhibitedTextReasonCodes,
	NavigationPolicyError,
	type RestrictedBrowserDriver,
	RestrictedBrowserTools,
	SubmissionEvidenceError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
	type SubmitActivationStrategy,
} from "../src/restricted-browser";
import {
	type EvidenceStage,
	evidenceObjectKey,
	InMemoryEvidenceObjectStore,
	SubmissionEvidenceRecorder,
	sha256Hex,
} from "../src/submission-evidence";

const input: JobInput = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://acme.co.jp/contact",
	targetDomain: "acme.co.jp",
	allowedHosts: [],
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
		driver.navigationLinks = [
			{ url: "https://contact.acme.co.jp/form", text: "Contact" },
		];
		const tools = await createTools(driver);

		await tools.observe();
		await tools.navigate("https://contact.acme.co.jp/form");
		await expect(
			tools.navigate("https://acme.co.jp.evil.test/form"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("rejects an unobserved same-domain navigation target", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);
		await tools.observe();

		await expect(
			tools.navigate("https://acme.co.jp/unobserved-side-effect"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("does not treat another observed hash route as the same navigation", async () => {
		const driver = new FakeDriver();
		driver.navigationLinks = [
			{ url: "https://acme.co.jp/app#/contact", text: "Contact" },
		];
		const tools = await createTools(driver);
		await tools.observe();

		await expect(
			tools.navigate("https://acme.co.jp/app#/delete"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("allows only exact job-specific external hosts", async () => {
		const driver = new FakeDriver();
		driver.navigationLinks = [
			{ url: "https://docs.google.com/forms/example", text: "Form" },
		];
		const externalInput = {
			...input,
			targetUrl: "https://forms.gle/example",
			allowedHosts: ["forms.gle", "docs.google.com"],
		};
		const store = new InMemoryJobStore();
		await store.create(externalInput, "2026-08-28T00:00:00.000Z");
		await store.claimRun(
			externalInput.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			externalInput.id,
			"run-token-1",
			new InMemoryEvidenceObjectStore(),
		);

		await tools.observe();
		await tools.navigate("https://docs.google.com/forms/example");
		await expect(
			tools.navigate("https://drive.google.com/example"),
		).rejects.toBeInstanceOf(NavigationPolicyError);
	});

	test("does not share an external host allowance between jobs", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);

		await expect(
			tools.navigate("https://forms.gle/example"),
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

	test("exposes only allowed navigation links", async () => {
		const driver = new FakeDriver();
		driver.navigationLinks = [
			{ url: "https://acme.co.jp/contact/form", text: "Contact" },
			{ url: "https://evil.test/form", text: "External" },
		];
		const tools = await createTools(driver);

		expect(await tools.observe()).toEqual({
			url: input.targetUrl,
			forms: defaultObservedForms(),
			navigationLinks: [
				{ url: "https://acme.co.jp/contact/form", text: "Contact" },
			],
			prohibitedReasonCodes: [],
		});
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
			new InMemoryEvidenceObjectStore(),
			() => "2026-08-28T00:00:02.000Z",
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const sent = await tools.submit("fa-0-1", "mouse");

		expect(sent.status).toBe("sent");
		expect(driver.submitCount).toBe(1);
		expect(driver.submitActivationStrategies).toEqual(["mouse"]);
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(1);
	});

	test("requires a fresh observation after trusted inputs change", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);
		await tools.observe();
		await tools.fill("fa-0-0", "Hello");

		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			BrowserElementError,
		);
		await tools.observe();
		await expect(tools.validateSubmit("fa-0-1")).resolves.toBeUndefined();
	});

	test("requires a fresh observation after a non-submit click", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await tools.click("fa-0-2");

		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			BrowserElementError,
		);
		await tools.observe();
		await expect(tools.validateSubmit("fa-0-1")).resolves.toBeUndefined();
	});

	test("corroborates prohibited outcomes from the latest observation", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms(
			"このフォームは製品サンプル専用です。営業、提案、勧誘目的での利用は禁止しています。",
		);
		const tools = await createTools(driver);
		await tools.observe();

		await expect(
			tools.validateProhibited("SALES_PROHIBITED", input.targetUrl),
		).resolves.toBeUndefined();
		await expect(
			tools.validateProhibited("NO_FORM_PRESENT", input.targetUrl),
		).rejects.toBeInstanceOf(BrowserElementError);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			BrowserElementError,
		);
	});

	test("requires a fresh observation before accepting a prohibited outcome", async () => {
		const driver = new FakeDriver();
		driver.observationForms = [];
		const tools = await createTools(driver);
		await tools.observe();
		await tools.click("fa-0-2");

		await expect(
			tools.validateProhibited("NO_FORM_PRESENT", input.targetUrl),
		).rejects.toBeInstanceOf(BrowserElementError);
	});

	test("rejects a prohibited outcome after the observed hash route changes", async () => {
		const driver = new FakeDriver();
		driver.observationForms = [];
		driver.url = "https://acme.co.jp/app#/contact";
		const tools = await createToolsForInput(driver, {
			...input,
			targetUrl: driver.url,
		});
		await tools.observe();
		driver.url = "https://acme.co.jp/app#/other";

		await expect(
			tools.validateProhibited("NO_FORM_PRESENT", null),
		).rejects.toBeInstanceOf(BrowserElementError);
	});

	test("applies prohibition only to the selected submit form", async () => {
		const driver = new FakeDriver();
		driver.observationForms = [
			{
				fields: [{ elementId: "fa-0-0" }, { elementId: "fa-0-1" }],
				prohibitionText: "営業目的の利用は禁止です。",
			},
			{
				fields: [{ elementId: "fa-0-3" }, { elementId: "fa-0-4" }],
				prohibitionText: "一般お問い合わせフォーム",
			},
		];
		const tools = await createTools(driver);
		await tools.fill("fa-0-3", "Hello");
		await tools.observe();

		await expect(tools.validateSubmit("fa-0-4")).resolves.toBeUndefined();
		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			BrowserElementError,
		);
	});

	test("detects only mechanically supported prohibition reasons", () => {
		expect(
			detectProhibitedReasonCodes({
				forms: [],
				pageText: "お問い合わせフォームはありません。",
			}),
		).toEqual(["NO_FORM_PRESENT"]);
		expect(
			detectProhibitedReasonCodes({
				forms: [{}],
				pageText: "採用お問い合わせ専用です。営業目的の利用は禁止です。",
			}),
		).toEqual(["SALES_PROHIBITED", "FORM_PURPOSE_INCOMPATIBLE"]);
	});

	test("does not classify explicit sales acceptance or negated prohibition", () => {
		expect(
			detectProhibitedTextReasonCodes("営業のお問い合わせも受け付けています。"),
		).toEqual([]);
		expect(
			detectProhibitedTextReasonCodes("営業目的の利用を禁止していません。"),
		).toEqual([]);
		expect(
			detectProhibitedTextReasonCodes("Sales inquiries are not prohibited."),
		).toEqual([]);
	});

	test("does not prohibit the page when another observed form remains usable", () => {
		expect(
			detectProhibitedReasonCodes({
				forms: [
					{ prohibitedReasonCodes: ["SALES_PROHIBITED"] },
					{ prohibitedReasonCodes: [] },
				],
			}),
		).toEqual([]);
	});

	test("accepts either trusted reason when every observed form is blocked", () => {
		expect(
			detectProhibitedReasonCodes({
				forms: [
					{ prohibitedReasonCodes: ["SALES_PROHIBITED"] },
					{ prohibitedReasonCodes: ["FORM_PURPOSE_INCOMPATIBLE"] },
				],
			}),
		).toEqual(["SALES_PROHIBITED", "FORM_PURPOSE_INCOMPATIBLE"]);
	});

	test("forgets successful inputs after navigation", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await tools.navigate(input.targetUrl);

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			BrowserElementError,
		);
		expect(driver.submitCount).toBe(0);
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
			RestrictedBrowserTools.create(
				driver,
				store,
				input.id,
				"run-token-1",
				new InMemoryEvidenceObjectStore(),
			),
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
			new InMemoryEvidenceObjectStore(),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

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
			new InMemoryEvidenceObjectStore(),
			() => "2026-08-28T00:00:02.000Z",
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SUBMIT_RESULT_UNKNOWN");
		expect(persisted?.result?.reason).toContain(
			"Diagnostic: SUBMIT_OPERATION/UNKNOWN.",
		);
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionNotAuthorizedError,
		);
		expect(driver.submitCount).toBe(1);
	});

	test("persists only allowlisted browser submit diagnostics", async () => {
		const driver = new FakeDriver();
		driver.submitError = createBrowserSubmitDiagnosticError(
			"SUBMIT_CLICK",
			new Error("Browser Use CDP command timed out"),
		);
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const tools = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
			new InMemoryEvidenceObjectStore(),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);

		expect((await store.find(input.id))?.result?.reason).toBe(
			"The browser operation failed after submission permission was granted. Diagnostic: SUBMIT_CLICK/CDP_COMMAND_TIMEOUT.",
		);
	});

	test("does not persist arbitrary browser error details", async () => {
		const diagnostic = createBrowserSubmitDiagnosticError(
			"SUBMIT_CLICK",
			new Error("failed for secret@example.com with entered form body"),
		);

		expect(diagnostic).toBeInstanceOf(BrowserSubmitDiagnosticError);
		expect(diagnostic.diagnosticCode).toBe("UNKNOWN");
		expect(diagnostic.message).not.toContain("secret@example.com");
		expect(diagnostic.message).not.toContain("entered form body");
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
			RestrictedBrowserTools.create(
				driver,
				store,
				input.id,
				"run-token-1",
				new InMemoryEvidenceObjectStore(),
			),
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
			new InMemoryEvidenceObjectStore(),
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
			RestrictedBrowserTools.create(
				driver,
				store,
				input.id,
				"run-token-1",
				new InMemoryEvidenceObjectStore(),
			),
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
				RestrictedBrowserTools.create(
					driver,
					store,
					input.id,
					"run-token-1",
					new InMemoryEvidenceObjectStore(),
				),
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
			new InMemoryEvidenceObjectStore(),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SUBMIT_TARGET_INVALID");
	});

	test("captures evidence before and after a successful submission", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(driver, store, evidence);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const sent = await tools.submit("fa-0-1", "mouse");

		expect(sent.status).toBe("sent");
		expect(store.events.map((event) => [event.type, event.data.stage])).toEqual(
			[
				["evidence.captured", "before_submit"],
				["evidence.captured", "after_submit"],
			],
		);
		expect(evidence.objects.size).toBe(2);
		for (const event of store.events) {
			expect(event.attempt).toBe(1);
			const objectKey = event.data.objectKey as string;
			expect(objectKey).toBe(
				evidenceObjectKey(
					input.id,
					event.data.stage as EvidenceStage,
					event.data.eventId as string,
				),
			);
			const object = evidence.objects.get(objectKey);
			if (!object) throw new Error("Expected a stored evidence object");
			expect(object.contentType).toBe("image/jpeg");
			expect(event.data.byteLength).toBe(object.body.byteLength);
			expect(event.data.sha256).toBe(await sha256Hex(object.body));
		}
	});

	test("does not submit when the evidence before submission fails", async () => {
		const driver = new FakeDriver();
		driver.failScreenshotAt = 1;
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(driver, store, evidence);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionEvidenceError,
		);

		expect((await store.find(input.id))?.status).toBe("running");
		expect(driver.submitCount).toBe(0);
		expect(evidence.objects.size).toBe(0);
		expect(store.events).toEqual([
			{
				jobId: input.id,
				attempt: 1,
				type: "evidence.capture_failed",
				data: { stage: "before_submit", failureCode: "SCREENSHOT_FAILED" },
			},
		]);
	});

	test("keeps the sent result when the evidence after submission fails", async () => {
		const driver = new FakeDriver();
		driver.failScreenshotAt = 2;
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(driver, store, evidence);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const sent = await tools.submit("fa-0-1");

		expect(sent.status).toBe("sent");
		expect(driver.submitCount).toBe(1);
		expect(evidence.objects.size).toBe(1);
		expect(
			store.events.map((event) => [
				event.type,
				event.data.stage,
				event.data.failureCode,
			]),
		).toEqual([
			["evidence.captured", "before_submit", undefined],
			["evidence.capture_failed", "after_submit", "SCREENSHOT_FAILED"],
		]);
	});

	test("keeps the sent result when the after_submit capture failure closes the connection", async () => {
		const driver = new FakeDriver();
		driver.failScreenshotAt = 2;
		driver.closeConnectionOnScreenshotFailure = true;
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(driver, store, evidence);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const sent = await tools.submit("fa-0-1");

		expect(sent.status).toBe("sent");
		expect(driver.submitCount).toBe(1);
		expect(evidence.objects.size).toBe(1);
		expect(
			store.events.map((event) => [
				event.type,
				event.data.stage,
				event.data.failureCode,
			]),
		).toEqual([
			["evidence.captured", "before_submit", undefined],
			["evidence.capture_failed", "after_submit", "SCREENSHOT_FAILED"],
		]);
	});

	test("captures evidence after a browser submit failure", async () => {
		const driver = new FakeDriver();
		driver.submitError = new Error("connection lost");
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(driver, store, evidence);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);

		expect((await store.find(input.id))?.status).toBe("uncertain");
		expect(driver.screenshotCount).toBe(2);
		expect(store.events.map((event) => event.data.stage)).toEqual([
			"before_submit",
			"after_submit",
		]);
		expect(evidence.objects.size).toBe(2);
	});

	test("captures evidence after an uncertain browser submit result", async () => {
		const driver = new FakeDriver();
		driver.submitResult = {
			outcome: "uncertain",
			reasonCode: "SUBMIT_CONFIRMATION_MISSING",
			reason: "The page did not provide a reliable submission confirmation.",
		};
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(driver, store, evidence);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const uncertain = await tools.submit("fa-0-1");

		expect(uncertain.status).toBe("uncertain");
		expect(store.events.map((event) => event.data.stage)).toEqual([
			"before_submit",
			"after_submit",
		]);
		expect(evidence.objects.size).toBe(2);
	});
});

async function createToolsWithEvidence(
	driver: FakeDriver,
	store: InMemoryJobStore,
	evidence: InMemoryEvidenceObjectStore,
): Promise<RestrictedBrowserTools> {
	await store.create(input, "2026-08-28T00:00:00.000Z");
	await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
	return RestrictedBrowserTools.create(
		driver,
		store,
		input.id,
		"run-token-1",
		evidence,
		() => "2026-08-28T00:00:02.000Z",
	);
}

async function createTools(
	driver: FakeDriver,
): Promise<RestrictedBrowserTools> {
	return createToolsForInput(driver, input);
}

async function createToolsForInput(
	driver: FakeDriver,
	jobInput: JobInput,
): Promise<RestrictedBrowserTools> {
	const store = new InMemoryJobStore();
	await store.create(jobInput, "2026-08-28T00:00:00.000Z");
	await store.claimRun(jobInput.id, "run-token-1", "2026-08-28T00:00:01.000Z");
	return RestrictedBrowserTools.create(
		driver,
		store,
		jobInput.id,
		"run-token-1",
		new InMemoryEvidenceObjectStore(),
	);
}

function defaultObservedForms(prohibitionText?: string): unknown[] {
	return [
		{
			fields: [
				{ elementId: "fa-0-0" },
				{ elementId: "fa-0-1" },
				{ elementId: "fa-0-2" },
			],
			...(prohibitionText === undefined ? {} : { prohibitionText }),
		},
	];
}

class FakeDriver implements RestrictedBrowserDriver {
	url = input.targetUrl;
	restrictedDomain: string | null = null;
	redirectTo: string | null = null;
	submitCount = 0;
	submitActivationStrategies: SubmitActivationStrategy[] = [];
	submitError: Error | null = null;
	submitValidationError: Error | null = null;
	screenshotCount = 0;
	failScreenshotAt: number | null = null;
	closeConnectionOnScreenshotFailure = false;
	connectionClosed = false;
	navigationLinks: Array<{ url: string; text: string }> | undefined;
	observationForms: unknown[] = defaultObservedForms();
	pageText: string | undefined;
	submitResult: BrowserSubmitResult = {
		outcome: "sent",
		formUrl: input.targetUrl,
	};

	async restrictToDomain(targetDomain: string): Promise<void> {
		this.restrictedDomain = targetDomain;
	}

	async currentUrl(): Promise<string> {
		if (this.connectionClosed) {
			throw new Error("Browser Use CDP connection is closed");
		}
		return this.url;
	}

	async navigate(url: string): Promise<void> {
		this.url = this.redirectTo ?? url;
	}

	async observe() {
		return {
			url: this.url,
			forms: this.observationForms,
			...(this.pageText ? { pageText: this.pageText } : {}),
			...(this.navigationLinks
				? { navigationLinks: this.navigationLinks }
				: {}),
		};
	}

	async clickNonSubmit(): Promise<void> {}

	async fill(): Promise<void> {}

	async select(): Promise<void> {}

	async captureScreenshot(): Promise<Uint8Array> {
		this.screenshotCount += 1;
		if (this.failScreenshotAt === this.screenshotCount) {
			if (this.closeConnectionOnScreenshotFailure) {
				this.connectionClosed = true;
			}
			throw new Error("Browser screenshot failed");
		}
		return new Uint8Array([this.screenshotCount, 2, 3]);
	}

	async validateSubmit(): Promise<void> {
		if (this.submitValidationError) {
			throw this.submitValidationError;
		}
	}

	async submit(
		_elementId: string,
		activationStrategy: SubmitActivationStrategy,
	): Promise<BrowserSubmitResult> {
		this.submitCount += 1;
		this.submitActivationStrategies.push(activationStrategy);
		if (this.submitError) {
			throw this.submitError;
		}
		return this.submitResult;
	}
}

describe("SubmissionEvidenceRecorder", () => {
	test("deletes the uploaded object when the D1 event cannot be recorded", async () => {
		const driver = new FakeDriver();
		const evidence = new InMemoryEvidenceObjectStore();
		const store = new RecordEvidenceCapturedRejectingJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			evidence,
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
		);

		const result = await recorder.capture("before_submit");

		expect(result).toEqual({
			captured: false,
			failureCode: "EVENT_NOT_RECORDED",
		});
		expect(evidence.objects.size).toBe(0);
		expect(store.events).toEqual([
			{
				jobId: input.id,
				attempt: 1,
				type: "evidence.capture_failed",
				data: { stage: "before_submit", failureCode: "EVENT_NOT_RECORDED" },
			},
		]);
	});

	test("logs the orphan object key when the compensating deletion fails", async () => {
		const driver = new FakeDriver();
		const evidence = new DeleteFailingEvidenceObjectStore();
		const store = new RecordEvidenceCapturedRejectingJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			evidence,
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
		);
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => {
			warnings.push(String(message));
		};

		let result: Awaited<ReturnType<typeof recorder.capture>>;
		try {
			result = await recorder.capture("before_submit");
		} finally {
			console.warn = originalWarn;
		}

		expect(result).toEqual({
			captured: false,
			failureCode: "EVENT_NOT_RECORDED",
		});
		expect(evidence.objects.size).toBe(1);
		const [objectKey] = [...evidence.objects.keys()];
		expect(warnings).toHaveLength(1);
		expect(JSON.parse(warnings[0] ?? "{}")).toEqual({
			event: "submission_evidence_orphan",
			stage: "before_submit",
			objectKey,
		});
		expect(store.events.map((event) => event.type)).toEqual([
			"evidence.capture_failed",
		]);
	});

	test("times out a stalled capture without changing the outcome", async () => {
		const driver: Pick<RestrictedBrowserDriver, "captureScreenshot"> = {
			captureScreenshot: () => new Promise<Uint8Array>(() => {}),
		};
		const evidence = new InMemoryEvidenceObjectStore();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			evidence,
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
			20,
		);
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => {
			warnings.push(String(message));
		};

		let result: Awaited<ReturnType<typeof recorder.capture>>;
		try {
			result = await recorder.capture("after_submit");
		} finally {
			console.warn = originalWarn;
		}

		expect(result).toEqual({
			captured: false,
			failureCode: "CAPTURE_TIMEOUT",
		});
		expect(store.events).toEqual([
			{
				jobId: input.id,
				attempt: 1,
				type: "evidence.capture_failed",
				data: { stage: "after_submit", failureCode: "CAPTURE_TIMEOUT" },
			},
		]);
		expect(
			warnings.some((message) => {
				const parsed = JSON.parse(message) as { event?: string };
				return parsed.event === "submission_evidence_timeout";
			}),
		).toBe(true);
	});

	test("discards a D1 capture result that completes after timeout", async () => {
		const driver = new FakeDriver();
		const evidence = new InMemoryEvidenceObjectStore();
		const store = new DelayedRecordEvidenceJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			evidence,
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
			20,
		);

		const capture = recorder.capture("before_submit");
		await store.recordStarted;
		const result = await capture;
		await store.recordRunAttempt(
			input.id,
			"run-token-1",
			2,
			"2026-08-28T00:00:03.000Z",
		);
		store.releaseRecord();
		await store.recordFinished;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(result).toEqual({
			captured: false,
			failureCode: "CAPTURE_TIMEOUT",
		});
		expect(evidence.objects.size).toBe(0);
		expect(store.events).toEqual([
			{
				jobId: input.id,
				attempt: 1,
				type: "evidence.capture_failed",
				data: { stage: "before_submit", failureCode: "CAPTURE_TIMEOUT" },
			},
		]);
	});
});

class RecordEvidenceCapturedRejectingJobStore extends InMemoryJobStore {
	async recordEvidenceCaptured(): Promise<boolean> {
		return false;
	}
}

class DeleteFailingEvidenceObjectStore extends InMemoryEvidenceObjectStore {
	override async delete(): Promise<void> {
		throw new Error("delete failed");
	}
}

class DelayedRecordEvidenceJobStore extends InMemoryJobStore {
	readonly #recordStarted = deferred<void>();
	readonly #releaseRecord = deferred<void>();
	readonly #recordFinished = deferred<void>();

	get recordStarted(): Promise<void> {
		return this.#recordStarted.promise;
	}

	get recordFinished(): Promise<void> {
		return this.#recordFinished.promise;
	}

	releaseRecord(): void {
		this.#releaseRecord.resolve(undefined);
	}

	override async recordEvidenceCaptured(
		...args: Parameters<InMemoryJobStore["recordEvidenceCaptured"]>
	): Promise<boolean> {
		this.#recordStarted.resolve(undefined);
		await this.#releaseRecord.promise;
		try {
			return await super.recordEvidenceCaptured(...args);
		} finally {
			this.#recordFinished.resolve(undefined);
		}
	}
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
