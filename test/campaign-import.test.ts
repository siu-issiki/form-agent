import { describe, expect, test } from "bun:test";
import {
	buildCampaignJob,
	type CampaignCsvRow,
	filterCampaignRows,
	mapRegistrationValues,
	normalizeCompanyDomain,
	type RegistrationEntry,
	readChoiceCandidates,
	resolveRedirectHosts,
} from "../src/campaign-import";

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

describe("campaign import", () => {
	test("maps expected registration labels to safe ASCII keys", () => {
		const values = mapRegistrationValues(registration);

		expect(values.phone).toBe("phone");
		expect(values.phoneDigits).toBe("phone-digits");
		expect(Object.keys(values)).toHaveLength(25);
		expect(
			Object.keys(values).every((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key)),
		).toBe(true);
	});

	test("fails closed when registration labels drift", () => {
		const changed = registration.map((entry) => ({ ...entry }));
		changed[0] = { label: "姓", value: "last" };

		expect(() => mapRegistrationValues(changed)).toThrow("expected labels");
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
		const values = mapRegistrationValues(registration);
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
			mapRegistrationValues(registration),
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
		const values = mapRegistrationValues(registration);
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

	test("keeps the example choices file within the contract", async () => {
		const example = await Bun.file(
			"docs/examples/campaign-choices.example.json",
		).json();

		expect(Object.keys(readChoiceCandidates(example))).toEqual([
			"inquiryType",
			"contactMethod",
		]);
	});
});

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
