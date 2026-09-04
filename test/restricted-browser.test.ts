import { describe, expect, test } from "bun:test";
import type { AgentTools } from "../src/agent-runtime";
import {
	assertAllowedBrowserRequest,
	isVerificationProviderRequest,
	isVerificationProviderUrl,
	VERIFICATION_PROVIDER_ALLOWLIST,
} from "../src/browser-network-policy";
import { InMemoryJobStore, type JobInput } from "../src/job";
import {
	BrowserElementError,
	BrowserSubmitDiagnosticError,
	type BrowserSubmitResult,
	CorrectionRequiredError,
	createBrowserSubmitDiagnosticError,
	detectProhibitedReasonCodes,
	detectProhibitedTextReasonCodes,
	FormStateChangedError,
	NavigationPolicyError,
	ObservationStaleError,
	type ObservedFieldState,
	observationFingerprint,
	type ProhibitedReasonCode,
	ProhibitionEvidenceError,
	type RestrictedBrowserDriver,
	RestrictedBrowserTools,
	readTrustedFormValues,
	SubmissionEvidenceError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
	type SubmitActivationStrategy,
	SubmitProhibitedError,
	type SubmitReviewDecision,
	SubmitReviewDeniedError,
	type SubmitReviewer,
	type SubmitReviewInput,
	type SubmitReviewReasonCode,
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
	test("allows the fixed verification provider hosts on every job", () => {
		for (const [url, method] of [
			["https://www.google.com/recaptcha/api.js?render=key", "GET"],
			["https://www.google.com/recaptcha/api2/reload?k=key", "POST"],
			[
				"https://www.gstatic.com/recaptcha/releases/abc/recaptcha__ja.js",
				"GET",
			],
			["https://recaptcha.net/recaptcha/api.js", "GET"],
			["https://www.recaptcha.net/recaptcha/api2/reload", "POST"],
			["https://hcaptcha.com/1/api.js", "GET"],
			["https://sub.hcaptcha.com/x", "GET"],
			["https://challenges.cloudflare.com/turnstile/v0/api.js", "GET"],
		] as const) {
			expect(
				assertAllowedBrowserRequest(url, "form-agent.dev", method, false),
			).toBe(true);
		}
	});

	test("rejects lookalike hosts, other paths and non-https verification URLs", () => {
		for (const [url, method] of [
			["https://www.google.com/search?q=form", "GET"],
			["https://www.gstatic.com/other/script.js", "GET"],
			["http://www.google.com/recaptcha/api.js", "GET"],
			["https://hcaptcha.com.evil.example/1/api.js", "GET"],
			["https://www.google.com.evil.example/recaptcha/api.js", "GET"],
			["https://google.com/recaptcha/api.js", "GET"],
			["https://www.google.com/recaptcha/api2/reload", "PUT"],
			["https://user:pass@www.google.com/recaptcha/api.js", "GET"],
		] as const) {
			expect(isVerificationProviderRequest(url, method)).toBe(false);
			expect(() =>
				assertAllowedBrowserRequest(
					url,
					"form-agent.dev",
					method,
					false,
					false,
					true,
				),
			).toThrow(NavigationPolicyError);
		}
	});

	test("keeps verification provider requests allowed after a dry-run interaction", () => {
		expect(
			assertAllowedBrowserRequest(
				"https://www.google.com/recaptcha/api2/reload?k=key",
				"form-agent.dev",
				"POST",
				false,
				false,
				true,
			),
		).toBe(true);
		expect(() =>
			assertAllowedBrowserRequest(
				"https://cdn.jsdelivr.net/form.js",
				"form-agent.dev",
				"GET",
				false,
				false,
				true,
			),
		).toThrow(NavigationPolicyError);
	});

	test("never lets a verification provider host become a navigation", () => {
		expect(
			isVerificationProviderRequest(
				"https://www.google.com/recaptcha/api.js",
				"GET",
				"Document",
			),
		).toBe(false);
		expect(() =>
			assertAllowedBrowserRequest(
				"https://www.google.com/recaptcha/api.js",
				"form-agent.dev",
				"GET",
				false,
				false,
				false,
				[],
				"Document",
			),
		).toThrow(NavigationPolicyError);
	});

	test("allows the widget iframe document only below the top frame", () => {
		const anchor = "https://www.google.com/recaptcha/api2/anchor?k=key";
		expect(isVerificationProviderRequest(anchor, "GET", "Document", true)).toBe(
			true,
		);
		expect(isVerificationProviderRequest(anchor, "GET", "Document")).toBe(
			false,
		);
		expect(
			assertAllowedBrowserRequest(
				anchor,
				"form-agent.dev",
				"GET",
				false,
				false,
				true,
				[],
				"Document",
				true,
			),
		).toBe(true);
		expect(() =>
			assertAllowedBrowserRequest(
				anchor,
				"form-agent.dev",
				"GET",
				false,
				false,
				true,
				[],
				"Document",
				false,
			),
		).toThrow(NavigationPolicyError);
	});

	test("keeps a subframe document on other hosts blocked", () => {
		for (const url of [
			"https://evil.example/frame",
			"https://www.google.com.evil.example/recaptcha/api2/anchor",
			"https://www.google.com/search?q=form",
		]) {
			expect(isVerificationProviderRequest(url, "GET", "Document", true)).toBe(
				false,
			);
			expect(() =>
				assertAllowedBrowserRequest(
					url,
					"form-agent.dev",
					"GET",
					false,
					false,
					true,
					[],
					"Document",
					true,
				),
			).toThrow(NavigationPolicyError);
		}
	});

	test("matches a verification provider URL by host, scheme and path only", () => {
		for (const url of [
			"https://www.google.com/recaptcha/api2/anchor?k=key",
			"https://www.gstatic.com/recaptcha/releases/abc/recaptcha__ja.js",
			"https://newassets.hcaptcha.com/captcha/v1/frame",
			"https://challenges.cloudflare.com/turnstile/v0/api.js",
		]) {
			expect(isVerificationProviderUrl(url)).toBe(true);
		}
		for (const url of [
			"http://www.google.com/recaptcha/api2/anchor",
			"https://www.google.com/search",
			"https://google.com/recaptcha/api2/anchor",
			"https://www.google.com.evil.example/recaptcha/api2/anchor",
			"https://hcaptcha.com.evil.example/captcha/v1/frame",
			"https://user:pass@www.google.com/recaptcha/api2/anchor",
			"about:blank",
			"",
		]) {
			expect(isVerificationProviderUrl(url)).toBe(false);
		}
	});

	test("keeps verification provider requests outside the submission claim", () => {
		// The submission claim is never spent on these hosts: they pass without
		// any submission authorization, so the one-shot permission stays unused.
		expect(
			assertAllowedBrowserRequest(
				"https://www.google.com/recaptcha/api2/reload",
				"form-agent.dev",
				"POST",
				false,
			),
		).toBe(true);
		expect(
			assertAllowedBrowserRequest(
				"https://form-agent.dev/contact",
				"form-agent.dev",
				"POST",
				true,
			),
		).toBe(false);
	});

	test("pins the verification provider allowlist to known hosts", () => {
		expect(VERIFICATION_PROVIDER_ALLOWLIST).toEqual([
			{ host: "www.google.com", pathPrefix: "/recaptcha/" },
			{ host: "www.gstatic.com", pathPrefix: "/recaptcha/" },
			{ host: "recaptcha.net", pathPrefix: "/recaptcha/" },
			{ host: "www.recaptcha.net", pathPrefix: "/recaptcha/" },
			{ host: "hcaptcha.com", allowSubdomains: true },
			{ host: "challenges.cloudflare.com" },
		]);
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

	test("treats an exact duplicate current navigation as a no-op", async () => {
		const driver = new FakeDriver();
		const tools = await createTools(driver);

		await tools.navigate(input.targetUrl);
		await tools.navigate(input.targetUrl);

		expect(driver.navigationCount).toBe(1);
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
			allowSubmitReviewer(),
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
			allowSubmitReviewer(),
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
		).resolves.toBe("REASON_CODES");
		await expect(
			tools.validateProhibited("NO_FORM_PRESENT", input.targetUrl),
		).rejects.toBeInstanceOf(BrowserElementError);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		const prohibited = await tools
			.validateSubmit("fa-0-1")
			.catch((error: unknown) => error);
		expect(prohibited).toBeInstanceOf(SubmitProhibitedError);
		expect((prohibited as SubmitProhibitedError).reasonCodes).toEqual([
			"SALES_PROHIBITED",
			"FORM_PURPOSE_INCOMPATIBLE",
		]);
		expect((prohibited as SubmitProhibitedError).pageProhibited).toBe(true);
	});

	test("detects a prohibition split across adjacent context segments", async () => {
		const driver = new FakeDriver();
		driver.observationForms = [
			{
				fields: [{ elementId: "fa-0-0" }, { elementId: "fa-0-1" }],
				prohibitionTexts: ["営業目的での利用は", "禁止しています"],
			},
		];
		const tools = await createTools(driver);
		await tools.observe();

		await expect(
			tools.validateProhibited("SALES_PROHIBITED", input.targetUrl),
		).resolves.toBe("REASON_CODES");
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

	test("re-observes once when the current observation shows no prohibition", async () => {
		const driver = new FakeDriver();
		driver.observationFormsSequence = [
			defaultObservedForms("一般お問い合わせフォーム"),
			defaultObservedForms("営業目的での利用は禁止しています。"),
		];
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		try {
			await expect(
				tools.validateProhibited("SALES_PROHIBITED", input.targetUrl),
			).resolves.toBe("REASON_CODES");
		} finally {
			logs.restore();
		}

		expect(driver.observeCount).toBe(2);
		expect(logs.entries).toEqual([
			{ event: "prohibition_reverified", verified: true },
		]);
	});

	test("re-observes at most once for each input revision", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		try {
			await expect(
				tools.validateProhibited("SALES_PROHIBITED", input.targetUrl),
			).rejects.toBeInstanceOf(BrowserElementError);
			expect(driver.observeCount).toBe(2);
			await expect(
				tools.validateProhibited("SALES_PROHIBITED", input.targetUrl),
			).rejects.toBeInstanceOf(BrowserElementError);
		} finally {
			logs.restore();
		}

		expect(driver.observeCount).toBe(2);
		expect(logs.entries).toEqual([
			{ event: "prohibition_reverified", verified: false },
		]);
	});

	test("does not re-observe for a stale observation", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		const tools = await createTools(driver);
		await tools.observe();
		await tools.click("fa-0-2");

		await expect(
			tools.validateProhibited("SALES_PROHIBITED", input.targetUrl),
		).rejects.toBeInstanceOf(BrowserElementError);
		expect(driver.observeCount).toBe(1);
	});

	test("accepts a prohibition sentence quoted verbatim from the page", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		// A refusal the fixed patterns do not recognise, stated plainly.
		driver.pageText =
			"お問い合わせ窓口。恐れ入りますが、営業のご連絡につきましては対応しておりません。";
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		try {
			await expect(
				tools.validateProhibited(
					"SALES_PROHIBITED",
					input.targetUrl,
					"営業のご連絡につきましては対応しておりません。",
				),
			).resolves.toBe("PROHIBITION_EVIDENCE_VERIFIED");
		} finally {
			logs.restore();
		}

		// Accepted without a re-observation, and the quote never reaches the log.
		expect(driver.observeCount).toBe(1);
		expect(logs.entries).toEqual([
			{
				event: "browser_prohibition_evidence",
				outcome: "PROHIBITION_EVIDENCE_VERIFIED",
			},
		]);
	});

	test("rejects a prohibition sentence the page does not contain", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		driver.pageText = "お問い合わせ窓口。お気軽にご連絡ください。";
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		let rejected: unknown;
		try {
			rejected = await tools
				.validateProhibited(
					"SALES_PROHIBITED",
					input.targetUrl,
					"営業目的のご連絡は固くお断りいたします。",
				)
				.catch((error: unknown) => error);
		} finally {
			logs.restore();
		}

		expect(rejected).toBeInstanceOf(ProhibitionEvidenceError);
		expect((rejected as ProhibitionEvidenceError).code).toBe(
			"PROHIBITION_EVIDENCE_NOT_FOUND",
		);
		expect(logs.entries).toContainEqual({
			event: "browser_prohibition_evidence",
			outcome: "PROHIBITION_EVIDENCE_NOT_FOUND",
		});
	});

	test("rejects a quoted sentence that states no refusal", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		driver.pageText = "会社案内。営業部の紹介はこちらをご覧ください。";
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		let rejected: unknown;
		try {
			rejected = await tools
				.validateProhibited(
					"SALES_PROHIBITED",
					input.targetUrl,
					"営業部の紹介はこちらをご覧ください。",
				)
				.catch((error: unknown) => error);
		} finally {
			logs.restore();
		}

		expect(rejected).toBeInstanceOf(ProhibitionEvidenceError);
		expect((rejected as ProhibitionEvidenceError).code).toBe(
			"PROHIBITION_EVIDENCE_WEAK",
		);
		expect(logs.entries).toContainEqual({
			event: "browser_prohibition_evidence",
			outcome: "PROHIBITION_EVIDENCE_WEAK",
		});
	});

	test("refuses a quoted sentence that accepts rather than refuses", async () => {
		const cases: Array<[ProhibitedReasonCode, string]> = [
			["SALES_PROHIBITED", "当社では営業のご提案も受け付けております。"],
			["SALES_PROHIBITED", "営業のご提案には対応いたします。"],
			[
				"FORM_PURPOSE_INCOMPATIBLE",
				"採用に関するお問い合わせも受け付けております。",
			],
			[
				"FORM_PURPOSE_INCOMPATIBLE",
				"採用以外のお問い合わせも受け付けています。",
			],
		];
		for (const [reasonCode, sentence] of cases) {
			const driver = new FakeDriver();
			driver.observationForms = defaultObservedForms(
				"一般お問い合わせフォーム",
			);
			driver.pageText = `お問い合わせ窓口。${sentence}`;
			const tools = await createTools(driver);
			await tools.observe();
			const logs = captureLogs();

			let rejected: unknown;
			try {
				rejected = await tools
					.validateProhibited(reasonCode, input.targetUrl, sentence)
					.catch((error: unknown) => error);
			} finally {
				logs.restore();
			}

			expect(rejected).toBeInstanceOf(ProhibitionEvidenceError);
			expect((rejected as ProhibitionEvidenceError).code).toBe(
				"PROHIBITION_EVIDENCE_WEAK",
			);
		}
	});

	test("accepts a quoted refusal phrased as かねます or 対象外", async () => {
		const cases: Array<[ProhibitedReasonCode, string]> = [
			// Too far apart for the fixed patterns, which bound the distance
			// between the subject and the refusal.
			[
				"SALES_PROHIBITED",
				"営業のご連絡につきましては、担当部署の体制および対応方針の都合により、誠に恐縮ながら対応しかねます。",
			],
			["FORM_PURPOSE_INCOMPATIBLE", "採用以外のお問い合わせは対象外です。"],
		];
		for (const [reasonCode, sentence] of cases) {
			const driver = new FakeDriver();
			driver.observationForms = defaultObservedForms(
				"一般お問い合わせフォーム",
			);
			driver.pageText = `お問い合わせ窓口。${sentence}`;
			const tools = await createTools(driver);
			await tools.observe();
			const logs = captureLogs();

			try {
				await expect(
					tools.validateProhibited(reasonCode, input.targetUrl, sentence),
				).resolves.toBe("PROHIBITION_EVIDENCE_VERIFIED");
			} finally {
				logs.restore();
			}
		}
	});

	test("matches a quote across full-width spaces and line breaks", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		driver.pageText =
			"ご案内\n　営業のご連絡につきましては\n対応しておりません。　ご了承ください。";
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		try {
			await expect(
				tools.validateProhibited(
					"SALES_PROHIBITED",
					input.targetUrl,
					"営業のご連絡につきましては 対応しておりません。",
				),
			).resolves.toBe("PROHIBITION_EVIDENCE_VERIFIED");
		} finally {
			logs.restore();
		}
	});

	test("re-observes once when a truncated page text lacks the quote", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		driver.pageText = "お問い合わせ窓口のご案内。";
		const tools = await createTools(driver);
		await tools.observe();
		driver.pageText =
			"お問い合わせ窓口のご案内。営業のご連絡につきましては対応しておりません。";
		const logs = captureLogs();

		try {
			await expect(
				tools.validateProhibited(
					"SALES_PROHIBITED",
					input.targetUrl,
					"営業のご連絡につきましては対応しておりません。",
				),
			).resolves.toBe("PROHIBITION_EVIDENCE_VERIFIED");
		} finally {
			logs.restore();
		}

		expect(driver.observeCount).toBe(2);
	});

	test("never accepts a quote for a missing form", async () => {
		const driver = new FakeDriver();
		driver.observationForms = defaultObservedForms("一般お問い合わせフォーム");
		driver.pageText = "お問い合わせフォームは設置しておりません。";
		const tools = await createTools(driver);
		await tools.observe();
		const logs = captureLogs();

		try {
			await expect(
				tools.validateProhibited(
					"NO_FORM_PRESENT",
					input.targetUrl,
					"お問い合わせフォームは設置しておりません。",
				),
			).rejects.toBeInstanceOf(BrowserElementError);
		} finally {
			logs.restore();
		}

		expect(logs.entries).not.toContainEqual(
			expect.objectContaining({ event: "browser_prohibition_evidence" }),
		);
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
		const prohibited = await tools
			.validateSubmit("fa-0-1")
			.catch((error: unknown) => error);
		expect(prohibited).toBeInstanceOf(SubmitProhibitedError);
		expect((prohibited as SubmitProhibitedError).reasonCodes).toEqual([
			"SALES_PROHIBITED",
		]);
		// The page-level detection needs every form to carry a code, so
		// `finish_prohibited` would be rejected for this page.
		expect((prohibited as SubmitProhibitedError).pageProhibited).toBe(false);
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

	test("detects softened and emphatic sales refusals", () => {
		for (const text of [
			"営業を目的としたお問い合わせはご遠慮ください。",
			"大変恐縮ですが営業目的のメールはお控えください。",
			"営業・売り込み・勧誘目的でのご連絡は一切お断りいたします。",
			"お問い合わせフォームからの営業メールやご提案に関するメールはご遠慮ください。",
			"このフォームはお客様専用となります。営業メールはご遠慮ください。",
			"営業支援サービスのご案内はお断りしております。",
			"営業部からのご提案はお断りしております。",
			"営業担当者からのご案内はお断りしております。",
			"営業目的のお問い合わせには対応しかねます。",
		]) {
			expect(detectProhibitedTextReasonCodes(text)).toContain(
				"SALES_PROHIBITED",
			);
		}
	});

	test("does not read ordinary business vocabulary as a sales prohibition", () => {
		for (const text of [
			"営業時間外のお電話はお断りしております。",
			"営業日以外は対応しておりません。",
			"自営業の方はご応募をご遠慮ください。",
			"営業利益に関するお問い合わせはご遠慮ください。",
		]) {
			expect(detectProhibitedTextReasonCodes(text)).toEqual([]);
		}
	});

	test("reads 対象外 as a purpose restriction", () => {
		expect(
			detectProhibitedTextReasonCodes("採用以外のお問い合わせは対象外です。"),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
	});

	test("takes a sales prohibition from the page text outside every form", () => {
		expect(
			detectProhibitedReasonCodes({
				forms: [{ prohibitedReasonCodes: [] }, { prohibitedReasonCodes: [] }],
				pageText:
					"お問い合わせ窓口のご案内。営業目的のメールはお控えください。",
			}),
		).toEqual(["SALES_PROHIBITED"]);
	});

	test("keeps a form-only purpose restriction out of the page text detection", () => {
		expect(
			detectProhibitedReasonCodes({
				forms: [{ prohibitedReasonCodes: ["FORM_PURPOSE_INCOMPATIBLE"] }],
				pageText: "一般のお問い合わせはこちらのフォームからお願いします。",
			}),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
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
				allowSubmitReviewer(),
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
			allowSubmitReviewer(),
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
			allowSubmitReviewer(),
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
			allowSubmitReviewer(),
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

	test("applies the first candidate the control offers", async () => {
		const driver = new FakeDriver();
		driver.selectOptions = { "fa-0-2": ["other"] };
		const tools = await createTools(driver);
		await tools.observe();

		await tools.select("fa-0-2", ["その他のお問い合わせ", "other"]);

		expect(driver.fieldStates[1]?.value).toBe("other");
	});

	test("rejects a select whose candidates the control does not offer", async () => {
		const driver = new FakeDriver();
		driver.selectOptions = { "fa-0-2": ["other"] };
		const tools = await createTools(driver);
		await tools.observe();

		await expect(
			tools.select("fa-0-2", ["その他のお問い合わせ"]),
		).rejects.toBeInstanceOf(BrowserElementError);
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
				allowSubmitReviewer(),
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
			allowSubmitReviewer(),
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
				allowSubmitReviewer(),
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
					allowSubmitReviewer(),
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
			allowSubmitReviewer(),
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

	test("submits only after the independent pre-submit review allows it", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const sent = await tools.submit("fa-0-1");

		expect(sent.status).toBe("sent");
		expect(reviewer.reviewCount).toBe(1);
		expect(driver.submitCount).toBe(1);
	});

	test("passes the observation, trusted values, and screenshot to the reviewer", async () => {
		const driver = new FakeDriver();
		const reviewer = new StubSubmitReviewer();
		const jobInput: JobInput = {
			...input,
			id: "job-review-input",
			payload: {
				formValues: { message: "Hello", empty: "", nested: { a: 1 } },
				instruction: "Do not enter this control value",
			},
		};
		const tools = await createToolsForInput(driver, jobInput, reviewer);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await tools.submit("fa-0-1");

		const reviewInput = reviewer.inputs[0];
		expect(reviewInput?.formValues).toEqual({ message: "Hello" });
		expect(reviewInput?.submitElementId).toBe("fa-0-1");
		expect(reviewInput?.targetDomain).toBe(input.targetDomain);
		expect(reviewInput?.targetUrl).toBe(input.targetUrl);
		expect(reviewInput?.currentUrl).toBe(input.targetUrl);
		expect(reviewInput?.observation.forms).toEqual([
			{
				fields: [
					{ elementId: "fa-0-0", tag: "input", type: "text", value: "Hello" },
					{ elementId: "fa-0-1", tag: "input", type: "submit", value: "Send" },
					{ elementId: "fa-0-2", tag: "input", type: "text", value: "" },
				],
			},
		]);
		expect(reviewInput?.screenshot?.contentType).toBe("image/jpeg");
		expect(reviewInput?.screenshot?.bytes).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("allows exactly one correction after the review denies the submission", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer(denyDecision());
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const denied = await tools.submit("fa-0-1").catch((error) => error);

		expect(denied).toBeInstanceOf(SubmitReviewDeniedError);
		expect(denied.reasonCode).toBe("INPUT_MISMATCH");
		expect(driver.submitCount).toBe(0);
		expect((await store.find(input.id))?.status).toBe("running");
		expect(store.events.map((event) => event.data.stage)).toEqual([
			"before_submit",
		]);
		// Re-observing alone does not clear the denial; a value must change.
		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			CorrectionRequiredError,
		);
		await tools.observe();
		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			CorrectionRequiredError,
		);

		// The change only counts once a fresh observation shows it.
		await tools.fill("fa-0-2", "Corrected");
		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			CorrectionRequiredError,
		);
		await tools.observe();
		const sent = await tools.submit("fa-0-1");

		expect(sent.status).toBe("sent");
		expect(reviewer.reviewCount).toBe(2);
		expect(driver.submitCount).toBe(1);
	});

	test("rejects a correction that re-enters the same values", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer(denyDecision());
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmitReviewDeniedError,
		);

		// Re-entering the same value leaves the reviewed content identical.
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			CorrectionRequiredError,
		);

		expect(reviewer.reviewCount).toBe(1);
		expect(driver.submitCount).toBe(0);
		expect((await store.find(input.id))?.status).toBe("running");
	});

	test("does not submit when the form changed outside the observed fields", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		// The page adds a hidden input while the review is running.
		driver.formSnapshots = ['["form"]', '["form","hidden"]'];
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			new StubSubmitReviewer(),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			FormStateChangedError,
		);

		expect(driver.formSnapshotCount).toBe(2);
		expect(driver.submitCount).toBe(0);
		expect((await store.find(input.id))?.status).toBe("running");
	});

	test("does not offer a correction for a denial the agent cannot fix", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer(
			denyDecision("SALES_PROHIBITED", "Sales outreach is prohibited."),
		);
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);

		const job = await store.find(input.id);
		expect(job?.status).toBe("uncertain");
		expect(job?.result?.reasonCode).toBe("PRE_SUBMIT_REVIEW_DENIED");
		expect(job?.result?.reason).toBe(
			"Pre-submit review denied the submission (reasonCode: SALES_PROHIBITED, denials: 1). Sales outreach is prohibited.",
		);
		// A denial with no correction on offer spends the whole budget.
		expect(job?.submitReviewDenialCount).toBe(2);
		expect(driver.submitCount).toBe(0);
	});

	test("does not submit content that changed after the review", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		// The untrusted page rewrites a reviewed value while the review runs.
		driver.fieldStates = [
			{ elementId: "fa-0-0", value: "attacker", checked: false },
			{ elementId: "fa-0-2", value: "", checked: false },
		];

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			FormStateChangedError,
		);

		expect(driver.submitCount).toBe(0);
		expect((await store.find(input.id))?.status).toBe("running");
		await expect(tools.validateSubmit("fa-0-1")).rejects.toBeInstanceOf(
			ObservationStaleError,
		);
	});

	test("does not submit when a reviewed field disappeared", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			new StubSubmitReviewer(),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		driver.fieldStates = [{ elementId: "fa-0-0", value: "", checked: false }];

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			FormStateChangedError,
		);

		expect(driver.submitCount).toBe(0);
	});

	test("does not submit when the page navigated after the review", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			new StubSubmitReviewer(),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		driver.url = "https://acme.co.jp/other";

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			FormStateChangedError,
		);

		expect(driver.submitCount).toBe(0);
	});

	test("does not submit after the persisted denial budget is spent", async () => {
		const driver = new FakeDriver();
		const store = new UncertainOnceFailingJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			new StubSubmitReviewer(
				denyDecision("WRONG_FORM", "The submit control belongs elsewhere."),
			),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);
		// The uncertain write failed, so the job is still running.
		expect((await store.find(input.id))?.status).toBe("running");

		// A later review that allows must not revive the spent job.
		const revived = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			new StubSubmitReviewer(),
			true,
		);
		await revived.fill("fa-0-0", "Hello");
		await revived.observe();

		await expect(revived.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);

		expect(driver.submitCount).toBe(0);
		expect((await store.find(input.id))?.status).toBe("uncertain");
	});

	test("ends the job as uncertain when the review denies twice", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer(
			denyDecision(),
			denyDecision("INPUT_MISMATCH", "Still\nwrong."),
		);
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmitReviewDeniedError,
		);
		await tools.fill("fa-0-2", "Corrected");
		await tools.observe();

		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);

		const job = await store.find(input.id);
		expect(job?.status).toBe("uncertain");
		expect(job?.result?.reasonCode).toBe("PRE_SUBMIT_REVIEW_DENIED");
		expect(job?.result?.reason).toBe(
			"Pre-submit review denied the submission (reasonCode: INPUT_MISMATCH, denials: 2). Still wrong.",
		);
		expect(driver.submitCount).toBe(0);
	});

	test("keeps the denial budget across a new browser session", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			new StubSubmitReviewer(denyDecision()),
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();
		await expect(tools.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmitReviewDeniedError,
		);

		// A Queue redelivery builds a fresh instance for the same job.
		const redelivered = await RestrictedBrowserTools.create(
			driver,
			store,
			input.id,
			"run-token-1",
			evidence,
			new StubSubmitReviewer(denyDecision("WRONG_FORM", "Another form.")),
			() => "2026-08-28T00:00:03.000Z",
		);
		await redelivered.fill("fa-0-0", "Hello");
		await redelivered.observe();

		await expect(redelivered.submit("fa-0-1")).rejects.toBeInstanceOf(
			SubmissionResultUncertainError,
		);

		const job = await store.find(input.id);
		expect(job?.status).toBe("uncertain");
		expect(job?.result?.reasonCode).toBe("PRE_SUBMIT_REVIEW_DENIED");
		expect(job?.submitReviewDenialCount).toBe(2);
		expect(driver.submitCount).toBe(0);
	});

	test("does not submit when the reviewer itself fails", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer();
		reviewer.error = new Error("reviewer transport failure");
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const failure = await tools.submit("fa-0-1").catch((error) => error);

		expect(failure).toBe(reviewer.error);
		expect(driver.submitCount).toBe(0);
		expect((await store.find(input.id))?.status).toBe("running");
		expect(store.events.map((event) => event.data.stage)).toEqual([
			"before_submit",
		]);
	});
});

describe("dry-run evidence", () => {
	test("reviews the captured screen and keeps those exact bytes as evidence", async () => {
		const driver = new FakeDriver();
		driver.observationForms = [
			{
				fields: [
					{
						elementId: "fa-0-0",
						tag: "input",
						type: "text",
						name: "message",
						label: "お問い合わせ内容",
						required: true,
						value: "",
					},
					{ elementId: "fa-0-1", tag: "input", type: "submit", value: "Send" },
					{
						elementId: "fa-0-2",
						tag: "input",
						type: "password",
						name: "pass",
						value: "s3cret",
					},
					{
						elementId: "fa-0-3",
						tag: "input",
						type: "checkbox",
						name: "agree",
						value: "on",
						checked: true,
					},
				],
			},
		];
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const logs = captureConsole();
		let decision: SubmitReviewDecision;
		try {
			decision = await tools.reviewDryRunSubmit("fa-0-1");
			await tools.captureDryRunFieldMap(decision);
		} finally {
			logs.restore();
		}

		expect(decision.decision).toBe("allow");
		expect(store.events.map((event) => [event.type, event.data.stage])).toEqual(
			[
				["evidence.captured", "dry_run_before_submit"],
				["evidence.captured", "dry_run_field_map"],
			],
		);
		const screenshotKey = store.events[0]?.data.objectKey as string;
		const fieldMapKey = store.events[1]?.data.objectKey as string;
		expect(screenshotKey).toBe(
			evidenceObjectKey(
				input.id,
				"dry_run_before_submit",
				store.events[0]?.data.eventId as string,
			),
		);
		expect(fieldMapKey).toBe(
			evidenceObjectKey(
				input.id,
				"dry_run_field_map",
				store.events[1]?.data.eventId as string,
				"application/json",
			),
		);
		expect(fieldMapKey.endsWith(".json")).toBe(true);
		expect(store.events[1]?.data.contentType).toBe("application/json");

		// The evidence must be the image the review judged, not a re-capture of
		// a page that may have moved since.
		expect(driver.screenshotCount).toBe(1);
		const reviewed = reviewer.inputs[0]?.screenshot;
		const storedScreenshot = evidence.objects.get(screenshotKey);
		if (!reviewed || !storedScreenshot) {
			throw new Error("Expected a reviewed and a stored screenshot");
		}
		expect(reviewed.contentType).toBe("image/jpeg");
		expect(Array.from(reviewed.bytes)).toEqual(
			Array.from(storedScreenshot.body),
		);

		const object = evidence.objects.get(fieldMapKey);
		if (!object) throw new Error("Expected a stored field map");
		expect(object.contentType).toBe("application/json");
		expect(object.sha256).toBe(await sha256Hex(object.body));
		expect(
			JSON.parse(new TextDecoder().decode(object.body)) as unknown,
		).toEqual({
			targetUrl: input.targetUrl,
			capturedAt: "2026-08-28T00:00:02.000Z",
			submitReview: { decision: "allow", reasonCode: "INPUTS_MATCH" },
			fields: [
				{
					elementId: "fa-0-0",
					label: "お問い合わせ内容",
					name: "message",
					type: "text",
					required: true,
					value: "Hello",
				},
				{
					elementId: "fa-0-2",
					label: null,
					name: "pass",
					type: "password",
					required: null,
					value: "",
				},
				{
					elementId: "fa-0-3",
					label: null,
					name: "agree",
					type: "checkbox",
					required: null,
					value: "on",
					checked: true,
				},
			],
		});

		// The values live in the object store only.
		const logged = JSON.stringify(logs.entries);
		expect(logged).not.toContain("Hello");
		expect(logged).not.toContain("s3cret");
		expect(JSON.stringify(store.events)).not.toContain("Hello");
	});

	test("reviews without an image when the screen cannot be captured", async () => {
		const driver = new FakeDriver();
		driver.failScreenshotAt = 1;
		const store = new InMemoryJobStore();
		const evidence = new InMemoryEvidenceObjectStore();
		const reviewer = new StubSubmitReviewer();
		const tools = await createToolsWithEvidence(
			driver,
			store,
			evidence,
			reviewer,
		);
		await tools.fill("fa-0-0", "Hello");
		await tools.observe();

		const logs = captureConsole();
		let decision: SubmitReviewDecision;
		try {
			decision = await tools.reviewDryRunSubmit("fa-0-1");
			await tools.captureDryRunFieldMap(decision);
		} finally {
			logs.restore();
		}

		// A failed capture must not stop the review, only leave it imageless.
		expect(decision.decision).toBe("allow");
		expect(reviewer.inputs[0]?.screenshot).toBeNull();

		expect(store.events.map((event) => [event.type, event.data.stage])).toEqual(
			[
				["evidence.capture_failed", "dry_run_before_submit"],
				["evidence.captured", "dry_run_field_map"],
			],
		);
		expect(
			logs.entries.filter(
				(entry) =>
					isRecord(entry) && entry.event === "dry_run_evidence_capture_failed",
			),
		).toEqual([
			{
				event: "dry_run_evidence_capture_failed",
				stage: "dry_run_before_submit",
				failureCode: "SCREENSHOT_FAILED",
			},
		]);
		expect(evidence.objects.size).toBe(1);
	});
});

describe("observationFingerprint", () => {
	test("ignores element ids and non-comparable controls", () => {
		const withSubmit = observationFingerprint({
			url: input.targetUrl,
			forms: [
				{
					fields: [
						{ elementId: "fa-0-0", tag: "input", type: "text", value: "a" },
						{ elementId: "fa-0-1", tag: "input", type: "submit", value: "Go" },
					],
				},
			],
		});
		const renumberedWithoutSubmit = observationFingerprint({
			url: input.targetUrl,
			forms: [
				{
					fields: [
						{ elementId: "fa-9-7", tag: "input", type: "text", value: "a" },
					],
				},
			],
		});

		expect(withSubmit).toBe(renumberedWithoutSubmit);
	});

	test("changes when a value or checked state changes", () => {
		const base = {
			url: input.targetUrl,
			forms: [
				{
					fields: [
						{ elementId: "fa-0-0", tag: "input", type: "text", value: "a" },
						{
							elementId: "fa-0-1",
							tag: "input",
							type: "checkbox",
							checked: false,
						},
					],
				},
			],
		};

		expect(observationFingerprint(base)).not.toBe(
			observationFingerprint({
				...base,
				forms: [
					{
						fields: [
							{ elementId: "fa-0-0", tag: "input", type: "text", value: "b" },
							{
								elementId: "fa-0-1",
								tag: "input",
								type: "checkbox",
								checked: false,
							},
						],
					},
				],
			}),
		);
		expect(observationFingerprint(base)).not.toBe(
			observationFingerprint({
				...base,
				forms: [
					{
						fields: [
							{ elementId: "fa-0-0", tag: "input", type: "text", value: "a" },
							{
								elementId: "fa-0-1",
								tag: "input",
								type: "checkbox",
								checked: true,
							},
						],
					},
				],
			}),
		);
	});
});

describe("readTrustedFormValues", () => {
	test("keeps only string payload values with a safe key", () => {
		expect(
			readTrustedFormValues({
				formValues: {
					message: "Hello",
					"bad key": "value",
					empty: "",
					numeric: 1,
					long: "x".repeat(8_193),
				},
				instruction: "ignored",
			}),
		).toEqual({ message: "Hello" });
	});

	test("returns nothing when formValues is absent or not an object", () => {
		expect(readTrustedFormValues({})).toEqual({});
		expect(readTrustedFormValues({ formValues: ["Hello"] })).toEqual({});
	});

	test("keeps a candidate list within the contract", () => {
		expect(
			readTrustedFormValues({
				formValues: {
					inquiryType: ["その他のお問い合わせ", "その他"],
					contactMethod: ["メール"],
				},
			}),
		).toEqual({
			inquiryType: ["その他のお問い合わせ", "その他"],
			contactMethod: ["メール"],
		});
	});

	test("drops a candidate list that breaks an element or total limit", () => {
		expect(
			readTrustedFormValues({
				formValues: {
					empty: [],
					tooMany: Array.from({ length: 11 }, (_, index) => `c${index}`),
					emptyElement: ["ok", ""],
					longElement: ["x".repeat(257)],
					longTotal: Array.from({ length: 9 }, () => "x".repeat(256)),
					mixed: ["ok", 1],
					nested: [["ok"]],
					kept: ["ok"],
				},
			}),
		).toEqual({ kept: ["ok"] });
	});

	test("accepts a candidate list at every limit", () => {
		expect(
			readTrustedFormValues({
				formValues: {
					maxCount: Array.from({ length: 10 }, (_, index) => `c${index}`),
					maxElement: ["x".repeat(256)],
					maxTotal: Array.from({ length: 8 }, () => "x".repeat(256)),
				},
			}),
		).toEqual({
			maxCount: Array.from({ length: 10 }, (_, index) => `c${index}`),
			maxElement: ["x".repeat(256)],
			maxTotal: Array.from({ length: 8 }, () => "x".repeat(256)),
		});
	});

	test("hands out a frozen copy the payload can no longer change", () => {
		const candidates = ["メール", "Email"];
		const trusted = readTrustedFormValues({
			formValues: { contactMethod: candidates },
		});

		candidates[0] = "電話";

		const resolved = trusted.contactMethod as string[];
		expect(resolved).toEqual(["メール", "Email"]);
		expect(Object.isFrozen(resolved)).toBe(true);
	});
});

async function createToolsWithEvidence(
	driver: FakeDriver,
	store: InMemoryJobStore,
	evidence: InMemoryEvidenceObjectStore,
	reviewer: SubmitReviewer = allowSubmitReviewer(),
	reuseExistingJob = false,
): Promise<RestrictedBrowserTools> {
	if (!reuseExistingJob) {
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
	}
	return RestrictedBrowserTools.create(
		driver,
		store,
		input.id,
		"run-token-1",
		evidence,
		reviewer,
		() => "2026-08-28T00:00:02.000Z",
	);
}

async function createTools(
	driver: FakeDriver,
	reviewer: SubmitReviewer = allowSubmitReviewer(),
): Promise<RestrictedBrowserTools> {
	return createToolsForInput(driver, input, reviewer);
}

async function createToolsForInput(
	driver: FakeDriver,
	jobInput: JobInput,
	reviewer: SubmitReviewer = allowSubmitReviewer(),
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
		reviewer,
	);
}

/**
 * Test double for the independent pre-submit review. It records what the
 * trusted handler passes in and replays a queued decision, defaulting to allow.
 */
class StubSubmitReviewer implements SubmitReviewer {
	readonly inputs: SubmitReviewInput[] = [];
	error: Error | null = null;
	readonly #decisions: SubmitReviewDecision[];

	constructor(...decisions: SubmitReviewDecision[]) {
		this.#decisions = decisions;
	}

	get reviewCount(): number {
		return this.inputs.length;
	}

	async review(input: SubmitReviewInput): Promise<SubmitReviewDecision> {
		this.inputs.push(input);
		if (this.error) throw this.error;
		return (
			this.#decisions.shift() ?? {
				decision: "allow",
				reasonCode: "INPUTS_MATCH",
				reason: "The inputs match the job payload.",
			}
		);
	}
}

function allowSubmitReviewer(): SubmitReviewer {
	return new StubSubmitReviewer();
}

function denyDecision(
	reasonCode: SubmitReviewReasonCode = "INPUT_MISMATCH",
	reason = "A filled value does not come from formValues.",
): SubmitReviewDecision {
	return { decision: "deny", reasonCode, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Captures both log and warn lines, which evidence failures use together. */
function captureConsole(): { entries: unknown[]; restore: () => void } {
	const entries: unknown[] = [];
	const originalLog = console.log;
	const originalWarn = console.warn;
	const record = (message: unknown) => {
		entries.push(JSON.parse(String(message)));
	};
	console.log = record;
	console.warn = record;
	return {
		entries,
		restore: () => {
			console.log = originalLog;
			console.warn = originalWarn;
		},
	};
}

function captureLogs(): { entries: unknown[]; restore: () => void } {
	const entries: unknown[] = [];
	const originalLog = console.log;
	console.log = (message: unknown) => {
		entries.push(JSON.parse(String(message)));
	};
	return {
		entries,
		restore: () => {
			console.log = originalLog;
		},
	};
}

function defaultObservedForms(prohibitionText?: string): unknown[] {
	return [
		{
			fields: [
				{ elementId: "fa-0-0", tag: "input", type: "text", value: "" },
				{ elementId: "fa-0-1", tag: "input", type: "submit", value: "Send" },
				{ elementId: "fa-0-2", tag: "input", type: "text", value: "" },
			],
			...(prohibitionText === undefined ? {} : { prohibitionText }),
		},
	];
}

/** Matches `defaultObservedForms`, minus the submit control. */
function defaultFieldStates(): ObservedFieldState[] {
	return [
		{ elementId: "fa-0-0", value: "", checked: false },
		{ elementId: "fa-0-2", value: "", checked: false },
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
	navigationCount = 0;
	navigationLinks: Array<{ url: string; text: string }> | undefined;
	observeCount = 0;
	observationForms: unknown[] = defaultObservedForms();
	/** Replayed per observe call when set; the last entry repeats. */
	observationFormsSequence: unknown[][] | null = null;
	fieldStates: ObservedFieldState[] = defaultFieldStates();
	fieldStatesError: Error | null = null;
	/** Values each choice control offers, by elementId. */
	selectOptions: Record<string, string[]> = {};
	/** Replayed in order; the last entry repeats. */
	formSnapshots: string[] = ['["form"]'];
	formSnapshotCount = 0;
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
		this.navigationCount += 1;
		this.url = this.redirectTo ?? url;
	}

	async observe() {
		this.observeCount += 1;
		const sequence = this.observationFormsSequence;
		const forms = sequence
			? (sequence[Math.min(this.observeCount - 1, sequence.length - 1)] ?? [])
			: this.observationForms;
		return {
			url: this.url,
			// A real observation is a snapshot, not a live view of the page.
			forms: structuredClone(forms),
			...(this.pageText ? { pageText: this.pageText } : {}),
			...(this.navigationLinks
				? { navigationLinks: this.navigationLinks }
				: {}),
		};
	}

	async clickNonSubmit(): Promise<void> {}

	async fill(elementId: string, value: string): Promise<void> {
		this.applyValue(elementId, value);
	}

	async select(
		elementId: string,
		candidates: readonly string[],
	): Promise<void> {
		const offered = this.selectOptions[elementId];
		const chosen = offered
			? candidates.find((candidate) => offered.includes(candidate))
			: candidates[0];
		if (chosen === undefined) throw new BrowserElementError();
		this.applyValue(elementId, chosen);
	}

	/** Mirrors what a real browser shows on the next observation. */
	applyValue(elementId: string, value: string): void {
		for (const form of this.observationForms) {
			if (!isRecord(form) || !Array.isArray(form.fields)) continue;
			for (const field of form.fields) {
				if (isRecord(field) && field.elementId === elementId) {
					field.value = value;
				}
			}
		}
		for (const state of this.fieldStates) {
			if (state.elementId === elementId) state.value = value;
		}
	}

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

	async readObservedFieldStates(): Promise<ObservedFieldState[]> {
		if (this.fieldStatesError) throw this.fieldStatesError;
		return this.fieldStates;
	}

	async readFormSnapshot(): Promise<string> {
		this.formSnapshotCount += 1;
		return this.formSnapshots.length > 1
			? (this.formSnapshots.shift() as string)
			: (this.formSnapshots[0] as string);
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

function evidenceTimings(
	logs: readonly string[],
): Array<Record<string, unknown>> {
	return logs
		.filter((entry) => entry.includes('"submission_evidence_timing"'))
		.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

describe("SubmissionEvidenceRecorder", () => {
	test("records the object key before the upload and completes the same event", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const evidence = new EventsAtPutEvidenceObjectStore(store);
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

		expect(result.captured).toBe(true);
		// The intent already names the object while it is being written.
		expect(evidence.eventsAtPut).toEqual([
			[
				"evidence.intent",
				evidenceObjectKey(
					input.id,
					"before_submit",
					store.events[0]?.data.eventId as string,
				),
			],
		]);
		expect(store.events.map((event) => [event.type, event.data.stage])).toEqual(
			[["evidence.captured", "before_submit"]],
		);
	});

	test("records the duration of every capture step and the screenshot size", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			new EventsAtPutEvidenceObjectStore(store),
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
		);
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (message: unknown) => {
			logs.push(String(message));
		};

		try {
			await recorder.capture("before_submit");
		} finally {
			console.log = originalLog;
		}

		const timings = evidenceTimings(logs);
		expect(timings).toHaveLength(1);
		const timing = timings[0] ?? {};
		expect(timing.event).toBe("submission_evidence_timing");
		expect(timing.stage).toBe("before_submit");
		expect(timing.timedOut).toBe(false);
		expect(timing.phase).toBe("record");
		expect(timing.bytes).toBe(3);
		for (const field of ["screenshotMs", "digestMs", "putMs", "recordMs"]) {
			expect(typeof timing[field]).toBe("number");
		}
	});

	test("reports the phase a timed out capture reached, exactly once", async () => {
		const driver: Pick<RestrictedBrowserDriver, "captureScreenshot"> = {
			captureScreenshot: () => new Promise<Uint8Array>(() => {}),
		};
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			new InMemoryEvidenceObjectStore(),
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
			20,
		);
		const logs: string[] = [];
		const originalLog = console.log;
		const originalWarn = console.warn;
		console.log = (message: unknown) => {
			logs.push(String(message));
		};
		console.warn = () => undefined;

		let result: Awaited<ReturnType<typeof recorder.capture>>;
		try {
			result = await recorder.capture("after_submit");
			// The stalled screenshot never settles, so a second report could only
			// come from the capture side. Give it a turn to prove it does not.
			await new Promise((resolve) => setTimeout(resolve, 30));
		} finally {
			console.warn = originalWarn;
			console.log = originalLog;
		}

		expect(result).toEqual({
			captured: false,
			failureCode: "CAPTURE_TIMEOUT",
		});
		const timings = evidenceTimings(logs);
		expect(timings).toHaveLength(1);
		expect(timings[0]?.timedOut).toBe(true);
		expect(timings[0]?.phase).toBe("screenshot");
		expect(timings[0]?.stage).toBe("after_submit");
		expect(timings[0]?.bytes).toBe(0);
	});

	test("reports the record phase when the failure event write stalls", async () => {
		const driver: Pick<RestrictedBrowserDriver, "captureScreenshot"> = {
			captureScreenshot: () =>
				Promise.reject(new Error("Browser screenshot failed")),
		};
		const store = new StalledFailureRecordJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const recorder = new SubmissionEvidenceRecorder(
			driver,
			new InMemoryEvidenceObjectStore(),
			store,
			input.id,
			"run-token-1",
			1,
			() => "2026-08-28T00:00:02.000Z",
			20,
		);
		const logs: string[] = [];
		const originalLog = console.log;
		const originalWarn = console.warn;
		console.log = (message: unknown) => {
			logs.push(String(message));
		};
		console.warn = () => undefined;

		let result: Awaited<ReturnType<typeof recorder.capture>>;
		try {
			result = await recorder.capture("after_submit");
		} finally {
			console.warn = originalWarn;
			console.log = originalLog;
		}

		expect(result).toEqual({
			captured: false,
			failureCode: "CAPTURE_TIMEOUT",
		});
		const timings = evidenceTimings(logs);
		expect(timings).toHaveLength(1);
		expect(timings[0]?.timedOut).toBe(true);
		// The screenshot already failed; the capture is stuck writing that fact.
		expect(timings[0]?.phase).toBe("record");
	});

	test("moves the intent to a failure when the upload fails", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const evidence = new PutFailingEvidenceObjectStore();
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
			failureCode: "OBJECT_STORE_FAILED",
		});
		// The key stays on the failure event so a partial upload is traceable.
		expect(store.events).toEqual([
			{
				jobId: input.id,
				attempt: 1,
				type: "evidence.capture_failed",
				data: {
					stage: "before_submit",
					failureCode: "OBJECT_STORE_FAILED",
					objectKey: evidenceObjectKeyPattern("before_submit"),
				},
			},
		]);
	});

	test("does not upload when the intent cannot be recorded", async () => {
		const driver = new FakeDriver();
		const store = new RecordEvidenceIntentRejectingJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const evidence = new InMemoryEvidenceObjectStore();
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
		expect(store.events.map((event) => event.type)).toEqual([
			"evidence.capture_failed",
		]);
	});

	test("moves the intent to a failure when the capture times out", async () => {
		const driver = new FakeDriver();
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const evidence = new StalledPutEvidenceObjectStore();
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
		const originalWarn = console.warn;
		console.warn = () => undefined;

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
				data: {
					stage: "after_submit",
					failureCode: "CAPTURE_TIMEOUT",
					objectKey: evidenceObjectKeyPattern("after_submit"),
				},
			},
		]);
	});

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
				data: {
					stage: "before_submit",
					failureCode: "EVENT_NOT_RECORDED",
					objectKey: evidenceObjectKeyPattern("before_submit"),
				},
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
				data: {
					stage: "before_submit",
					failureCode: "CAPTURE_TIMEOUT",
					objectKey: evidenceObjectKeyPattern("before_submit"),
				},
			},
		]);
	});
});

/** Drops the first uncertain write, as a stalled D1 would. */
class UncertainOnceFailingJobStore extends InMemoryJobStore {
	#failuresLeft = 1;

	override async recordUncertain(
		...args: Parameters<InMemoryJobStore["recordUncertain"]>
	): Promise<
		ReturnType<InMemoryJobStore["recordUncertain"]> extends Promise<infer T>
			? T
			: never
	> {
		if (this.#failuresLeft > 0) {
			this.#failuresLeft -= 1;
			throw new Error("D1 is unavailable");
		}
		return super.recordUncertain(...args);
	}
}

class RecordEvidenceCapturedRejectingJobStore extends InMemoryJobStore {
	async recordEvidenceCaptured(): Promise<boolean> {
		return false;
	}
}

/** Matches the object key the recorder builds for one capture. */
function evidenceObjectKeyPattern(stage: EvidenceStage) {
	return expect.stringMatching(
		new RegExp(`^jobs/${input.id}/${stage}/[0-9a-f-]{36}\\.jpg$`),
	);
}

class RecordEvidenceIntentRejectingJobStore extends InMemoryJobStore {
	override async recordEvidenceIntent(): Promise<boolean> {
		return false;
	}
}

/** Remembers the recorded events as they stood while the object was written. */
class EventsAtPutEvidenceObjectStore extends InMemoryEvidenceObjectStore {
	readonly eventsAtPut: Array<[string, unknown]> = [];

	constructor(private readonly store: InMemoryJobStore) {
		super();
	}

	override async put(
		...args: Parameters<InMemoryEvidenceObjectStore["put"]>
	): Promise<void> {
		for (const event of this.store.events) {
			this.eventsAtPut.push([event.type, event.data.objectKey]);
		}
		return super.put(...args);
	}
}

class PutFailingEvidenceObjectStore extends InMemoryEvidenceObjectStore {
	override async put(): Promise<void> {
		throw new Error("put failed");
	}
}

class StalledPutEvidenceObjectStore extends InMemoryEvidenceObjectStore {
	override put(): Promise<void> {
		return new Promise<void>(() => {});
	}
}

class DeleteFailingEvidenceObjectStore extends InMemoryEvidenceObjectStore {
	override async delete(): Promise<void> {
		throw new Error("delete failed");
	}
}

/** Never finishes the failure event write, so a capture stalls in `record`. */
class StalledFailureRecordJobStore extends InMemoryJobStore {
	override recordEvidenceCaptureFailed(): Promise<boolean> {
		return new Promise<boolean>(() => {});
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
