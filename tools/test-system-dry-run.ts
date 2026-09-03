/**
 * Registers one dry-run job against a managed test-system scenario and waits
 * for it to stop at the dry-run boundary. Nothing is submitted: the trusted
 * handler intercepts `submit` after validation and the pre-submit review.
 *
 * Usage:
 *   TEST_SYSTEM_API_TOKEN=... FORM_AGENT_JOB_API_TOKEN=... \
 *     bun run tools/test-system-dry-run.ts [scenarioId]
 */
const TEST_SYSTEM_URL = "https://form-agent-test-system.form-agent.workers.dev";
const FORM_AGENT_URL = "https://form-agent.form-agent.workers.dev";
const DEFAULT_SCENARIO = "native-post-redirect";
const JOB_TIMEOUT_MS = 12 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_000;
const TERMINAL_JOB_STATUSES = new Set([
	"sent",
	"prohibited",
	"uncertain",
	"failed",
	"dead_lettered",
]);

interface CreatedRun {
	runId: string;
	targetUrl: string;
	targetDomain: string;
	allowedHosts: string[];
	/** A value may be an ordered candidate list for one choice control. */
	formValues: Record<string, string | string[]>;
}

interface JobResponse {
	job: {
		id: string;
		status: string;
		attemptCount: number;
		payload: Record<string, unknown>;
		result: {
			outcome: string;
			reasonCode: string | null;
			reason?: string | null;
		} | null;
	};
}

const testSystemHeaders = apiHeaders(
	requireEnvironment("TEST_SYSTEM_API_TOKEN"),
);
const formAgentHeaders = apiHeaders(
	requireEnvironment("FORM_AGENT_JOB_API_TOKEN"),
);
const scenarioId = Bun.argv[2] ?? DEFAULT_SCENARIO;

const run = await fetchJson<CreatedRun>(`${TEST_SYSTEM_URL}/api/runs`, {
	method: "POST",
	headers: testSystemHeaders,
	body: JSON.stringify({ scenarioId }),
});
if (new URL(run.targetUrl).origin !== TEST_SYSTEM_URL) {
	throw new Error("The run target is not the managed test system");
}
console.log(
	JSON.stringify({ event: "run_created", scenarioId, runId: run.runId }),
);

const jobId = `test-system-dry-run-${scenarioId}-${crypto.randomUUID()}`;
const created = await fetchJson<JobResponse>(`${FORM_AGENT_URL}/jobs`, {
	method: "POST",
	headers: formAgentHeaders,
	body: JSON.stringify({
		id: jobId,
		companyId: `test-system-dry-run-${scenarioId}`,
		companyName: `Form Agent管理下dry-run: ${scenarioId}`,
		targetUrl: run.targetUrl,
		targetDomain: run.targetDomain,
		allowedHosts: run.allowedHosts,
		payload: {
			_formAgentDryRun: true,
			_formAgentMaxAttempts: 1,
			scenario: scenarioId,
			formValues: run.formValues,
			instruction:
				"この管理下テストページだけを処理してください。通常の問い合わせフォームなら指定値を入力して送信し、フォームがない場合または営業利用禁止の専用フォームしかない場合は送信しないでください。",
		},
	}),
});
if (created.job.payload._formAgentEffectiveDryRun !== true) {
	throw new Error("The job was not registered as a dry-run");
}
console.log(JSON.stringify({ event: "job_registered", jobId }));

const deadline = Date.now() + JOB_TIMEOUT_MS;
let lastStatus: string | undefined;
while (Date.now() < deadline) {
	const response = await fetchJson<JobResponse>(
		`${FORM_AGENT_URL}/jobs/${jobId}`,
		{ headers: formAgentHeaders },
	);
	const { job } = response;
	if (job.status !== lastStatus) {
		lastStatus = job.status;
		console.log(
			JSON.stringify({
				event: "job_status",
				status: job.status,
				attemptCount: job.attemptCount,
			}),
		);
	}
	if (job.status === "submitting" || job.status === "sent") {
		throw new Error(`Dry-run entered unsafe status ${job.status}`);
	}
	if (TERMINAL_JOB_STATUSES.has(job.status)) {
		console.log(
			JSON.stringify({
				event: "job_finished",
				jobId,
				status: job.status,
				attemptCount: job.attemptCount,
				outcome: job.result?.outcome ?? null,
				reasonCode: job.result?.reasonCode ?? null,
				reason: job.result?.reason ?? null,
			}),
		);
		if (
			job.status !== "prohibited" ||
			job.result?.reasonCode !== "DRY_RUN_COMPLETE"
		) {
			throw new Error("The dry-run did not stop at the dry-run boundary");
		}
		process.exit(0);
	}
	await Bun.sleep(POLL_INTERVAL_MS);
}
throw new Error(`Dry-run timed out with status ${lastStatus ?? "unknown"}`);

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
	const response = await fetch(url, { ...init, redirect: "manual" });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`Request failed: ${response.status} ${new URL(url).pathname}`,
		);
	}
	return response.json() as Promise<T>;
}

function apiHeaders(token: string): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export {};
