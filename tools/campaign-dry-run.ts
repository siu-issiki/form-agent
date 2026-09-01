import { parse } from "csv-parse/sync";
import {
	buildCampaignJob,
	type CampaignCsvRow,
	filterCampaignRows,
	mapRegistrationValues,
	type RedirectResolution,
	type RegistrationEntry,
	resolveRedirectHosts,
} from "../src/campaign-import";
import type { JobInput } from "../src/job";

const PRODUCTION_BASE_URL = "https://form-agent.form-agent.workers.dev";

const options = parseOptions(Bun.argv.slice(2));
const registration = await readRegistration(options.registrationPath);
const csvText = await Bun.file(options.csvPath).text();
const rows = parse(csvText, {
	columns: true,
	skip_empty_lines: true,
}) as CampaignCsvRow[];
const filtered = filterCampaignRows(rows);
const registrationValues = mapRegistrationValues(registration);
console.log(
	JSON.stringify({
		event: "campaign_filter_summary",
		totalRows: rows.length,
		eligibleRows: filtered.eligible.length,
		excluded: filtered.excluded,
		selectedRows: options.limit,
	}),
);

const jobs: JobInput[] = [];
for (const candidate of filtered.eligible) {
	if (jobs.length >= options.limit) break;
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
	);
	const formValues = job.payload.formValues as Record<string, string>;
	console.log(
		JSON.stringify({
			event: "campaign_job_preview",
			jobId: job.id,
			companyId: job.companyId,
			formValueKeys: Object.keys(formValues).sort(),
			formValueCount: Object.keys(formValues).length,
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
	let completed = 0;
	for (const job of jobs) {
		if (await submitAndWait(job, options.apiToken)) completed += 1;
	}
	console.log(
		JSON.stringify({
			event: "campaign_dry_run_summary",
			selectedJobs: jobs.length,
			completedJobs: completed,
			safeFailures: jobs.length - completed,
		}),
	);
	if (completed !== jobs.length) {
		throw new Error("One or more jobs failed before the dry-run boundary");
	}
}

interface Options {
	registrationPath: string;
	csvPath: string;
	campaign: string;
	limit: number;
	submit: boolean;
	apiToken: string;
}

function parseOptions(args: string[]): Options {
	const values = new Map<string, string>();
	let submit = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--submit-dry-run") {
			submit = true;
			continue;
		}
		if (!arg?.startsWith("--")) throw new Error("Invalid argument");
		if (!["--registration", "--csv", "--campaign", "--limit"].includes(arg)) {
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
	if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
		throw new Error("--limit must be an integer from 1 to 5");
	}
	const apiToken = process.env.JOB_API_TOKEN ?? "";
	if (submit && !apiToken)
		throw new Error("JOB_API_TOKEN is required for submission");

	return {
		registrationPath,
		csvPath,
		campaign,
		limit,
		submit,
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

async function submitAndWait(
	job: JobInput,
	apiToken: string,
): Promise<boolean> {
	if (job.payload._formAgentDryRun !== true) {
		throw new Error("Job-level dry-run guard is missing");
	}
	const headers = {
		authorization: `Bearer ${apiToken}`,
		"content-type": "application/json",
	};
	const created = await fetch(`${PRODUCTION_BASE_URL}/jobs`, {
		method: "POST",
		headers,
		body: JSON.stringify(job),
		redirect: "manual",
	});
	await created.body?.cancel();
	if (created.status !== 200 && created.status !== 201) {
		throw new Error(`Job registration failed with status ${created.status}`);
	}
	console.log(
		JSON.stringify({ event: "campaign_job_registered", jobId: job.id }),
	);

	const deadline = Date.now() + 4 * 60 * 1_000;
	let lastStatus = "";
	while (Date.now() < deadline) {
		const response = await fetch(`${PRODUCTION_BASE_URL}/jobs/${job.id}`, {
			headers,
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Job lookup failed with status ${response.status}`);
		}
		const body = (await response.json()) as {
			job: {
				status: string;
				attemptCount: number;
				result: { reasonCode: string | null } | null;
			};
		};
		if (body.job.status !== lastStatus) {
			lastStatus = body.job.status;
			console.log(
				JSON.stringify({
					event: "campaign_job_status",
					jobId: job.id,
					status: body.job.status,
					attemptCount: body.job.attemptCount,
				}),
			);
		}
		if (body.job.status === "submitting" || body.job.status === "sent") {
			throw new Error(`Dry-run entered unsafe status ${body.job.status}`);
		}
		if (
			["prohibited", "uncertain", "failed", "dead_lettered"].includes(
				body.job.status,
			)
		) {
			const completed =
				body.job.status === "prohibited" &&
				body.job.result?.reasonCode === "DRY_RUN_COMPLETE" &&
				body.job.attemptCount === 1;
			console.log(
				JSON.stringify({
					event: "campaign_job_result",
					jobId: job.id,
					completed,
					status: body.job.status,
					reasonCode: body.job.result?.reasonCode ?? "NO_REASON",
					attemptCount: body.job.attemptCount,
				}),
			);
			return completed;
		}
		await Bun.sleep(2_000);
	}
	throw new Error(`Dry-run timed out with status ${lastStatus || "unknown"}`);
}

function requiredOption(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}
