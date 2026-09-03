import { parse } from "tldts";
import type { JobInput } from "./job";
import {
	isTrustedCandidateList,
	normalizeAllowedHosts,
	normalizeTargetDomain,
	PAYLOAD_KEY_PATTERN,
	type TrustedFormValue,
} from "./restricted-browser";

export interface RegistrationEntry {
	label: string;
	value: string;
}

export type CampaignCsvRow = Record<string, string>;

export interface CampaignCandidate {
	rowNumber: number;
	companyName: string;
	companyDomain: string;
	targetUrl: string;
	subject: string;
	message: string;
}

export interface CampaignFilterResult {
	eligible: CampaignCandidate[];
	excluded: Record<string, number>;
}

export interface RedirectResolution {
	finalUrl: string;
	allowedHosts: string[];
}

const REQUIRED_COLUMNS = [
	"人間\n目視チェック",
	"企業名",
	"エラー確認",
	"アポ獲得企業会社名チェック",
	"アポ獲得企業メールアドレスチェック",
	"AnyMind NGリスト会社名チェック",
	"AnyMind NGリストドメインチェック",
	"個人アドレスチェック",
	"ドメインチェック",
	"AnyReach NGリスト会社名チェック",
	"AnyReach NGリストドメインチェック",
	"AnyReach NGリストメールアドレスチェック",
	"案件NGリスト会社名チェック",
	"案件NGリストドメインチェック",
	"案件NGリストメールアドレスチェック",
	"NGワードチェック",
	"会社名チェック",
	"企業名重複チェック",
	"企業ドメイン重複チェック",
	"メールアドレスの重複チェック",
	"メールドメインキー案件NGチェック",
	"メールドメインキーAnyReach NGチェック",
	"企業ドメインキー案件NGチェック",
	"企業ドメインキーAnyReach NGチェック",
	"企業ドメイン",
	"問い合わせフォームURL",
	"件名",
	"メール文面",
	"メール送信ステータス",
	"フォーム送信ステータス",
] as const;

const BLOCKER_COLUMNS = REQUIRED_COLUMNS.slice(2, 24);

const REGISTRATION_FIELDS: Array<[string, string]> = [
	["苗字", "lastName"],
	["名前", "firstName"],
	["苗字（カナ）", "lastNameKatakana"],
	["名前（カナ）", "firstNameKatakana"],
	["苗字（かな）", "lastNameHiragana"],
	["名前（かな）", "firstNameHiragana"],
	["フルネームカタカナ", "fullNameKatakana"],
	["フルネーム漢字", "fullName"],
	["フルネームひらがな", "fullNameHiragana"],
	["住所", "address"],
	["住所1", "addressPart1"],
	["住所2", "addressPart2"],
	["住所3", "addressPart3"],
	["電話番号", "phone"],
	["郵便番号", "postalCode"],
	["郵便番号1", "postalCodePart1"],
	["郵便番号2", "postalCodePart2"],
	["会社HP", "companyWebsite"],
	["メールアドレス", "email"],
	["部署", "department"],
	["会社名", "companyName"],
	["電話番号1", "phonePart1"],
	["電話番号2", "phonePart2"],
	["電話番号3", "phonePart3"],
	["電話番号", "phoneDigits"],
];

export function mapRegistrationValues(
	entries: readonly RegistrationEntry[],
): Record<string, string> {
	if (entries.length !== REGISTRATION_FIELDS.length) {
		throw new Error(
			"Registration data does not match the expected field count",
		);
	}

	const values: Record<string, string> = {};
	for (let index = 0; index < REGISTRATION_FIELDS.length; index += 1) {
		const expected = REGISTRATION_FIELDS[index];
		const entry = entries[index];
		if (!expected || !entry || entry.label !== expected[0] || !entry.value) {
			throw new Error("Registration data does not match the expected labels");
		}
		values[expected[1]] = entry.value;
	}
	return values;
}

export function filterCampaignRows(
	rows: readonly CampaignCsvRow[],
): CampaignFilterResult {
	if (rows.length > 0) assertRequiredColumns(rows[0] ?? {});
	const eligible: CampaignCandidate[] = [];
	const excluded: Record<string, number> = {};

	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index] ?? {};
		const reason = exclusionReason(row);
		if (reason) {
			excluded[reason] = (excluded[reason] ?? 0) + 1;
			continue;
		}

		eligible.push({
			rowNumber: index + 2,
			companyName: required(row, "企業名"),
			companyDomain: normalizeCompanyDomain(required(row, "企業ドメイン")),
			targetUrl: required(row, "問い合わせフォームURL"),
			subject: required(row, "件名"),
			message: required(row, "メール文面"),
		});
	}

	return { eligible, excluded };
}

/**
 * Picks the dry-run window out of the eligible rows. The window is taken from
 * the eligible order itself, so a row that later fails the redirect preflight
 * still consumes its slot and the same offset always names the same rows.
 */
export function selectCampaignCandidates(
	eligible: readonly CampaignCandidate[],
	offset: number,
	limit: number,
): CampaignCandidate[] {
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error("offset must be an integer of 0 or more");
	}
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error("limit must be an integer of 1 or more");
	}
	return eligible.slice(offset, offset + limit);
}

export async function resolveRedirectHosts(
	startUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<RedirectResolution> {
	let current = validatedHttpsUrl(startUrl);
	const hosts = [current.hostname];

	for (let redirect = 0; redirect < 7; redirect += 1) {
		let response = await fetcher(current, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 405 || response.status === 501) {
			await response.body?.cancel();
			response = await fetcher(current, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			});
		}

		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location || response.status < 300 || response.status >= 400) {
			return {
				finalUrl: current.toString(),
				allowedHosts: normalizeAllowedHosts(hosts),
			};
		}

		current = validatedHttpsUrl(new URL(location, current).toString());
		hosts.push(current.hostname);
	}

	throw new Error("Redirect chain exceeds the allowed host limit");
}

/**
 * Validates a choices file against the candidate-list contract. Choices are
 * registrant-supplied values, so they are checked here exactly as `POST /jobs`
 * checks them, before a job is ever built from them.
 */
export function readChoiceCandidates(
	value: unknown,
): Record<string, readonly string[]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Choices JSON must be an object of candidate lists");
	}
	const choices: Record<string, readonly string[]> = {};
	for (const [key, candidates] of Object.entries(value)) {
		if (!PAYLOAD_KEY_PATTERN.test(key)) {
			throw new Error("Choices JSON holds an invalid payload key");
		}
		if (!isTrustedCandidateList(candidates)) {
			throw new Error(`Choices JSON holds an invalid candidate list: ${key}`);
		}
		choices[key] = [...candidates];
	}
	return choices;
}

/**
 * Candidate lists shipped with the tool so that a run without `--choices`
 * still answers the choice controls most Japanese inquiry forms use. These are
 * operator-decided values, exactly like a choices file: the model only ever
 * names a payloadKey, and the trusted handler still requires an exact match
 * against the control before entering anything.
 *
 * `privacyConsent` ticks a privacy-policy checkbox. It is included by the
 * operator's decision; `--no-default-choices` drops the whole default set.
 */
export const DEFAULT_CHOICE_CANDIDATES: Record<string, readonly string[]> = {
	inquiryType: [
		"その他",
		"その他のお問い合わせ",
		"その他お問い合わせ",
		"ご意見・ご要望",
		"お問い合わせ",
		"一般のお問い合わせ",
		"その他のご相談",
	],
	contactMethod: [
		"メール",
		"Eメール",
		"E-mail",
		"Email",
		"メールでのご連絡",
		"メールで連絡",
	],
	privacyConsent: ["checked"],
};

/**
 * Overlays a choices file on the defaults key by key, the file winning, and
 * validates the merged result against the same contract a choices file passes.
 * Merging per key keeps a file that only overrides `inquiryType` from silently
 * dropping the other defaults.
 */
export function mergeChoiceCandidates(
	defaults: Record<string, readonly string[]>,
	overrides: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
	return readChoiceCandidates({ ...defaults, ...overrides });
}

export async function buildCampaignJob(
	candidate: CampaignCandidate,
	registrationValues: Record<string, string>,
	campaign: string,
	resolution: RedirectResolution,
	choices: Record<string, readonly string[]> = {},
): Promise<JobInput> {
	const formValues: Record<string, TrustedFormValue> = {
		...registrationValues,
		subject: candidate.subject,
		message: candidate.message,
	};
	for (const [key, candidates] of Object.entries(choices)) {
		// No precedence is defined between a registration value and a choice
		// list, so a collision is an operator mistake rather than a merge.
		if (Object.hasOwn(formValues, key)) {
			throw new Error(`Choice key collides with a registration value: ${key}`);
		}
		formValues[key] = candidates;
	}
	const identity = `${candidate.companyDomain}\n${candidate.targetUrl}`;
	const companyId = `company-${(await sha256(candidate.companyDomain)).slice(0, 24)}`;
	const id = `${safeCampaignName(campaign)}-${(await sha256(`${campaign}\n${identity}`)).slice(0, 32)}`;

	return {
		id,
		companyId,
		companyName: candidate.companyName,
		targetUrl: candidate.targetUrl,
		targetDomain: candidate.companyDomain,
		allowedHosts: normalizeAllowedHosts(resolution.allowedHosts),
		payload: {
			_formAgentDryRun: true,
			_formAgentMaxAttempts: 1,
			campaign,
			sourceRow: candidate.rowNumber,
			formValues,
			instruction:
				"Fill exactly one compatible inquiry form with the supplied formValues. Call submit only after native validation; the trusted dry-run handler must stop before submission.",
		},
	};
}

function exclusionReason(row: CampaignCsvRow): string | null {
	if (row["人間\n目視チェック"]?.trim() !== "TRUE") return "not_reviewed";
	if (row.メール送信ステータス?.trim() || row.フォーム送信ステータス?.trim()) {
		return "already_sent";
	}
	if (BLOCKER_COLUMNS.some((column) => row[column]?.trim())) {
		return "blocked_by_check";
	}

	const url = row.問い合わせフォームURL?.trim();
	if (!url) return "missing_form_url";
	try {
		validatedHttpsUrl(url);
	} catch {
		return "invalid_or_insecure_form_url";
	}
	try {
		normalizeCompanyDomain(row.企業ドメイン?.trim() ?? "");
	} catch {
		return "invalid_company_domain";
	}
	for (const column of ["企業名", "件名", "メール文面"] as const) {
		if (!row[column]?.trim()) return "missing_content";
	}
	return null;
}

export function normalizeCompanyDomain(value: string): string {
	const parsed = parse(value, {
		allowPrivateDomains: true,
		detectSpecialUse: true,
		extractHostname: false,
	});
	if (!parsed.domain) throw new Error("Company domain is invalid");
	return normalizeTargetDomain(parsed.domain);
}

function assertRequiredColumns(row: CampaignCsvRow): void {
	for (const column of REQUIRED_COLUMNS) {
		if (!(column in row)) throw new Error(`CSV column is missing: ${column}`);
	}
}

function required(row: CampaignCsvRow, column: string): string {
	const value = row[column]?.trim();
	if (!value) throw new Error(`CSV value is missing: ${column}`);
	return value;
}

function validatedHttpsUrl(raw: string): URL {
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Only public HTTPS form URLs are allowed");
	}
	normalizeAllowedHosts([url.hostname]);
	return url;
}

function safeCampaignName(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
		throw new Error("Campaign name must be a safe ASCII identifier");
	}
	return value;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
