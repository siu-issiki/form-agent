import { parse } from "csv-parse/sync";
import {
	buildCampaignJob,
	type CampaignCsvRow,
	campaignApiHeaders,
	DEFAULT_CHOICE_CANDIDATES,
	filterCampaignRows,
	mapRegistrationValues,
	mergeChoiceCandidates,
	type RedirectResolution,
	type RegistrationEntry,
	readChoiceCandidates,
	registerCampaignJobs,
	resolveRedirectHosts,
	selectCampaignCandidates,
} from "../src/campaign-import";
import type { JobInput } from "../src/job";
import type { TrustedFormValue } from "../src/restricted-browser";

const PRODUCTION_BASE_URL = "https://form-agent.form-agent.workers.dev";
/** Mirrors the Queue consumer max_concurrency in wrangler.jsonc. */
const QUEUE_MAX_CONCURRENCY = 20;
const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = [
	"prohibited",
	"uncertain",
	"failed",
	"dead_lettered",
];

const options = parseOptions(Bun.argv.slice(2));
const registration = await readRegistration(options.registrationPath);
const choices = mergeChoiceCandidates(
	options.defaultChoices ? DEFAULT_CHOICE_CANDIDATES : {},
	options.choicesPath
		? readChoiceCandidates(await Bun.file(options.choicesPath).json())
		: {},
);
console.log(
	JSON.stringify({
		event: "campaign_choice_summary",
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
const selected = selectCampaignCandidates(
	filtered.eligible,
	options.offset,
	options.limit,
);
console.log(
	JSON.stringify({
		event: "campaign_filter_summary",
		totalRows: rows.length,
		eligibleRows: filtered.eligible.length,
		excluded: filtered.excluded,
		offset: options.offset,
		selectedRows: selected.length,
	}),
);

if (selected.length !== options.limit) {
	throw new Error(
		`Only ${selected.length} eligible rows remain after offset ${options.offset}`,
	);
}

const jobs: JobInput[] = [];
for (const candidate of selected) {
	let resolution: RedirectResolution;
	try {
		resolution = await resolveRedirectHosts(candidate.targetUrl);
	} catch {
		console.log(
			JSON.stringify({
				event: "campaign_preflight_skipped",
				reasonCode: "REDIRECT_PREFLIGHT_FAILED",
			}),
		);
		continue;
	}
	const job = await buildCampaignJob(
		candidate,
		registrationValues,
		options.campaign,
		resolution,
		choices,
	);
	const formValues = job.payload.formValues as Record<string, TrustedFormValue>;
	console.log(
		JSON.stringify({
			event: "campaign_job_preview",
			jobId: job.id,
			companyId: job.companyId,
			formValueKeys: Object.keys(formValues).sort(),
			formValueCount: Object.keys(formValues).length,
			// Only the key count is logged; a candidate list is payload data.
			choiceKeyCount: Object.values(formValues).filter(Array.isArray).length,
			allowedHostCount: job.allowedHosts.length,
			requestBytes: new TextEncoder().encode(JSON.stringify(job)).byteLength,
		}),
	);
	jobs.push(job);
}

if (jobs.length !== options.limit) {
	throw new Error(`Only ${jobs.length} jobs passed redirect preflight`);
}

if (options.submit) {
	const submitted = await registerCampaignJobs(jobs, {
		baseUrl: PRODUCTION_BASE_URL,
		apiToken: options.apiToken,
	});
	const byReasonCode: Record<string, number> = {};
	if (submitted.notRegistered > 0) {
		byReasonCode.REGISTRATION_FAILED = submitted.notRegistered;
	}
	if (submitted.unknown > 0) {
		byReasonCode.REGISTRATION_UNKNOWN = submitted.unknown;
	}
	const completed = await waitForAll(
		submitted.registered,
		options.apiToken,
		byReasonCode,
	);
	console.log(
		JSON.stringify({
			event: "campaign_dry_run_summary",
			selectedJobs: jobs.length,
			completedJobs: completed,
			safeFailures: jobs.length - completed,
			byReasonCode,
		}),
	);
	if (completed !== jobs.length) {
		throw new Error("One or more jobs failed before the dry-run boundary");
	}
}

interface Options {
	registrationPath: string;
	choicesPath: string | undefined;
	csvPath: string;
	campaign: string;
	offset: number;
	limit: number;
	submit: boolean;
	defaultChoices: boolean;
	apiToken: string;
}

function parseOptions(args: string[]): Options {
	const values = new Map<string, string>();
	let submit = false;
	let defaultChoices = true;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--submit-dry-run") {
			submit = true;
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
				"--choices",
				"--csv",
				"--campaign",
				"--offset",
				"--limit",
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

	const registrationPath = requiredOption(values, "registration");
	const csvPath = requiredOption(values, "csv");
	const campaign = requiredOption(values, "campaign");
	const limit = Number(values.get("limit") ?? "5");
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new Error("--limit must be an integer from 1 to 50");
	}
	const offset = Number(values.get("offset") ?? "0");
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error("--offset must be an integer of 0 or more");
	}
	const apiToken = process.env.JOB_API_TOKEN ?? "";
	if (submit && !apiToken)
		throw new Error("JOB_API_TOKEN is required for submission");

	return {
		registrationPath,
		choicesPath: values.get("choices"),
		csvPath,
		campaign,
		offset,
		limit,
		submit,
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

/**
 * Polls every registered job each round instead of draining them one by one.
 * The budget keeps the original four minutes per concurrent batch, because a
 * job queued behind a full batch only starts once one of those finishes.
 */
async function waitForAll(
	jobs: readonly JobInput[],
	apiToken: string,
	byReasonCode: Record<string, number>,
): Promise<number> {
	if (jobs.length === 0) return 0;
	const pending = new Map(jobs.map((job) => [job.id, ""]));
	const deadline =
		Date.now() +
		4 * 60 * 1_000 * Math.ceil(jobs.length / QUEUE_MAX_CONCURRENCY);
	let completed = 0;
	while (pending.size > 0 && Date.now() < deadline) {
		for (const [jobId, lastStatus] of [...pending]) {
			const state = await readJobState(jobId, apiToken);
			// A lookup failure is transient here; the job stays pending and is read
			// again next round, and the deadline still bounds the wait.
			if (!state) continue;
			if (state.status !== lastStatus) {
				pending.set(jobId, state.status);
				console.log(
					JSON.stringify({
						event: "campaign_job_status",
						jobId,
						status: state.status,
						attemptCount: state.attemptCount,
					}),
				);
			}
			if (state.status === "submitting" || state.status === "sent") {
				throw new Error(`Dry-run entered unsafe status ${state.status}`);
			}
			if (!TERMINAL_STATUSES.includes(state.status)) continue;
			const reasonCode = state.result?.reasonCode ?? "NO_REASON";
			const jobCompleted =
				state.status === "prohibited" &&
				reasonCode === "DRY_RUN_COMPLETE" &&
				state.attemptCount === 1;
			if (jobCompleted) completed += 1;
			byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;
			pending.delete(jobId);
			console.log(
				JSON.stringify({
					event: "campaign_job_result",
					jobId,
					completed: jobCompleted,
					status: state.status,
					reasonCode,
					attemptCount: state.attemptCount,
				}),
			);
		}
		if (pending.size > 0) await Bun.sleep(POLL_INTERVAL_MS);
	}
	for (const [jobId, lastStatus] of pending) {
		byReasonCode.DRY_RUN_TIMED_OUT = (byReasonCode.DRY_RUN_TIMED_OUT ?? 0) + 1;
		console.log(
			JSON.stringify({
				event: "campaign_job_result",
				jobId,
				completed: false,
				status: lastStatus || "unknown",
				reasonCode: "DRY_RUN_TIMED_OUT",
				attemptCount: 0,
			}),
		);
	}
	return completed;
}

interface JobState {
	status: string;
	attemptCount: number;
	result: { reasonCode: string | null } | null;
}

async function readJobState(
	jobId: string,
	apiToken: string,
): Promise<JobState | null> {
	try {
		const response = await fetch(`${PRODUCTION_BASE_URL}/jobs/${jobId}`, {
			headers: campaignApiHeaders(apiToken),
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel();
			console.log(
				JSON.stringify({
					event: "campaign_job_lookup_failed",
					jobId,
					status: response.status,
				}),
			);
			return null;
		}
		const body = (await response.json()) as { job: JobState };
		return body.job;
	} catch {
		// A lookup failure here — including a fetch that throws or a response
		// body that fails to parse — is transient; the job stays pending and is
		// read again next round. Fixed values only: the failure reason may carry
		// a URL or a host.
		console.log(
			JSON.stringify({
				event: "campaign_job_lookup_failed",
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
