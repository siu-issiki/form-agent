import { parse } from "tldts";
import { JOB_ID_PATTERN, type JobInput } from "./job";
import { jobContentFingerprint, jobInputFingerprint } from "./job-fingerprint";
import {
	isTrustedCandidateList,
	normalizeAllowedHosts,
	normalizeTargetDomain,
	PAYLOAD_KEY_PATTERN,
	type TrustedFormValue,
} from "./restricted-browser";
import {
	isIso8601,
	isSendApproval,
	SEND_APPROVAL_KEY,
	type SendApproval,
} from "./send-approval";

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

/**
 * The three columns of the simple CSV layout. A file that carries all of them
 * is read as the simple layout; anything else has to satisfy the full column
 * contract above.
 */
const SIMPLE_COLUMNS = ["問い合わせリンク", "件名", "本文"] as const;

/** Carried twice in a registration file: as written, then digits only. */
const PHONE_LABEL = "電話番号";

/**
 * Every label a registration file may use for a given form key, most preferred
 * first. Sources differ in wording ("氏名（フルネーム漢字）" against
 * "フルネーム漢字", "電話1" against "電話番号1"), so the mapping matches on the
 * label rather than on position, and an alias never wins over the canonical
 * label when both are present.
 *
 * `phoneDigits` has no label of its own: it is the second "電話番号" entry, the
 * digits-only spelling of the same number.
 */
const REGISTRATION_LABELS: Array<[string, readonly string[]]> = [
	["lastName", ["苗字"]],
	["firstName", ["名前"]],
	["lastNameKatakana", ["苗字（カナ）", "苗字（カタカナ）"]],
	["firstNameKatakana", ["名前（カナ）", "名前（カタカナ）"]],
	["lastNameHiragana", ["苗字（かな）"]],
	["firstNameHiragana", ["名前（かな）"]],
	["fullName", ["フルネーム漢字", "氏名（フルネーム漢字）"]],
	[
		"fullNameKatakana",
		["フルネームカタカナ", "氏名（フルネームカタカナ）", "フリガナ"],
	],
	[
		"fullNameHiragana",
		["フルネームひらがな", "氏名（フルネームひらがな）", "ふりがな"],
	],
	["address", ["住所"]],
	["addressPart1", ["住所1"]],
	["addressPart2", ["住所2"]],
	["addressPart3", ["住所3"]],
	["phone", [PHONE_LABEL]],
	["phonePart1", ["電話番号1", "電話1"]],
	["phonePart2", ["電話番号2", "電話2"]],
	["phonePart3", ["電話番号3", "電話3"]],
	["postalCode", ["郵便番号"]],
	["postalCodePart1", ["郵便番号1"]],
	["postalCodePart2", ["郵便番号2"]],
	["companyWebsite", ["会社HP"]],
	["email", ["メールアドレス"]],
	["companyName", ["会社名"]],
	["department", ["部署", "部署名"]],
	["jobTitle", ["役職"]],
	["age", ["年齢"]],
];

const KNOWN_REGISTRATION_LABELS = new Set(
	REGISTRATION_LABELS.flatMap(([, labels]) => labels),
);

/** Without these no inquiry form can be filled, so their absence is an error. */
const REQUIRED_REGISTRATION_KEYS = [
	"fullName",
	"lastName",
	"firstName",
	"email",
	"phone",
	"companyName",
] as const;

export interface RegistrationMappingOptions {
	/** Receives fixed-field log entries; the default writes them as JSON lines. */
	log?: (entry: Record<string, unknown>) => void;
}

/**
 * Turns a registration file into safe ASCII form keys. Entries are matched by
 * label, so a file may carry the fields in any order, use a known alias, and
 * hold labels this tool has no key for. An unknown label is ignored rather than
 * refused, because registration files keep gaining columns; only the count
 * reaches the log, never the label itself.
 */
export function mapRegistrationValues(
	entries: readonly RegistrationEntry[],
	options: RegistrationMappingOptions = {},
): Record<string, string> {
	const log =
		options.log ??
		((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));

	const byLabel = new Map<string, string[]>();
	let unknownLabels = 0;
	for (const entry of entries) {
		const label = entry.label.trim();
		const value = entry.value.trim();
		if (!value) continue;
		if (!KNOWN_REGISTRATION_LABELS.has(label)) {
			unknownLabels += 1;
			continue;
		}
		const seen = byLabel.get(label);
		if (seen) seen.push(value);
		else byLabel.set(label, [value]);
	}

	const values: Record<string, string> = {};
	for (const [key, labels] of REGISTRATION_LABELS) {
		for (const label of labels) {
			const value = byLabel.get(label)?.[0];
			if (value) {
				values[key] = value;
				break;
			}
		}
	}
	const phones = byLabel.get(PHONE_LABEL) ?? [];
	// The second "電話番号" is the digits-only spelling. A file that carries one
	// number uses it for both keys rather than leaving the digits-only key out.
	const phoneDigits = phones[1] ?? phones[0];
	if (phoneDigits) values.phoneDigits = phoneDigits;

	const missing = REQUIRED_REGISTRATION_KEYS.filter((key) => !values[key]);
	if (missing.length > 0) {
		// The key names are this tool's own ASCII identifiers, not file content.
		throw new Error(
			`Registration data is missing required fields: ${missing.join(", ")}`,
		);
	}

	log({
		event: "campaign_registration_summary",
		mappedKeys: Object.keys(values).length,
		unknownLabels,
	});
	return values;
}

export function filterCampaignRows(
	rows: readonly CampaignCsvRow[],
): CampaignFilterResult {
	const header = rows[0] ?? {};
	const simple = rows.length > 0 && isSimpleLayout(header);
	if (rows.length > 0 && !simple) assertRequiredColumns(header);
	const eligible: CampaignCandidate[] = [];
	const excluded: Record<string, number> = {};

	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index] ?? {};
		// The header itself is row 1, so the first data row is row 2 in both
		// layouts; `sourceRow` names the same line an operator sees in the file.
		const rowNumber = index + 2;
		const outcome = simple
			? simpleRowOutcome(row, rowNumber)
			: fullRowOutcome(row, rowNumber);
		if ("reason" in outcome) {
			excluded[outcome.reason] = (excluded[outcome.reason] ?? 0) + 1;
			continue;
		}
		eligible.push(outcome.candidate);
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
 * Narrower than `typeof fetch` so a test can supply a plain function; `fetch`
 * itself is assignable to it.
 */
export type CampaignFetcher = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface CampaignRegistrationOptions {
	baseUrl: string;
	apiToken: string;
	fetcher?: CampaignFetcher;
	/** Receives fixed-field log entries; the default writes them as JSON lines. */
	log?: (entry: Record<string, unknown>) => void;
	/**
	 * Registers real-send jobs instead of dry-runs. The default refuses any job
	 * without the job-level dry-run guard, so the dry-run tool cannot register a
	 * job that submits.
	 */
	realSend?: boolean;
}

export interface CampaignRegistrationResult {
	registered: JobInput[];
	/** Jobs the API is known not to hold: rejected, 404, or never attempted. */
	notRegistered: number;
	/** Jobs whose registration could neither be confirmed nor ruled out. */
	unknown: number;
}

export function campaignApiHeaders(apiToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${apiToken}`,
		"content-type": "application/json",
	};
}

export { jobContentFingerprint, jobInputFingerprint };

/**
 * Confirms whether the API already holds this exact job. Job ids are derived
 * from the campaign, company domain, and form URL, so a registration whose
 * response was lost can be resolved by asking for the id rather than posting
 * again, which would risk a second queued run of the same company.
 *
 * A stored job under the same id whose inputs differ is treated as unconfirmed
 * rather than as this registration: it means the same campaign name was reused
 * with different values, and the queued run would send content this invocation
 * never built.
 */
export async function confirmJobRegistration(
	job: JobInput,
	options: CampaignRegistrationOptions,
): Promise<"registered" | "mismatched" | "not_found" | "unknown"> {
	const fetcher = options.fetcher ?? fetch;
	let body: unknown;
	try {
		const response = await fetcher(`${options.baseUrl}/jobs/${job.id}`, {
			headers: campaignApiHeaders(options.apiToken),
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel();
			return response.status === 404 ? "not_found" : "unknown";
		}
		body = await response.json();
	} catch {
		return "unknown";
	}
	if (!isPlainRecord(body) || !isPlainRecord(body.job)) return "unknown";
	const stored = body.job;
	const realSend = job.payload._formAgentDryRun === false;
	// Only the stored side carries the effective mode, so it is checked here
	// rather than inside the digest. A dry-run job under the same id is not
	// this registration: the queued run would send nothing.
	if (
		realSend &&
		(!isPlainRecord(stored.payload) ||
			stored.payload._formAgentEffectiveDryRun !== false)
	) {
		return "mismatched";
	}
	const [expected, actual] = await Promise.all([
		jobInputFingerprint(job.targetUrl, job.payload, realSend),
		jobInputFingerprint(stored.targetUrl, stored.payload, realSend),
	]);
	return expected === actual ? "registered" : "mismatched";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Last check before a job leaves the tool. A dry-run registration refuses any
 * job that could submit, and a real-send registration refuses any job that is
 * not explicitly marked as a send and does not carry its approval record.
 */
function assertRegisterableJob(job: JobInput, realSend: boolean): void {
	if (!realSend) {
		if (job.payload._formAgentDryRun !== true) {
			throw new Error("Job-level dry-run guard is missing");
		}
		return;
	}
	if (job.payload._formAgentDryRun !== false) {
		throw new Error("Real-send job must set the dry-run flag to false");
	}
	if (!isSendApproval(job.payload[SEND_APPROVAL_KEY])) {
		throw new Error("Real-send job is missing its approval record");
	}
}

/** One approved CSV row, naming the dry-run it already passed. */
export interface SendApprovalEntry {
	/** `sourceRow` of the dry-run job: the 1-based CSV line, header included. */
	sourceRow: number;
	dryRunJobId: string;
	note?: string;
}

export interface SendApprovalFile {
	approvedBy: string;
	approvedAt: string;
	entries: SendApprovalEntry[];
}

const MAX_APPROVED_BY_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;

/**
 * Validates the approval file the send tool is given. Every entry has to name
 * both a CSV row and the dry-run job that row already passed, and the file may
 * not hold more entries than the run's own send limit. Duplicate rows and
 * duplicate dry-run jobs are refused, because either would let one approval
 * stand for a second send.
 */
export function readSendApprovalFile(
	value: unknown,
	maxEntries: number,
): SendApprovalFile {
	if (!isPlainRecord(value)) {
		throw new Error("Approval JSON must be an object");
	}
	const { approvedBy, approvedAt, entries } = value;
	if (
		typeof approvedBy !== "string" ||
		approvedBy.trim().length === 0 ||
		approvedBy.length > MAX_APPROVED_BY_LENGTH
	) {
		throw new Error("Approval JSON needs approvedBy of 1 to 64 characters");
	}
	if (!isIso8601(approvedAt)) {
		throw new Error("Approval JSON needs an ISO 8601 approvedAt");
	}
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new Error("Approval JSON needs at least one entry");
	}
	if (entries.length > maxEntries) {
		throw new Error(
			`Approval JSON holds ${entries.length} entries, above the limit of ${maxEntries}`,
		);
	}

	const rows = new Set<number>();
	const dryRunJobIds = new Set<string>();
	const validated: SendApprovalEntry[] = [];
	for (const entry of entries) {
		if (!isPlainRecord(entry)) {
			throw new Error("Approval JSON holds an entry that is not an object");
		}
		const { sourceRow, dryRunJobId, note } = entry;
		if (!Number.isInteger(sourceRow) || (sourceRow as number) < 2) {
			throw new Error("Approval entry needs a sourceRow of 2 or more");
		}
		if (typeof dryRunJobId !== "string" || !JOB_ID_PATTERN.test(dryRunJobId)) {
			throw new Error("Approval entry needs a valid dryRunJobId");
		}
		if (
			note !== undefined &&
			(typeof note !== "string" || note.length > MAX_NOTE_LENGTH)
		) {
			throw new Error("Approval entry note must be 200 characters or fewer");
		}
		if (rows.has(sourceRow as number)) {
			throw new Error("Approval JSON holds a duplicate sourceRow");
		}
		if (dryRunJobIds.has(dryRunJobId)) {
			throw new Error("Approval JSON holds a duplicate dryRunJobId");
		}
		rows.add(sourceRow as number);
		dryRunJobIds.add(dryRunJobId);
		validated.push({
			sourceRow: sourceRow as number,
			dryRunJobId,
			...(note === undefined ? {} : { note }),
		});
	}

	return { approvedBy, approvedAt, entries: validated };
}

/**
 * Registers every job without waiting for it to finish, so the Queue consumer
 * runs up to its own max_concurrency instead of one job at a time. Registering
 * is the last step before the dry-run boundary, so any failure stops further
 * registrations while the jobs already accepted are still followed.
 *
 * A `fetch` that throws leaves the outcome unknown rather than failed: the
 * request may have reached the API. That job is looked up by its deterministic
 * id and counted as registered, not registered, or unconfirmed accordingly.
 */
export async function registerCampaignJobs(
	jobs: readonly JobInput[],
	options: CampaignRegistrationOptions,
): Promise<CampaignRegistrationResult> {
	const fetcher = options.fetcher ?? fetch;
	const log =
		options.log ??
		((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
	const registered: JobInput[] = [];
	let unknown = 0;
	for (const job of jobs) {
		assertRegisterableJob(job, options.realSend === true);
		let created: Response;
		try {
			created = await fetcher(`${options.baseUrl}/jobs`, {
				method: "POST",
				headers: campaignApiHeaders(options.apiToken),
				body: JSON.stringify(job),
				redirect: "manual",
			});
		} catch {
			// Fixed values only: the failure reason may carry a URL or a host.
			log({
				event: "campaign_job_registration_unconfirmed",
				jobId: job.id,
				reason: "REQUEST_FAILED",
			});
			const outcome = await confirmJobRegistration(job, options);
			log({
				event: "campaign_job_registration_checked",
				jobId: job.id,
				outcome,
			});
			if (outcome === "registered") registered.push(job);
			// A stored job whose inputs differ is not this registration, and it
			// cannot be ruled out either, so it stays unconfirmed.
			if (outcome === "unknown" || outcome === "mismatched") unknown += 1;
			break;
		}
		await created.body?.cancel();
		if (created.status !== 200 && created.status !== 201) {
			log({
				event: "campaign_job_registration_failed",
				jobId: job.id,
				status: created.status,
			});
			break;
		}
		registered.push(job);
		log({ event: "campaign_job_registered", jobId: job.id });
	}
	return {
		registered,
		notRegistered: jobs.length - registered.length - unknown,
		unknown,
	};
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

export interface CampaignJobMode {
	/**
	 * Defaults to a dry-run job. A real-send job is only ever built from the
	 * send tool, and only with the approval record that names the dry-run the
	 * same row already passed.
	 */
	dryRun?: boolean;
	approval?: SendApproval;
}

const DRY_RUN_INSTRUCTION =
	"Fill exactly one compatible inquiry form with the supplied formValues. Call submit only after native validation; the trusted dry-run handler must stop before submission.";
const SEND_INSTRUCTION =
	"Fill exactly one compatible inquiry form with the supplied formValues and submit it once. Call submit only after native validation, and stop without submitting if the form prohibits sales outreach.";

export async function buildCampaignJob(
	candidate: CampaignCandidate,
	registrationValues: Record<string, string>,
	campaign: string,
	resolution: RedirectResolution,
	choices: Record<string, readonly string[]> = {},
	mode: CampaignJobMode = {},
): Promise<JobInput> {
	const dryRun = mode.dryRun ?? true;
	if (dryRun && mode.approval) {
		throw new Error("A dry-run job must not carry a send approval");
	}
	if (!dryRun && !isSendApproval(mode.approval)) {
		throw new Error("A real-send job requires a valid send approval");
	}
	const formValues: Record<string, TrustedFormValue> = {
		...registrationValues,
		// An empty subject is not a trusted payload string (see
		// isTrustedPayloadString), and the simple CSV layout allows a blank
		// subject column, so omit the key entirely rather than send "".
		...(candidate.subject ? { subject: candidate.subject } : {}),
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
			_formAgentDryRun: dryRun,
			_formAgentMaxAttempts: 1,
			...(mode.approval ? { [SEND_APPROVAL_KEY]: mode.approval } : {}),
			campaign,
			sourceRow: candidate.rowNumber,
			formValues,
			instruction: dryRun ? DRY_RUN_INSTRUCTION : SEND_INSTRUCTION,
		},
	};
}

type RowOutcome = { candidate: CampaignCandidate } | { reason: string };

function isSimpleLayout(row: CampaignCsvRow): boolean {
	return SIMPLE_COLUMNS.every((column) => column in row);
}

/**
 * Reads one row of the simple layout. It carries no company columns and no
 * review columns, so the company is taken from the form URL itself and the NG
 * checks of the full layout are not applied.
 */
function simpleRowOutcome(row: CampaignCsvRow, rowNumber: number): RowOutcome {
	const targetUrl = row.問い合わせリンク?.trim();
	if (!targetUrl) return { reason: "missing_form_url" };
	let url: URL;
	try {
		url = validatedHttpsUrl(targetUrl);
	} catch {
		return { reason: "invalid_or_insecure_form_url" };
	}
	let companyDomain: string;
	try {
		companyDomain = normalizeCompanyDomain(url.hostname);
	} catch {
		return { reason: "invalid_company_domain" };
	}
	// A blank subject is eligible: the form itself may have no subject field,
	// or one that isn't required. A blank body is never eligible.
	const subject = row.件名?.trim() ?? "";
	const message = row.本文?.trim();
	if (!message) return { reason: "empty_message" };
	return {
		candidate: {
			rowNumber,
			// No company column exists in this layout. The host is only a label:
			// the job's `companyId` is derived from the registrable domain.
			companyName: url.hostname,
			companyDomain,
			targetUrl,
			subject,
			message,
		},
	};
}

function fullRowOutcome(row: CampaignCsvRow, rowNumber: number): RowOutcome {
	const reason = exclusionReason(row);
	if (reason) return { reason };
	return {
		candidate: {
			rowNumber,
			companyName: required(row, "企業名"),
			companyDomain: normalizeCompanyDomain(required(row, "企業ドメイン")),
			targetUrl: required(row, "問い合わせフォームURL"),
			subject: required(row, "件名"),
			message: required(row, "メール文面"),
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
