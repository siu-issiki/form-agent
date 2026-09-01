const DEFAULT_BASE_URL = "https://form-agent.form-agent.workers.dev";
const DEFAULT_TARGET_URL = "https://anyreach.co.jp/contact";
const TERMINAL_STATUSES = new Set([
	"prohibited",
	"uncertain",
	"failed",
	"dead_lettered",
]);
const JOB_TIMEOUT_MS = 3 * 60 * 1000;

interface JobResponse {
	job: {
		id: string;
		status: string;
		attemptCount: number;
		result: {
			outcome: string;
			reasonCode: string | null;
		} | null;
	};
}

const token = requireEnvironment("JOB_API_TOKEN");
const baseUrl = process.env.PRODUCTION_BASE_URL ?? DEFAULT_BASE_URL;
const targetUrl = process.env.E2E_TARGET_URL ?? DEFAULT_TARGET_URL;
const target = new URL(targetUrl);
const jobId = `agent-e2e-prod-${crypto.randomUUID()}`;
const headers = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};

const created = await fetch(`${baseUrl}/jobs`, {
	method: "POST",
	headers,
	body: JSON.stringify({
		id: jobId,
		companyId: "agent-e2e-target",
		companyName: `${target.hostname} E2E Fixture`,
		targetUrl,
		targetDomain: target.hostname,
		payload: {
			_formAgentDryRun: true,
			scenario: "safe-no-submit",
			name: "送信なしテスト",
			companyName: "Form Agent E2E",
			email: "no-reply@example.com",
			message: "これは送信しないフォーム動作確認です。",
			instruction:
				"Inspect the target and fill a compatible inquiry form using only these payload values. Call submit after validation; dry-run mode must intercept it without sending.",
		},
	}),
});
if (created.status !== 201) {
	await created.body?.cancel();
	throw new Error(`Production E2E registration failed with ${created.status}`);
}
await created.body?.cancel();
console.log(JSON.stringify({ event: "job_registered", jobId }));

const deadline = Date.now() + JOB_TIMEOUT_MS;
let lastStatus: string | undefined;
while (Date.now() < deadline) {
	const response = await fetch(`${baseUrl}/jobs/${jobId}`, { headers });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Production E2E lookup failed with ${response.status}`);
	}
	const result = (await response.json()) as JobResponse;
	if (result.job.status !== lastStatus) {
		lastStatus = result.job.status;
		console.log(
			JSON.stringify({
				event: "job_status",
				status: result.job.status,
				attemptCount: result.job.attemptCount,
			}),
		);
	}
	if (result.job.status === "submitting" || result.job.status === "sent") {
		throw new Error(
			`Production E2E entered unsafe status ${result.job.status}`,
		);
	}
	if (TERMINAL_STATUSES.has(result.job.status)) {
		console.log(
			JSON.stringify({
				jobId: result.job.id,
				status: result.job.status,
				attemptCount: result.job.attemptCount,
				outcome: result.job.result?.outcome ?? null,
				reasonCode: result.job.result?.reasonCode ?? null,
			}),
		);
		if (
			result.job.status !== "prohibited" ||
			result.job.result?.reasonCode !== "DRY_RUN_COMPLETE"
		) {
			throw new Error("Production E2E did not finish at the dry-run boundary");
		}
		if (result.job.attemptCount !== 1) {
			throw new Error(
				`Production E2E retried unexpectedly (${result.job.attemptCount} attempts)`,
			);
		}
		process.exit(0);
	}
	await Bun.sleep(2_000);
}

throw new Error(
	`Production E2E timed out with status ${lastStatus ?? "unknown"}`,
);

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
