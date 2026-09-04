import { parse } from "csv-parse/sync";
import {
	type CampaignCsvRow,
	type CampaignFilterResult,
	campaignApiHeaders,
	DEFAULT_CHOICE_CANDIDATES,
	filterCampaignRows,
	mergeChoiceCandidates,
	type RegistrationEntry,
	readChoiceCandidates,
} from "../src/campaign-import";
import type { JobInput, JobStatus } from "../src/job";

export const PRODUCTION_BASE_URL = "https://form-agent.form-agent.workers.dev";
/** Mirrors the Queue consumer max_concurrency in wrangler.jsonc. */
export const QUEUE_MAX_CONCURRENCY = 20;
export const POLL_INTERVAL_MS = 2_000;

export function requiredOption(
	values: Map<string, string>,
	name: string,
): string {
	const value = values.get(name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

export async function readRegistration(
	path: string,
): Promise<RegistrationEntry[]> {
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
 * Builds the choice candidate map from the built-in defaults and an optional
 * override file, and reports what went into it. Only the keys are logged; the
 * candidate labels are payload data.
 */
export async function loadChoiceCandidates(options: {
	eventPrefix: string;
	defaultChoices: boolean;
	choicesPath: string | undefined;
}): Promise<Record<string, readonly string[]>> {
	const choices = mergeChoiceCandidates(
		options.defaultChoices ? DEFAULT_CHOICE_CANDIDATES : {},
		options.choicesPath
			? readChoiceCandidates(await Bun.file(options.choicesPath).json())
			: {},
	);
	console.log(
		JSON.stringify({
			event: `${options.eventPrefix}_choice_summary`,
			defaultChoices: options.defaultChoices,
			overrideFile: options.choicesPath !== undefined,
			// Only the keys are logged; the candidate labels are payload data.
			choiceKeys: Object.keys(choices).sort(),
		}),
	);
	return choices;
}

/** Parses the campaign CSV and applies the eligibility filter. */
export async function readCampaignRows(csvPath: string): Promise<{
	rows: CampaignCsvRow[];
	filtered: CampaignFilterResult;
}> {
	const csvText = await Bun.file(csvPath).text();
	const rows = parse(csvText, {
		columns: true,
		skip_empty_lines: true,
	}) as CampaignCsvRow[];
	return { rows, filtered: filterCampaignRows(rows) };
}

/**
 * The job fields both campaign tools read back from the API. It is the union
 * of what each one needs: the dry-run tool only looks at the status and the
 * result, while the send tool also compares the target, the company, and the
 * frozen dry-run mode on the payload.
 */
export interface JobState {
	status: JobStatus;
	attemptCount: number;
	targetUrl: string;
	companyId: string;
	payload: Record<string, unknown> | null;
	result: { reasonCode: string | null } | null;
}

/**
 * Reads one job. Every failure -- a non-OK response, a fetch that throws, or a
 * body that fails to parse -- returns null rather than throwing: the caller
 * treats it as transient and reads the job again next round. Fixed values only
 * are logged, because a failure reason may carry a URL or a host.
 */
export async function readJobState(
	jobId: string,
	apiToken: string,
	eventPrefix: string,
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
					event: `${eventPrefix}_lookup_failed`,
					jobId,
					status: response.status,
				}),
			);
			return null;
		}
		const body = (await response.json()) as { job: JobState };
		return body.job;
	} catch {
		console.log(
			JSON.stringify({
				event: `${eventPrefix}_lookup_failed`,
				jobId,
				reason: "REQUEST_FAILED",
			}),
		);
		return null;
	}
}

/** What a caller wants recorded on the `<prefix>_result` line of one job. */
export interface JobResultLog {
	reasonCode: string;
	/** Fields logged between `jobId` and `status`, e.g. `completed`. */
	extra: Record<string, unknown>;
}

export interface PollJobsOptions {
	jobs: readonly JobInput[];
	apiToken: string;
	/** Log event prefix, e.g. `campaign_job` or `campaign_send_job`. */
	eventPrefix: string;
	/** Statuses that end the wait for one job. */
	terminalStatuses: readonly JobStatus[];
	/**
	 * Called for every observed status before the terminal check. It may throw
	 * to abort the whole run, which is how the dry-run tool refuses a status
	 * that could mean a submission.
	 */
	onObserved?: (jobId: string, state: JobState) => void;
	/** Called once per job when it reaches a terminal status. */
	onTerminal: (jobId: string, state: JobState) => JobResultLog;
	/** Called once per job still pending when the deadline passes. */
	onTimedOut: (jobId: string, lastStatus: string) => JobResultLog;
}

/**
 * Polls every registered job each round instead of draining them one by one.
 * The budget keeps four minutes per concurrent batch, because a job queued
 * behind a full batch only starts once one of those finishes.
 */
export async function pollJobsUntilTerminal(
	options: PollJobsOptions,
): Promise<void> {
	const { jobs, apiToken, eventPrefix, terminalStatuses } = options;
	if (jobs.length === 0) return;

	const pending = new Map(jobs.map((job) => [job.id, ""]));
	const deadline =
		Date.now() +
		4 * 60 * 1_000 * Math.ceil(jobs.length / QUEUE_MAX_CONCURRENCY);
	while (pending.size > 0 && Date.now() < deadline) {
		for (const [jobId, lastStatus] of [...pending]) {
			const state = await readJobState(jobId, apiToken, eventPrefix);
			// A lookup failure is transient here; the job stays pending and is read
			// again next round, and the deadline still bounds the wait.
			if (!state) continue;
			if (state.status !== lastStatus) {
				pending.set(jobId, state.status);
				console.log(
					JSON.stringify({
						event: `${eventPrefix}_status`,
						jobId,
						status: state.status,
						attemptCount: state.attemptCount,
					}),
				);
			}
			options.onObserved?.(jobId, state);
			if (!terminalStatuses.includes(state.status)) continue;

			const { reasonCode, extra } = options.onTerminal(jobId, state);
			pending.delete(jobId);
			console.log(
				JSON.stringify({
					event: `${eventPrefix}_result`,
					jobId,
					...extra,
					status: state.status,
					reasonCode,
					attemptCount: state.attemptCount,
				}),
			);
		}
		if (pending.size > 0) await Bun.sleep(POLL_INTERVAL_MS);
	}

	for (const [jobId, lastStatus] of pending) {
		const { reasonCode, extra } = options.onTimedOut(jobId, lastStatus);
		console.log(
			JSON.stringify({
				event: `${eventPrefix}_result`,
				jobId,
				...extra,
				status: lastStatus || "unknown",
				reasonCode,
				attemptCount: 0,
			}),
		);
	}
}
