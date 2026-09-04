import { parse } from "csv-parse/sync";
import {
	buildCampaignJob,
	type CampaignCsvRow,
	campaignApiHeaders,
	DEFAULT_CHOICE_CANDIDATES,
	filterCampaignRows,
	jobContentFingerprint,
	mapRegistrationValues,
	mergeChoiceCandidates,
	type RedirectResolution,
	type RegistrationEntry,
	readChoiceCandidates,
	readSendApprovalFile,
	registerCampaignJobs,
	resolveRedirectHosts,
	type SendApprovalEntry,
	type SendApprovalFile,
} from "../src/campaign-import";
import type { JobInput } from "../src/job";

const PRODUCTION_BASE_URL = "https://form-agent.form-agent.workers.dev";
/** Mirrors the Queue consumer max_concurrency in wrangler.jsonc. */
const QUEUE_MAX_CONCURRENCY = 20;
const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = [
	"sent",
	"prohibited",
	"uncertain",
	"failed",
	"dead_lettered",
];
/** Outcomes that need no human follow-up; anything else exits non-zero. */
const ACCEPTED_STATUSES = ["sent", "prohibited"];
const DEFAULT_MAX_SENDS = 5;
const MAX_MAX_SENDS = 50;

const options = parseOptions(Bun.argv.slice(2));
const registration = await readRegistration(options.registrationPath);
const approval = readSendApprovalFile(
	await Bun.file(options.approvedPath).json(),
	options.maxSends,
);
const choices = mergeChoiceCandidates(
	options.defaultChoices ? DEFAULT_CHOICE_CANDIDATES : {},
	options.choicesPath
		? readChoiceCandidates(await Bun.file(options.choicesPath).json())
		: {},
);
console.log(
	JSON.stringify({
		event: "campaign_send_choice_summary",
		defaultChoices: options.defaultChoices,
		overrideFile: options.choicesPath !== undefined,
		// Only the keys are logged; the candidate labels are payload data.
		choiceKeys: Object.keys(choices).sort(),
	}),
);

const csvText = await Bun.file(options.csvPath).text();
const rows = parse(csvText, {
	columns: true,
	skip_empty_lines: true,
}) as CampaignCsvRow[];
const filtered = filterCampaignRows(rows);
const registrationValues = mapRegistrationValues(registration);
const eligibleByRow = new Map(
	filtered.eligible.map((candidate) => [candidate.rowNumber, candidate]),
);
console.log(
	JSON.stringify({
		event: "campaign_send_filter_summary",
		totalRows: rows.length,
		eligibleRows: filtered.eligible.length,
		excluded: filtered.excluded,
		approvedEntries: approval.entries.length,
		maxSends: options.maxSends,
	}),
);

const byReasonCode: Record<string, number> = {};
const jobs: JobInput[] = [];
for (const entry of approval.entries) {
	const job = await buildApprovedJob(entry);
	if (job) jobs.push(job);
}

const submitted = await registerCampaignJobs(jobs, {
	baseUrl: PRODUCTION_BASE_URL,
	apiToken: options.apiToken,
	realSend: true,
});
if (submitted.notRegistered > 0) {
	byReasonCode.REGISTRATION_FAILED = submitted.notRegistered;
}
if (submitted.unknown > 0) {
	byReasonCode.REGISTRATION_UNKNOWN = submitted.unknown;
}

const accepted = await waitForAll(submitted.registered);
console.log(
	JSON.stringify({
		event: "campaign_send_summary",
		approvedEntries: approval.entries.length,
		registeredJobs: submitted.registered.length,
		acceptedJobs: accepted.sent + accepted.prohibited,
		sentJobs: accepted.sent,
		prohibitedJobs: accepted.prohibited,
		needsReview: approval.entries.length - accepted.sent - accepted.prohibited,
		byReasonCode,
	}),
);
if (accepted.sent + accepted.prohibited !== approval.entries.length) {
	process.exit(1);
}

/**
 * Builds one real-send job from an approved row. Every refusal is counted and
 * reported instead of throwing, so one bad entry does not hide the outcome of
 * the entries around it.
 */
async function buildApprovedJob(
	entry: SendApprovalEntry,
): Promise<JobInput | null> {
	const candidate = eligibleByRow.get(entry.sourceRow);
	if (!candidate) {
		count("ROW_NOT_ELIGIBLE", entry.sourceRow);
		return null;
	}

	let resolution: RedirectResolution;
	try {
		resolution = await resolveRedirectHosts(candidate.targetUrl);
	} catch {
		count("REDIRECT_PREFLIGHT_FAILED", entry.sourceRow);
		return null;
	}

	const job = await buildCampaignJob(
		candidate,
		registrationValues,
		options.campaign,
		resolution,
		choices,
		{
			dryRun: false,
			approval: approvalRecord(approval, entry),
		},
	);
	if (!(await hasCompletedDryRun(entry, job))) {
		count("APPROVAL_MISMATCH", entry.sourceRow);
		return null;
	}
	console.log(
		JSON.stringify({
			event: "campaign_send_job_preview",
			jobId: job.id,
			companyId: job.companyId,
			sourceRow: entry.sourceRow,
			dryRunJobId: entry.dryRunJobId,
			formValueCount: Object.keys(job.payload.formValues as object).length,
			allowedHostCount: job.allowedHosts.length,
		}),
	);
	return job;
}

/**
 * Confirms the approved dry-run job really covers this send: the same content
 * fingerprint (form URL, company, and every form value), a run that was itself
 * a dry-run, and a result that reached the dry-run boundary. The Worker repeats
 * the same comparison; this one keeps a mismatched row out of the batch instead
 * of turning it into a 400. A lookup that cannot be completed counts as a
 * mismatch, so an unreachable API never turns into a send.
 */
async function hasCompletedDryRun(
	entry: SendApprovalEntry,
	job: JobInput,
): Promise<boolean> {
	const state = await readJobState(entry.dryRunJobId);
	if (!state) return false;
	if (
		state.targetUrl !== job.targetUrl ||
		state.payload?._formAgentEffectiveDryRun === false ||
		state.status !== "prohibited" ||
		state.result?.reasonCode !== "DRY_RUN_COMPLETE"
	) {
		return false;
	}
	const [approved, requested] = await Promise.all([
		jobContentFingerprint(state.targetUrl, state.companyId, state.payload),
		jobContentFingerprint(job.targetUrl, job.companyId, job.payload),
	]);
	return approved === requested;
}

function approvalRecord(file: SendApprovalFile, entry: SendApprovalEntry) {
	return {
		approvedBy: file.approvedBy,
		approvedAt: file.approvedAt,
		dryRunJobId: entry.dryRunJobId,
		...(entry.note === undefined ? {} : { note: entry.note }),
	};
}

function count(reasonCode: string, sourceRow: number): void {
	byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;
	console.log(
		JSON.stringify({
			event: "campaign_send_entry_skipped",
			sourceRow,
			reasonCode,
		}),
	);
}

interface Options {
	registrationPath: string;
	approvedPath: string;
	choicesPath: string | undefined;
	csvPath: string;
	campaign: string;
	maxSends: number;
	defaultChoices: boolean;
	apiToken: string;
}

function parseOptions(args: string[]): Options {
	const values = new Map<string, string>();
	let confirmed = false;
	let defaultChoices = true;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--confirm-real-send") {
			confirmed = true;
			continue;
		}
		if (arg === "--no-default-choices") {
			defaultChoices = false;
			continue;
		}
		if (!arg?.startsWith("--")) throw new Error("Invalid argument");
		if (
			![
				"--registration",
				"--approved",
				"--choices",
				"--csv",
				"--campaign",
				"--max-sends",
			].includes(arg)
		) {
			throw new Error(`Unknown argument: ${arg}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value: ${arg}`);
		values.set(arg.slice(2), value);
		index += 1;
	}

	// Checked before anything else is validated or read, so a run without the
	// flag never touches the CSV, the approval file, or the API.
	if (!confirmed) {
		console.error(
			"--confirm-real-send is required; this tool submits real inquiry forms.",
		);
		process.exit(1);
	}

	const maxSends = Number(values.get("max-sends") ?? String(DEFAULT_MAX_SENDS));
	if (!Number.isInteger(maxSends) || maxSends < 1 || maxSends > MAX_MAX_SENDS) {
		throw new Error(
			`--max-sends must be an integer from 1 to ${MAX_MAX_SENDS}`,
		);
	}
	const apiToken = process.env.JOB_API_TOKEN ?? "";
	if (!apiToken) throw new Error("JOB_API_TOKEN is required for a real send");

	return {
		registrationPath: requiredOption(values, "registration"),
		approvedPath: requiredOption(values, "approved"),
		choicesPath: values.get("choices"),
		csvPath: requiredOption(values, "csv"),
		campaign: requiredOption(values, "campaign"),
		maxSends,
		defaultChoices,
		apiToken,
	};
}

async function readRegistration(path: string): Promise<RegistrationEntry[]> {
	const value: unknown = await Bun.file(path).json();
	if (
		!Array.isArray(value) ||
		!value.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as RegistrationEntry).label === "string" &&
				typeof (entry as RegistrationEntry).value === "string",
		)
	) {
		throw new Error("Registration JSON must contain label/value entries");
	}
	return value as RegistrationEntry[];
}

interface SendCounts {
	sent: number;
	prohibited: number;
}

/**
 * Polls every registered job each round, exactly like the dry-run tool. A real
 * send has no safe status to abort on: `submitting` and `sent` are the point of
 * the run, so the wait only ends at a terminal status or the deadline.
 */
async function waitForAll(jobs: readonly JobInput[]): Promise<SendCounts> {
	const counts: SendCounts = { sent: 0, prohibited: 0 };
	if (jobs.length === 0) return counts;

	const pending = new Map(jobs.map((job) => [job.id, ""]));
	const deadline =
		Date.now() +
		4 * 60 * 1_000 * Math.ceil(jobs.length / QUEUE_MAX_CONCURRENCY);
	while (pending.size > 0 && Date.now() < deadline) {
		for (const [jobId, lastStatus] of [...pending]) {
			const state = await readJobState(jobId);
			// A lookup failure is transient here; the job stays pending and is read
			// again next round, and the deadline still bounds the wait.
			if (!state) continue;
			if (state.status !== lastStatus) {
				pending.set(jobId, state.status);
				console.log(
					JSON.stringify({
						event: "campaign_send_job_status",
						jobId,
						status: state.status,
						attemptCount: state.attemptCount,
					}),
				);
			}
			if (!TERMINAL_STATUSES.includes(state.status)) continue;

			const reasonCode =
				state.status === "sent"
					? "SENT"
					: (state.result?.reasonCode ?? "NO_REASON");
			if (state.status === "sent") counts.sent += 1;
			if (state.status === "prohibited") counts.prohibited += 1;
			byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;
			pending.delete(jobId);
			console.log(
				JSON.stringify({
					event: "campaign_send_job_result",
					jobId,
					accepted: ACCEPTED_STATUSES.includes(state.status),
					status: state.status,
					reasonCode,
					attemptCount: state.attemptCount,
				}),
			);
		}
		if (pending.size > 0) await Bun.sleep(POLL_INTERVAL_MS);
	}

	for (const [jobId, lastStatus] of pending) {
		byReasonCode.SEND_TIMED_OUT = (byReasonCode.SEND_TIMED_OUT ?? 0) + 1;
		console.log(
			JSON.stringify({
				event: "campaign_send_job_result",
				jobId,
				accepted: false,
				status: lastStatus || "unknown",
				reasonCode: "SEND_TIMED_OUT",
				attemptCount: 0,
			}),
		);
	}
	return counts;
}

interface JobState {
	status: string;
	attemptCount: number;
	targetUrl: string;
	companyId: string;
	payload: Record<string, unknown> | null;
	result: { reasonCode: string | null } | null;
}

async function readJobState(jobId: string): Promise<JobState | null> {
	try {
		const response = await fetch(`${PRODUCTION_BASE_URL}/jobs/${jobId}`, {
			headers: campaignApiHeaders(options.apiToken),
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel();
			console.log(
				JSON.stringify({
					event: "campaign_send_job_lookup_failed",
					jobId,
					status: response.status,
				}),
			);
			return null;
		}
		const body = (await response.json()) as { job: JobState };
		return body.job;
	} catch {
		// Fixed values only: the failure reason may carry a URL or a host.
		console.log(
			JSON.stringify({
				event: "campaign_send_job_lookup_failed",
				jobId,
				reason: "REQUEST_FAILED",
			}),
		);
		return null;
	}
}

function requiredOption(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}
