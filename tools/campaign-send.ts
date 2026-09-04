import {
	buildCampaignJob,
	jobContentFingerprint,
	mapRegistrationValues,
	type RedirectResolution,
	readSendApprovalFile,
	registerCampaignJobs,
	resolveRedirectHosts,
	type SendApprovalEntry,
	type SendApprovalFile,
} from "../src/campaign-import";
import {
	EFFECTIVE_DRY_RUN_KEY,
	type JobInput,
	type JobStatus,
	TERMINAL_JOB_STATUSES,
} from "../src/job";
import {
	loadChoiceCandidates,
	PRODUCTION_BASE_URL,
	pollJobsUntilTerminal,
	readCampaignRows,
	readJobState,
	readRegistration,
	requiredOption,
} from "./campaign-common";

/** Log event prefix; the shared poller derives every job event name from it. */
const EVENT_PREFIX = "campaign_send_job";
/** Outcomes that need no human follow-up; anything else exits non-zero. */
const ACCEPTED_STATUSES: readonly JobStatus[] = ["sent", "prohibited"];
const DEFAULT_MAX_SENDS = 5;
const MAX_MAX_SENDS = 50;

const options = parseOptions(Bun.argv.slice(2));
const registration = await readRegistration(options.registrationPath);
const approval = readSendApprovalFile(
	await Bun.file(options.approvedPath).json(),
	options.maxSends,
);
const choices = await loadChoiceCandidates({
	eventPrefix: "campaign_send",
	defaultChoices: options.defaultChoices,
	choicesPath: options.choicesPath,
});

const { rows, filtered } = await readCampaignRows(options.csvPath);
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
		upgradedToHttps: filtered.upgradedToHttps,
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
	const state = await readJobState(
		entry.dryRunJobId,
		options.apiToken,
		EVENT_PREFIX,
	);
	if (!state) return false;
	if (
		state.targetUrl !== job.targetUrl ||
		state.payload?.[EFFECTIVE_DRY_RUN_KEY] === false ||
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

interface SendCounts {
	sent: number;
	prohibited: number;
}

/**
 * Waits for every registered job, exactly like the dry-run tool. A real send
 * has no safe status to abort on: `submitting` and `sent` are the point of the
 * run, so the wait only ends at a terminal status or the deadline.
 */
async function waitForAll(jobs: readonly JobInput[]): Promise<SendCounts> {
	const counts: SendCounts = { sent: 0, prohibited: 0 };
	await pollJobsUntilTerminal({
		jobs,
		apiToken: options.apiToken,
		eventPrefix: EVENT_PREFIX,
		terminalStatuses: TERMINAL_JOB_STATUSES,
		onTerminal: (_jobId, state) => {
			const reasonCode =
				state.status === "sent"
					? "SENT"
					: (state.result?.reasonCode ?? "NO_REASON");
			if (state.status === "sent") counts.sent += 1;
			if (state.status === "prohibited") counts.prohibited += 1;
			byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;
			return {
				reasonCode,
				extra: { accepted: ACCEPTED_STATUSES.includes(state.status) },
			};
		},
		onTimedOut: () => {
			byReasonCode.SEND_TIMED_OUT = (byReasonCode.SEND_TIMED_OUT ?? 0) + 1;
			return { reasonCode: "SEND_TIMED_OUT", extra: { accepted: false } };
		},
	});
	return counts;
}
