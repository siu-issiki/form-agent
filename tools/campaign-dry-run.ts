import {
	buildCampaignJob,
	mapRegistrationValues,
	type RedirectResolution,
	registerCampaignJobs,
	resolveRedirectHosts,
	selectCampaignCandidates,
} from "../src/campaign-import";
import { type JobInput, TERMINAL_JOB_STATUSES } from "../src/job";
import type { TrustedFormValue } from "../src/restricted-browser";
import {
	loadChoiceCandidates,
	PRODUCTION_BASE_URL,
	pollJobsUntilTerminal,
	readCampaignRows,
	readRegistration,
	requiredOption,
} from "./campaign-common";

/** Log event prefix; the shared poller derives every job event name from it. */
const EVENT_PREFIX = "campaign_job";
/**
 * A dry-run never reaches `sent`: it is refused as an unsafe status before the
 * terminal check, so waiting for it would only mean waiting for a status this
 * tool has already rejected.
 */
const DRY_RUN_TERMINAL_STATUSES = TERMINAL_JOB_STATUSES.filter(
	(status) => status !== "sent",
);

const options = parseOptions(Bun.argv.slice(2));
const registration = await readRegistration(options.registrationPath);
const choices = await loadChoiceCandidates({
	eventPrefix: "campaign",
	defaultChoices: options.defaultChoices,
	choicesPath: options.choicesPath,
});
const { rows, filtered } = await readCampaignRows(options.csvPath);
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
		upgradedToHttps: filtered.upgradedToHttps,
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

/**
 * Waits for every registered job and counts the ones that reached the dry-run
 * boundary on their first attempt. A status that could mean a submission ends
 * the whole run.
 */
async function waitForAll(
	jobs: readonly JobInput[],
	apiToken: string,
	byReasonCode: Record<string, number>,
): Promise<number> {
	let completed = 0;
	await pollJobsUntilTerminal({
		jobs,
		apiToken,
		eventPrefix: EVENT_PREFIX,
		terminalStatuses: DRY_RUN_TERMINAL_STATUSES,
		onObserved: (_jobId, state) => {
			if (state.status === "submitting" || state.status === "sent") {
				throw new Error(`Dry-run entered unsafe status ${state.status}`);
			}
		},
		onTerminal: (_jobId, state) => {
			const reasonCode = state.result?.reasonCode ?? "NO_REASON";
			const jobCompleted =
				state.status === "prohibited" &&
				reasonCode === "DRY_RUN_COMPLETE" &&
				state.attemptCount === 1;
			if (jobCompleted) completed += 1;
			byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;
			return { reasonCode, extra: { completed: jobCompleted } };
		},
		onTimedOut: () => {
			byReasonCode.DRY_RUN_TIMED_OUT =
				(byReasonCode.DRY_RUN_TIMED_OUT ?? 0) + 1;
			return { reasonCode: "DRY_RUN_TIMED_OUT", extra: { completed: false } };
		},
	});
	return completed;
}
