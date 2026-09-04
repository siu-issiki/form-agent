import { describe, expect, test } from "bun:test";
import {
	buildCampaignJob,
	type CampaignCsvRow,
	DEFAULT_CHOICE_CANDIDATES,
	filterCampaignRows,
	jobContentFingerprint,
	jobInputFingerprint,
	mapRegistrationValues,
	mergeChoiceCandidates,
	normalizeCompanyDomain,
	type RegistrationEntry,
	readChoiceCandidates,
	readSendApprovalFile,
	registerCampaignJobs,
	resolveRedirectHosts,
	selectCampaignCandidates,
} from "../src/campaign-import";
import type { JobInput } from "../src/job";

const registrationPairs: Array<[string, string]> = [
	["苗字", "last"],
	["名前", "first"],
	["苗字（カナ）", "last-k"],
	["名前（カナ）", "first-k"],
	["苗字（かな）", "last-h"],
	["名前（かな）", "first-h"],
	["フルネームカタカナ", "full-k"],
	["フルネーム漢字", "full"],
	["フルネームひらがな", "full-h"],
	["住所", "address"],
	["住所1", "address-1"],
	["住所2", "address-2"],
	["住所3", "address-3"],
	["電話番号", "phone"],
	["郵便番号", "postal"],
	["郵便番号1", "postal-1"],
	["郵便番号2", "postal-2"],
	["会社HP", "website"],
	["メールアドレス", "email"],
	["部署", "department"],
	["会社名", "sender-company"],
	["電話番号1", "phone-1"],
	["電話番号2", "phone-2"],
	["電話番号3", "phone-3"],
	["電話番号", "phone-digits"],
];
const registration: RegistrationEntry[] = registrationPairs.map(
	([label, value]) => ({ label, value }),
);
/** Keeps the mapping summary out of the test output. */
const silent = { log: () => {} };

describe("campaign import", () => {
	test("maps expected registration labels to safe ASCII keys", () => {
		const values = mapRegistrationValues(registration, silent);

		expect(values.phone).toBe("phone");
		expect(values.phoneDigits).toBe("phone-digits");
		expect(Object.keys(values)).toHaveLength(25);
		expect(
			Object.keys(values).every((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key)),
		).toBe(true);
	});

	test("fails closed when a required registration label drifts", () => {
		const changed = registration.map((entry) => ({ ...entry }));
		changed[0] = { label: "姓", value: "last" };

		expect(() => mapRegistrationValues(changed, silent)).toThrow(
			"missing required fields: lastName",
		);
	});

	test("fails closed when a required registration value is empty", () => {
		const changed = registration.map((entry) =>
			entry.label === "メールアドレス" ? { ...entry, value: " " } : entry,
		);

		expect(() => mapRegistrationValues(changed, silent)).toThrow(
			"missing required fields: email",
		);
	});

	test("maps alias labels and the added fields", () => {
		const values = mapRegistrationValues(aliasRegistration(), silent);

		expect(values.fullName).toBe("full");
		expect(values.fullNameKatakana).toBe("full-k");
		expect(values.fullNameHiragana).toBe("full-h");
		expect(values.lastNameKatakana).toBe("last-k");
		expect(values.firstNameKatakana).toBe("first-k");
		expect(values.phonePart1).toBe("phone-1");
		expect(values.phonePart3).toBe("phone-3");
		expect(values.department).toBe("department");
		expect(values.jobTitle).toBe("job-title");
		expect(values.age).toBe("age");
		expect(
			Object.keys(values).every((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key)),
		).toBe(true);
	});

	test("prefers the canonical label over its alias", () => {
		const values = mapRegistrationValues(
			[
				...aliasRegistration(),
				{ label: "部署", value: "canonical-department" },
			],
			silent,
		);

		expect(values.department).toBe("canonical-department");
	});

	test("maps サービスページ to companyWebsite", () => {
		const values = mapRegistrationValues(
			[
				...aliasRegistration().filter((entry) => entry.label !== "会社HP"),
				{ label: "サービスページ", value: "service-page" },
			],
			silent,
		);

		expect(values.companyWebsite).toBe("service-page");
	});

	test("prefers 会社HP over サービスページ when both are present", () => {
		const values = mapRegistrationValues(
			[
				...aliasRegistration(),
				{ label: "サービスページ", value: "service-page" },
			],
			silent,
		);

		expect(values.companyWebsite).toBe("website");
	});

	test("uses one phone entry for both phone keys", () => {
		const values = mapRegistrationValues(aliasRegistration(), silent);

		expect(values.phone).toBe("phone");
		expect(values.phoneDigits).toBe("phone");
	});

	test("reads the second phone entry as the digits-only spelling", () => {
		const values = mapRegistrationValues(
			[...aliasRegistration(), { label: "電話番号", value: "phone-digits" }],
			silent,
		);

		expect(values.phone).toBe("phone");
		expect(values.phoneDigits).toBe("phone-digits");
	});

	test("ignores unknown labels and reports only their count", () => {
		const entries: Record<string, unknown>[] = [];
		const values = mapRegistrationValues(
			[
				...aliasRegistration(),
				{ label: "ご担当者メモ", value: "note" },
				{ label: "取引先コード", value: "code" },
				{ label: "空の未知項目", value: "" },
			],
			{ log: (entry) => entries.push(entry) },
		);

		expect(values.note).toBeUndefined();
		expect(entries).toEqual([
			{
				event: "campaign_registration_summary",
				mappedKeys: Object.keys(values).length,
				unknownLabels: 2,
			},
		]);
		expect(JSON.stringify(entries)).not.toContain("担当者");
	});

	test("skips optional entries whose value is empty", () => {
		const values = mapRegistrationValues(
			aliasRegistration().map((entry) =>
				entry.label === "役職" ? { ...entry, value: "" } : entry,
			),
			silent,
		);

		expect(values.jobTitle).toBeUndefined();
	});

	test("reads the simple CSV layout and derives the company domain", () => {
		const result = filterCampaignRows([
			simpleRow(),
			simpleRow({ 問い合わせリンク: "https://www.beta.co.jp/inquiry" }),
		]);

		expect(result.excluded).toEqual({});
		expect(result.eligible).toEqual([
			{
				rowNumber: 2,
				companyName: "contact.acme.co.jp",
				companyDomain: "acme.co.jp",
				targetUrl: "https://contact.acme.co.jp/form",
				subject: "Subject",
				message: "Message",
			},
			{
				rowNumber: 3,
				companyName: "www.beta.co.jp",
				companyDomain: "beta.co.jp",
				targetUrl: "https://www.beta.co.jp/inquiry",
				subject: "Subject",
				message: "Message",
			},
		]);
	});

	test("excludes simple rows without a body, a subject, or a usable URL", () => {
		const result = filterCampaignRows([
			simpleRow(),
			simpleRow({ 本文: "" }),
			simpleRow({ 件名: " " }),
			simpleRow({ 問い合わせリンク: "" }),
			simpleRow({ 問い合わせリンク: "http://contact.acme.co.jp/form" }),
			simpleRow({ 問い合わせリンク: "https://192.0.2.10/form" }),
		]);

		expect(result.eligible).toHaveLength(1);
		expect(result.excluded).toEqual({
			empty_message: 2,
			missing_form_url: 1,
			invalid_or_insecure_form_url: 2,
		});
	});

	test("reads the simple layout when the link column is 問い合わせフォームリンク", () => {
		const result = filterCampaignRows([
			{
				件名: "Subject",
				本文: "Message",
				問い合わせフォームリンク: "https://contact.acme.co.jp/form",
			},
		]);

		expect(result.excluded).toEqual({});
		expect(result.eligible).toEqual([
			{
				rowNumber: 2,
				companyName: "contact.acme.co.jp",
				companyDomain: "acme.co.jp",
				targetUrl: "https://contact.acme.co.jp/form",
				subject: "Subject",
				message: "Message",
			},
		]);
	});

	test("prefers 問い合わせリンク over 問い合わせフォームリンク when both are present", () => {
		const result = filterCampaignRows([
			{
				件名: "Subject",
				本文: "Message",
				問い合わせリンク: "https://contact.acme.co.jp/form",
				問い合わせフォームリンク: "https://www.beta.co.jp/inquiry",
			},
		]);

		expect(result.eligible[0]?.targetUrl).toBe(
			"https://contact.acme.co.jp/form",
		);
	});

	test("reads the simple layout past a leading unnamed index column", () => {
		const result = filterCampaignRows([simpleRow({ "": "1" })]);

		expect(result.excluded).toEqual({});
		expect(result.eligible).toHaveLength(1);
	});

	test("keeps the source row numbering of the simple layout", () => {
		const result = filterCampaignRows([
			simpleRow({ 本文: "" }),
			simpleRow(),
			simpleRow(),
		]);

		expect(result.eligible.map((candidate) => candidate.rowNumber)).toEqual([
			3, 4,
		]);
	});

	test("filters sent, blocked, missing, and insecure rows", () => {
		const valid = row();
		const result = filterCampaignRows([
			valid,
			row({ フォーム送信ステータス: "送信済" }),
			row({ エラー確認: "要確認" }),
			row({ 問い合わせフォームURL: "" }),
			row({ 問い合わせフォームURL: "http://acme.co.jp/contact" }),
		]);

		expect(result.eligible).toHaveLength(1);
		expect(result.excluded).toEqual({
			already_sent: 1,
			blocked_by_check: 1,
			missing_form_url: 1,
			invalid_or_insecure_form_url: 1,
		});
	});

	test("reduces a company subdomain to its registrable domain", () => {
		expect(normalizeCompanyDomain("mtech.hankyu-hanshin.co.jp")).toBe(
			"hankyu-hanshin.co.jp",
		);
	});

	test("collects only exact public HTTPS redirect hosts", async () => {
		const calls: string[] = [];
		const fetcher = (async (resource: URL | RequestInfo) => {
			const url = resource.toString();
			calls.push(url);
			if (url === "https://forms.gle/example") {
				return new Response(null, {
					status: 302,
					headers: { location: "https://docs.google.com/forms/example" },
				});
			}
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const result = await resolveRedirectHosts(
			"https://forms.gle/example",
			fetcher,
		);

		expect(calls).toEqual([
			"https://forms.gle/example",
			"https://docs.google.com/forms/example",
		]);
		expect(result.allowedHosts).toEqual(["docs.google.com", "forms.gle"]);
	});

	test("builds stable dry-run jobs without Japanese form keys", async () => {
		const candidate = filterCampaignRows([row()]).eligible[0];
		if (!candidate) throw new Error("Expected an eligible candidate");
		const values = mapRegistrationValues(registration, silent);
		const resolution = {
			finalUrl: "https://acme.co.jp/contact",
			allowedHosts: ["acme.co.jp"],
		};
		const first = await buildCampaignJob(
			candidate,
			values,
			"agb-shaken-dryrun-v1",
			resolution,
		);
		const second = await buildCampaignJob(
			candidate,
			values,
			"agb-shaken-dryrun-v1",
			resolution,
		);

		expect(first.id).toBe(second.id);
		expect(first.companyId).toBe(second.companyId);
		expect(first.payload._formAgentDryRun).toBe(true);
		expect(first.payload._formAgentMaxAttempts).toBe(1);
		expect(Object.keys(first.payload.formValues as object)).not.toContain(
			"会社名",
		);
	});

	test("merges choice candidates into the payload", async () => {
		const candidate = filterCampaignRows([row()]).eligible[0];
		if (!candidate) throw new Error("Expected an eligible candidate");
		const job = await buildCampaignJob(
			candidate,
			mapRegistrationValues(registration, silent),
			"agb-shaken-dryrun-v1",
			{
				finalUrl: "https://acme.co.jp/contact",
				allowedHosts: ["acme.co.jp"],
			},
			{ inquiryType: ["その他", "ご意見・ご要望"] },
		);

		expect(job.payload.formValues).toMatchObject({
			inquiryType: ["その他", "ご意見・ご要望"],
		});
	});

	test("refuses a choice key that a registration or content value already holds", async () => {
		const candidate = filterCampaignRows([row()]).eligible[0];
		if (!candidate) throw new Error("Expected an eligible candidate");
		const resolution = {
			finalUrl: "https://acme.co.jp/contact",
			allowedHosts: ["acme.co.jp"],
		};
		const values = mapRegistrationValues(registration, silent);
		const build = (choices: Record<string, readonly string[]>) =>
			buildCampaignJob(
				candidate,
				values,
				"agb-shaken-dryrun-v1",
				resolution,
				choices,
			);

		await expect(build({ subject: ["その他"] })).rejects.toThrow(
			"Choice key collides",
		);
		const registeredKey = Object.keys(values)[0];
		if (!registeredKey) throw new Error("Expected a registration key");
		await expect(build({ [registeredKey]: ["その他"] })).rejects.toThrow(
			"Choice key collides",
		);
	});

	test("validates a choices file against the candidate list contract", () => {
		expect(
			readChoiceCandidates({ inquiryType: ["その他", "ご意見・ご要望"] }),
		).toEqual({ inquiryType: ["その他", "ご意見・ご要望"] });
		expect(() => readChoiceCandidates(["その他"])).toThrow("Choices JSON");
		expect(() => readChoiceCandidates({ "bad key": ["その他"] })).toThrow(
			"invalid payload key",
		);
		expect(() => readChoiceCandidates({ inquiryType: "その他" })).toThrow(
			"invalid candidate list",
		);
		expect(() => readChoiceCandidates({ inquiryType: [] })).toThrow(
			"invalid candidate list",
		);
		expect(() =>
			readChoiceCandidates({
				inquiryType: Array.from({ length: 11 }, (_, index) => `c${index}`),
			}),
		).toThrow("invalid candidate list");
	});

	test("selects the offset window from the eligible rows", () => {
		const { eligible } = filterCampaignRows(
			Array.from({ length: 6 }, (_, index) =>
				row({
					企業ドメイン: `acme-${index}.co.jp`,
					問い合わせフォームURL: `https://acme-${index}.co.jp/contact`,
				}),
			),
		);

		expect(eligible).toHaveLength(6);
		expect(
			selectCampaignCandidates(eligible, 0, 2).map((entry) => entry.rowNumber),
		).toEqual([2, 3]);
		expect(
			selectCampaignCandidates(eligible, 2, 2).map((entry) => entry.rowNumber),
		).toEqual([4, 5]);
		// The window is clipped instead of wrapping, so the caller detects the
		// shortfall and stops.
		expect(
			selectCampaignCandidates(eligible, 5, 3).map((entry) => entry.rowNumber),
		).toEqual([7]);
		expect(selectCampaignCandidates(eligible, 6, 1)).toEqual([]);
	});

	test("rejects a non-integer or negative offset and limit", () => {
		const { eligible } = filterCampaignRows([row()]);

		expect(() => selectCampaignCandidates(eligible, -1, 1)).toThrow(
			"offset must be an integer of 0 or more",
		);
		expect(() => selectCampaignCandidates(eligible, 1.5, 1)).toThrow(
			"offset must be an integer of 0 or more",
		);
		expect(() => selectCampaignCandidates(eligible, 0, 0)).toThrow(
			"limit must be an integer of 1 or more",
		);
		expect(() => selectCampaignCandidates(eligible, 0, Number.NaN)).toThrow(
			"limit must be an integer of 1 or more",
		);
	});

	test("keeps the example choices file within the contract", async () => {
		const example = await Bun.file(
			"docs/examples/campaign-choices.example.json",
		).json();

		// The example file documents the shipped defaults, so it must stay equal
		// to them as well as valid.
		expect(readChoiceCandidates(example)).toEqual({
			...DEFAULT_CHOICE_CANDIDATES,
		});
	});

	test("applies the default candidates when no choices file is given", () => {
		const merged = mergeChoiceCandidates(DEFAULT_CHOICE_CANDIDATES, {});

		expect(Object.keys(merged)).toEqual([
			"inquiryType",
			"contactMethod",
			"privacyConsent",
		]);
		expect(merged.inquiryType?.[0]).toBe("その他");
		expect(merged.privacyConsent).toEqual(["checked"]);
	});

	test("lets a choices file override one default key and keep the rest", () => {
		const merged = mergeChoiceCandidates(DEFAULT_CHOICE_CANDIDATES, {
			inquiryType: ["営業以外"],
			salutation: ["様"],
		});

		expect(merged.inquiryType).toEqual(["営業以外"]);
		expect(merged.salutation).toEqual(["様"]);
		expect(merged.contactMethod).toEqual(
			DEFAULT_CHOICE_CANDIDATES.contactMethod,
		);
		expect(merged.privacyConsent).toEqual(["checked"]);
	});

	test("drops every default when the default set is disabled", () => {
		expect(mergeChoiceCandidates({}, {})).toEqual({});
		expect(mergeChoiceCandidates({}, { inquiryType: ["その他"] })).toEqual({
			inquiryType: ["その他"],
		});
	});

	test("registers every job before waiting for any of them", async () => {
		const jobs = [dryRunJob("job-1"), dryRunJob("job-2")];
		const posted: string[] = [];
		const logs: Array<Record<string, unknown>> = [];

		const result = await registerCampaignJobs(jobs, {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: (entry) => logs.push(entry),
			fetcher: async (resource, init) => {
				posted.push(String(init?.method ?? "GET"));
				void resource;
				return new Response(null, { status: 201 });
			},
		});

		expect(result).toMatchObject({ notRegistered: 0, unknown: 0 });
		expect(result.registered.map((job) => job.id)).toEqual(["job-1", "job-2"]);
		expect(posted).toEqual(["POST", "POST"]);
		expect(logs.map((entry) => entry.event)).toEqual([
			"campaign_job_registered",
			"campaign_job_registered",
		]);
	});

	test("keeps a job whose registration response was lost but which exists", async () => {
		const jobs = [dryRunJob("job-1"), dryRunJob("job-2")];
		const logs: Array<Record<string, unknown>> = [];

		const result = await registerCampaignJobs(jobs, {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: (entry) => logs.push(entry),
			fetcher: async (_resource, init) => {
				if (init?.method === "POST") throw new TypeError("network error");
				return storedJobResponse(jobs[0] as JobInput);
			},
		});

		expect(result.registered.map((job) => job.id)).toEqual(["job-1"]);
		// job-2 was never attempted after the stop, so it is a known non-entry.
		expect(result).toMatchObject({ notRegistered: 1, unknown: 0 });
		expect(logs.at(-1)).toEqual({
			event: "campaign_job_registration_checked",
			jobId: "job-1",
			outcome: "registered",
		});
		// Fixed values only: no URL, host, or provider message.
		expect(logs[0]).toEqual({
			event: "campaign_job_registration_unconfirmed",
			jobId: "job-1",
			reason: "REQUEST_FAILED",
		});
	});

	test("refuses a stored job under the same id whose inputs differ", async () => {
		const logs: Array<Record<string, unknown>> = [];

		const result = await registerCampaignJobs([dryRunJob("job-1", "Hello")], {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: (entry) => logs.push(entry),
			fetcher: async (_resource, init) => {
				if (init?.method === "POST") throw new TypeError("network error");
				return storedJobResponse(dryRunJob("job-1", "A different message"));
			},
		});

		expect(result).toMatchObject({
			registered: [],
			notRegistered: 0,
			unknown: 1,
		});
		// The outcome is reported without any registrant value.
		expect(logs.at(-1)).toEqual({
			event: "campaign_job_registration_checked",
			jobId: "job-1",
			outcome: "mismatched",
		});
	});

	test("compares the form URL and every form value in order", async () => {
		const job = dryRunJob("job-1");
		const base = await jobInputFingerprint(job.targetUrl, job.payload);
		const values = (job.payload as { formValues: Record<string, unknown> })
			.formValues;

		// The API adds this key on registration, so it must not change the digest.
		expect(
			await jobInputFingerprint(job.targetUrl, {
				...job.payload,
				_formAgentEffectiveDryRun: true,
			}),
		).toBe(base);
		expect(
			await jobInputFingerprint("https://acme.co.jp/contact-us", job.payload),
		).not.toBe(base);
		expect(
			await jobInputFingerprint(job.targetUrl, {
				...job.payload,
				formValues: { ...values, inquiryType: ["ご意見・ご要望", "その他"] },
			}),
		).not.toBe(base);
		expect(
			await jobInputFingerprint(job.targetUrl, {
				...job.payload,
				formValues: { ...values, extra: "x" },
			}),
		).not.toBe(base);
	});

	test("counts a lost registration the API does not hold as failed", async () => {
		const result = await registerCampaignJobs([dryRunJob("job-1")], {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: () => undefined,
			fetcher: async (_resource, init) => {
				if (init?.method === "POST") throw new TypeError("network error");
				return new Response(null, { status: 404 });
			},
		});

		expect(result).toMatchObject({
			registered: [],
			notRegistered: 1,
			unknown: 0,
		});
	});

	test("counts a registration it cannot confirm either way as unknown", async () => {
		const result = await registerCampaignJobs([dryRunJob("job-1")], {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: () => undefined,
			fetcher: async () => {
				throw new TypeError("network error");
			},
		});

		expect(result).toMatchObject({
			registered: [],
			notRegistered: 0,
			unknown: 1,
		});
	});

	test("stops registering when the API rejects a job outright", async () => {
		const jobs = [dryRunJob("job-1"), dryRunJob("job-2")];
		let posts = 0;

		const result = await registerCampaignJobs(jobs, {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: () => undefined,
			fetcher: async () => {
				posts += 1;
				return new Response(null, { status: 500 });
			},
		});

		expect(posts).toBe(1);
		expect(result).toMatchObject({
			registered: [],
			notRegistered: 2,
			unknown: 0,
		});
	});

	test("refuses to register a job without the dry-run guard", async () => {
		const job = dryRunJob("job-1");
		const unguarded = { ...job, payload: { ...job.payload } };
		delete unguarded.payload._formAgentDryRun;

		await expect(
			registerCampaignJobs([unguarded], {
				baseUrl: "https://api.test",
				apiToken: "token",
				log: () => undefined,
				fetcher: async () => new Response(null, { status: 201 }),
			}),
		).rejects.toThrow("dry-run guard");
	});

	test("builds a real-send job that carries its approval record", async () => {
		const candidate = filterCampaignRows([row()]).eligible[0];
		if (!candidate) throw new Error("Expected an eligible candidate");
		const job = await buildCampaignJob(
			candidate,
			mapRegistrationValues(registration, silent),
			"agb-shaken-send-v1",
			{
				finalUrl: "https://acme.co.jp/contact",
				allowedHosts: ["acme.co.jp"],
			},
			{},
			{ dryRun: false, approval },
		);

		expect(job.payload._formAgentDryRun).toBe(false);
		expect(job.payload._formAgentMaxAttempts).toBe(1);
		expect(job.payload._formAgentSendApproval).toEqual(approval);
		expect(job.payload.instruction).toContain("submit it once");
	});

	test("keeps the default job a dry-run without an approval", async () => {
		const candidate = filterCampaignRows([row()]).eligible[0];
		if (!candidate) throw new Error("Expected an eligible candidate");
		const job = await buildCampaignJob(
			candidate,
			mapRegistrationValues(registration, silent),
			"agb-shaken-dryrun-v1",
			{
				finalUrl: "https://acme.co.jp/contact",
				allowedHosts: ["acme.co.jp"],
			},
		);

		expect(job.payload._formAgentDryRun).toBe(true);
		expect(job.payload).not.toHaveProperty("_formAgentSendApproval");
		expect(job.payload.instruction).toContain("must stop before submission");
	});

	test("refuses to build a send without an approval or a dry-run with one", async () => {
		const candidate = filterCampaignRows([row()]).eligible[0];
		if (!candidate) throw new Error("Expected an eligible candidate");
		const resolution = {
			finalUrl: "https://acme.co.jp/contact",
			allowedHosts: ["acme.co.jp"],
		};
		const build = (mode: Record<string, unknown>) =>
			buildCampaignJob(
				candidate,
				mapRegistrationValues(registration, silent),
				"agb-shaken-send-v1",
				resolution,
				{},
				mode,
			);

		await expect(build({ dryRun: false })).rejects.toThrow(
			"requires a valid send approval",
		);
		await expect(
			build({ dryRun: false, approval: { ...approval, approvedAt: "today" } }),
		).rejects.toThrow("requires a valid send approval");
		await expect(build({ dryRun: true, approval })).rejects.toThrow(
			"must not carry a send approval",
		);
	});

	test("registers a real-send job only with its approval record", async () => {
		const approved = sendJob("job-send-1");
		const unapproved = { ...approved, payload: { ...approved.payload } };
		delete unapproved.payload._formAgentSendApproval;
		const stillDryRun = {
			...approved,
			payload: { ...approved.payload, _formAgentDryRun: true },
		};
		const registerOptions = {
			baseUrl: "https://api.test",
			apiToken: "token",
			log: () => undefined,
			realSend: true,
			fetcher: async () => new Response(null, { status: 201 }),
		};

		const result = await registerCampaignJobs([approved], registerOptions);

		expect(result.registered.map((job) => job.id)).toEqual(["job-send-1"]);
		await expect(
			registerCampaignJobs([unapproved], registerOptions),
		).rejects.toThrow("approval record");
		await expect(
			registerCampaignJobs([stillDryRun], registerOptions),
		).rejects.toThrow("dry-run flag to false");
	});

	test("refuses to register a real-send job as a dry-run registration", async () => {
		await expect(
			registerCampaignJobs([sendJob("job-send-1")], {
				baseUrl: "https://api.test",
				apiToken: "token",
				log: () => undefined,
				fetcher: async () => new Response(null, { status: 201 }),
			}),
		).rejects.toThrow("dry-run guard");
	});

	test("binds the content fingerprint to the URL, company, and form values", async () => {
		const base = sendJob("job-send-1");
		const digest = (job: JobInput) =>
			jobContentFingerprint(job.targetUrl, job.companyId, job.payload);

		const same = await digest({
			...base,
			id: "job-send-2",
			payload: { ...base.payload, campaign: "another-name" },
		});
		const otherMessage = await digest({
			...base,
			payload: {
				...base.payload,
				formValues: { ...(base.payload.formValues as object), message: "Hi" },
			},
		});
		const otherCompany = await digest({ ...base, companyId: "company-2" });
		const otherUrl = await digest({
			...base,
			targetUrl: "https://acme.co.jp/contact2",
		});

		// The campaign name and the job id are not part of the approved content.
		expect(same).toBe(await digest(base));
		expect(otherMessage).not.toBe(same);
		expect(otherCompany).not.toBe(same);
		expect(otherUrl).not.toBe(same);
	});

	test("refuses a stored dry-run job as a real-send registration", async () => {
		const job = sendJob("job-send-1");
		const logs: Array<Record<string, unknown>> = [];

		const result = await registerCampaignJobs([job], {
			baseUrl: "https://api.test",
			apiToken: "token",
			realSend: true,
			log: (entry) => logs.push(entry),
			fetcher: async (_resource, init) => {
				if (init?.method === "POST") throw new TypeError("network error");
				// The same campaign name already registered this id as a dry-run.
				return storedJobResponse(dryRunJob("job-send-1"));
			},
		});

		expect(result).toMatchObject({
			registered: [],
			notRegistered: 0,
			unknown: 1,
		});
		expect(logs.map((entry) => entry.outcome)).toContain("mismatched");
	});

	test("keeps a real-send registration the API holds with the same approval", async () => {
		const job = sendJob("job-send-1");

		const result = await registerCampaignJobs([job], {
			baseUrl: "https://api.test",
			apiToken: "token",
			realSend: true,
			log: () => undefined,
			fetcher: async (_resource, init) => {
				if (init?.method === "POST") throw new TypeError("network error");
				return storedSendJobResponse(job);
			},
		});

		expect(result.registered.map((registered) => registered.id)).toEqual([
			"job-send-1",
		]);
	});

	test("refuses a stored real send approved by someone else", async () => {
		const job = sendJob("job-send-1");
		const stored = {
			...job,
			payload: {
				...job.payload,
				_formAgentSendApproval: { ...approval, approvedBy: "someone-else" },
			},
		};

		const result = await registerCampaignJobs([job], {
			baseUrl: "https://api.test",
			apiToken: "token",
			realSend: true,
			log: () => undefined,
			fetcher: async (_resource, init) => {
				if (init?.method === "POST") throw new TypeError("network error");
				return storedSendJobResponse(stored);
			},
		});

		expect(result).toMatchObject({ registered: [], unknown: 1 });
	});

	test("reads an approval file that names the dry-run of every row", () => {
		const file = readSendApprovalFile(
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04T00:00:00.000Z",
				entries: [
					{ sourceRow: 2, dryRunJobId: "dry-1", note: "確認済み" },
					{ sourceRow: 3, dryRunJobId: "dry-2" },
				],
			},
			5,
		);

		expect(file.approvedBy).toBe("operator");
		expect(file.entries).toEqual([
			{ sourceRow: 2, dryRunJobId: "dry-1", note: "確認済み" },
			{ sourceRow: 3, dryRunJobId: "dry-2" },
		]);
	});

	test("refuses an approval file above the send limit", () => {
		const entries = [
			{ sourceRow: 2, dryRunJobId: "dry-1" },
			{ sourceRow: 3, dryRunJobId: "dry-2" },
		];

		expect(() =>
			readSendApprovalFile(
				{
					approvedBy: "operator",
					approvedAt: "2026-09-04T00:00:00.000Z",
					entries,
				},
				1,
			),
		).toThrow("above the limit of 1");
	});

	test.each([
		[{ entries: [{ sourceRow: 2, dryRunJobId: "dry-1" }] }, "approvedBy"],
		[
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04",
				entries: [{ sourceRow: 2, dryRunJobId: "dry-1" }],
			},
			"ISO 8601",
		],
		[
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04T00:00:00.000Z",
				entries: [],
			},
			"at least one entry",
		],
		[
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04T00:00:00.000Z",
				entries: [{ dryRunJobId: "dry-1" }],
			},
			"sourceRow",
		],
		[
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04T00:00:00.000Z",
				entries: [{ sourceRow: 2, dryRunJobId: "../etc" }],
			},
			"dryRunJobId",
		],
		[
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04T00:00:00.000Z",
				entries: [
					{ sourceRow: 2, dryRunJobId: "dry-1" },
					{ sourceRow: 2, dryRunJobId: "dry-2" },
				],
			},
			"duplicate sourceRow",
		],
		[
			{
				approvedBy: "operator",
				approvedAt: "2026-09-04T00:00:00.000Z",
				entries: [
					{ sourceRow: 2, dryRunJobId: "dry-1" },
					{ sourceRow: 3, dryRunJobId: "dry-1" },
				],
			},
			"duplicate dryRunJobId",
		],
	])("refuses an approval file outside its contract %#", (value, message) => {
		expect(() => readSendApprovalFile(value, 5)).toThrow(message);
	});

	test("validates the merged candidates against the same contract", () => {
		expect(() =>
			mergeChoiceCandidates(DEFAULT_CHOICE_CANDIDATES, { inquiryType: [] }),
		).toThrow("invalid candidate list");
		expect(() =>
			mergeChoiceCandidates(DEFAULT_CHOICE_CANDIDATES, { "1bad": ["x"] }),
		).toThrow("invalid payload key");
	});
});

/** Approval record the real-send cases in this file build against. */
const approval = {
	approvedBy: "operator",
	approvedAt: "2026-09-04T00:00:00.000Z",
	dryRunJobId: "dry-run-job-1",
};

function sendJob(id: string): JobInput {
	const job = dryRunJob(id);
	return {
		...job,
		payload: {
			...job.payload,
			_formAgentDryRun: false,
			_formAgentSendApproval: approval,
		},
	};
}

function dryRunJob(id: string, message = "Hello"): JobInput {
	return {
		id,
		companyId: "company-1",
		companyName: "Target Company",
		targetUrl: "https://acme.co.jp/contact",
		targetDomain: "acme.co.jp",
		allowedHosts: ["acme.co.jp"],
		payload: {
			_formAgentDryRun: true,
			_formAgentMaxAttempts: 1,
			formValues: {
				subject: "Inquiry",
				message,
				inquiryType: ["その他", "ご意見・ご要望"],
			},
		},
	};
}

/** Mirrors `GET /jobs/:id`, including the key the API adds on registration. */
function storedJobResponse(job: JobInput): Response {
	return Response.json({
		job: {
			...job,
			payload: { ...job.payload, _formAgentEffectiveDryRun: true },
			status: "pending",
			attemptCount: 0,
		},
	});
}

/** Mirrors `GET /jobs/:id` for a job the API froze as a real send. */
function storedSendJobResponse(job: JobInput): Response {
	return Response.json({
		job: {
			...job,
			payload: { ...job.payload, _formAgentEffectiveDryRun: false },
			status: "pending",
			attemptCount: 0,
		},
	});
}

/** The three-column layout: no company columns and no NG check columns. */
function simpleRow(overrides: CampaignCsvRow = {}): CampaignCsvRow {
	return {
		問い合わせリンク: "https://contact.acme.co.jp/form",
		件名: "Subject",
		本文: "Message",
		...overrides,
	};
}

/**
 * A registration file in the wording of the second source: aliases instead of
 * the canonical labels, one phone entry, and the added fields.
 */
function aliasRegistration(): RegistrationEntry[] {
	return [
		{ label: "会社名", value: "sender-company" },
		{ label: "部署名", value: "department" },
		{ label: "役職", value: "job-title" },
		{ label: "苗字", value: "last" },
		{ label: "名前", value: "first" },
		{ label: "氏名（フルネーム漢字）", value: "full" },
		{ label: "苗字（カタカナ）", value: "last-k" },
		{ label: "名前（カタカナ）", value: "first-k" },
		{ label: "氏名（フルネームカタカナ）", value: "full-k" },
		{ label: "フリガナ", value: "ignored-alias" },
		{ label: "氏名（フルネームひらがな）", value: "full-h" },
		{ label: "ふりがな", value: "ignored-alias" },
		{ label: "年齢", value: "age" },
		{ label: "メールアドレス", value: "email" },
		{ label: "電話番号", value: "phone" },
		{ label: "電話1", value: "phone-1" },
		{ label: "電話2", value: "phone-2" },
		{ label: "電話3", value: "phone-3" },
		{ label: "郵便番号", value: "postal" },
		{ label: "住所", value: "address" },
		{ label: "会社HP", value: "website" },
	];
}

function row(overrides: CampaignCsvRow = {}): CampaignCsvRow {
	return {
		"人間\n目視チェック": "TRUE",
		企業名: "Target Company",
		エラー確認: "",
		アポ獲得企業会社名チェック: "",
		アポ獲得企業メールアドレスチェック: "",
		"AnyMind NGリスト会社名チェック": "",
		"AnyMind NGリストドメインチェック": "",
		個人アドレスチェック: "",
		ドメインチェック: "",
		"AnyReach NGリスト会社名チェック": "",
		"AnyReach NGリストドメインチェック": "",
		"AnyReach NGリストメールアドレスチェック": "",
		案件NGリスト会社名チェック: "",
		案件NGリストドメインチェック: "",
		案件NGリストメールアドレスチェック: "",
		NGワードチェック: "",
		会社名チェック: "",
		企業名重複チェック: "",
		企業ドメイン重複チェック: "",
		メールアドレスの重複チェック: "",
		メールドメインキー案件NGチェック: "",
		"メールドメインキーAnyReach NGチェック": "",
		企業ドメインキー案件NGチェック: "",
		"企業ドメインキーAnyReach NGチェック": "",
		企業ドメイン: "acme.co.jp",
		問い合わせフォームURL: "https://acme.co.jp/contact",
		件名: "Subject",
		メール文面: "Message",
		メール送信ステータス: "",
		フォーム送信ステータス: "",
		...overrides,
	};
}
