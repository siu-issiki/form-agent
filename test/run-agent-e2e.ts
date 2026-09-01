import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = "wrangler.agent-e2e.jsonc";
const DEFAULT_TARGET_URL = "https://www.selenium.dev/selenium/web/blank.html";
const SAFE_TERMINAL_REASON_CODES = new Set([
	"DRY_RUN_COMPLETE",
	"NO_FORM_PRESENT",
	"NO_INQUIRY_FORM",
]);
const SUCCESS_TERMINAL_STATUSES = new Set(["prohibited", "uncertain"]);
const POLL_TERMINAL_STATUSES = new Set([
	...SUCCESS_TERMINAL_STATUSES,
	"failed",
	"dead_lettered",
]);
const START_TIMEOUT_MS = 90_000;
const JOB_TIMEOUT_MS = 150_000;

interface E2eJobResponse {
	job: {
		id: string;
		status: string;
		attemptCount: number;
		result: {
			outcome: string;
			reasonCode: string | null;
		} | null;
	};
	providerRequestCount: number;
}

await run();

async function run(): Promise<void> {
	requireEnvironment("OPENAI_API_KEY");
	requireEnvironment("BROWSER_USE_API_KEY");
	const targetUrl = process.env.E2E_TARGET_URL ?? DEFAULT_TARGET_URL;

	const token = crypto.randomUUID();
	const workerName = `form-agent-e2e-${token}`;
	const port = await availablePort();
	const persistPath = await mkdtemp(join(tmpdir(), "form-agent-e2e-"));
	const baseUrl = `http://127.0.0.1:${port}`;
	let devProcess: ReturnType<typeof Bun.spawn> | undefined;
	let logs = "";

	try {
		await runCommand([
			"bunx",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"DB",
			"--local",
			"--persist-to",
			persistPath,
			"--config",
			CONFIG_PATH,
		]);

		devProcess = Bun.spawn(
			[
				"bunx",
				"wrangler",
				"dev",
				"--config",
				CONFIG_PATH,
				"--name",
				workerName,
				"--env-file",
				".env",
				"--ip",
				"127.0.0.1",
				"--port",
				String(port),
				"--persist-to",
				persistPath,
				"--var",
				"AGENT_EXECUTOR_ENABLED:true",
				"--var",
				"AGENT_MODEL:gpt-5.6-luna",
				"--var",
				"AGENT_DRY_RUN:true",
				"--var",
				`E2E_TARGET_URL:${targetUrl}`,
				"--var",
				`E2E_TOKEN:${token}`,
				"--show-interactive-dev-session=false",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				detached: true,
				env: { ...process.env, CI: "1" },
			},
		);
		if (
			!(devProcess.stdout instanceof ReadableStream) ||
			!(devProcess.stderr instanceof ReadableStream)
		) {
			throw new Error("wrangler dev output streams are unavailable");
		}
		const captureStdout = capture(devProcess.stdout, (chunk) => {
			logs = boundedLogs(logs + chunk);
		});
		const captureStderr = capture(devProcess.stderr, (chunk) => {
			logs = boundedLogs(logs + chunk);
		});

		await waitForHealth(baseUrl, devProcess);
		const jobId = `agent-e2e-${crypto.randomUUID()}`;
		const created = await fetch(`${baseUrl}/e2e/jobs`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ jobId }),
		});
		if (created.status !== 201) {
			throw new Error(
				`E2E job registration failed with status ${created.status}`,
			);
		}
		await created.body?.cancel();

		const result = await waitForJob(baseUrl, token, jobId, devProcess);
		console.log(
			JSON.stringify({
				jobId: result.job.id,
				status: result.job.status,
				attemptCount: result.job.attemptCount,
				providerRequestCount: result.providerRequestCount,
				reasonCode: result.job.result?.reasonCode ?? null,
			}),
		);
		assertSuccessfulNoSubmitResult(result, targetUrl !== DEFAULT_TARGET_URL);

		await stopProcess(devProcess);
		devProcess = undefined;
		await Promise.all([captureStdout, captureStderr]);
	} catch (error) {
		if (logs) console.error(logs);
		throw error;
	} finally {
		if (devProcess) {
			await stopProcess(devProcess);
		}
		await rm(persistPath, { recursive: true, force: true });
	}
}

async function stopProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
	signalProcessGroup(child.pid, "SIGTERM");
	if (child.exitCode === null) {
		await Promise.race([child.exited, delay(5_000)]);
	}
	signalProcessGroup(child.pid, "SIGKILL");
	await child.exited;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (!Number.isInteger(pid) || pid <= 1) {
		throw new Error("Refusing to signal an invalid process group");
	}
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitForHealth(
	baseUrl: string,
	process: ReturnType<typeof Bun.spawn>,
): Promise<void> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) {
			throw new Error(`wrangler dev exited with code ${process.exitCode}`);
		}
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) {
				await response.body?.cancel();
				return;
			}
		} catch {}
		await delay(500);
	}
	throw new Error("wrangler dev did not become ready");
}

async function waitForJob(
	baseUrl: string,
	token: string,
	jobId: string,
	process: ReturnType<typeof Bun.spawn>,
): Promise<E2eJobResponse> {
	const deadline = Date.now() + JOB_TIMEOUT_MS;
	let lastResult: E2eJobResponse | undefined;
	let lastStatus: string | undefined;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) {
			throw new Error(`wrangler dev exited with code ${process.exitCode}`);
		}
		const response = await fetch(`${baseUrl}/e2e/jobs/${jobId}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`E2E job lookup failed with status ${response.status}`);
		}
		const result = (await response.json()) as E2eJobResponse;
		lastResult = result;
		if (result.job.status !== lastStatus) {
			lastStatus = result.job.status;
			console.log(
				JSON.stringify({
					event: "job_status",
					status: result.job.status,
					attemptCount: result.job.attemptCount,
					providerRequestCount: result.providerRequestCount,
				}),
			);
		}
		if (POLL_TERMINAL_STATUSES.has(result.job.status)) return result;
		if (result.job.status === "sent" || result.job.status === "submitting") {
			throw new Error(`E2E job entered prohibited status ${result.job.status}`);
		}
		await delay(1_000);
	}
	throw new Error(
		lastResult
			? `The E2E job did not reach a terminal state (status=${lastResult.job.status}, attempts=${lastResult.job.attemptCount}, providerRequests=${lastResult.providerRequestCount})`
			: "The E2E job did not reach a terminal state",
	);
}

function assertSuccessfulNoSubmitResult(
	result: E2eJobResponse,
	expectsForm: boolean,
): void {
	if (!SUCCESS_TERMINAL_STATUSES.has(result.job.status)) {
		throw new Error(`Unexpected terminal status ${result.job.status}`);
	}
	if (result.job.attemptCount !== 1) {
		throw new Error(`Expected one attempt, got ${result.job.attemptCount}`);
	}
	if (result.providerRequestCount < 1) {
		throw new Error("No OpenAI provider request was persisted");
	}
	if (
		!result.job.result ||
		result.job.result.outcome === "sent" ||
		!result.job.result.reasonCode ||
		!SAFE_TERMINAL_REASON_CODES.has(result.job.result.reasonCode) ||
		(expectsForm && result.job.result.reasonCode !== "DRY_RUN_COMPLETE")
	) {
		throw new Error("The E2E job did not persist a safe terminal result");
	}
}

async function runCommand(command: string[]): Promise<string> {
	const process = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...globalThis.process.env, CI: "1" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`Command failed with code ${exitCode}: ${boundedLogs(stdout + stderr)}`,
		);
	}
	return stdout;
}

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not allocate an E2E port");
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

async function capture(
	stream: ReadableStream<Uint8Array>,
	onChunk: (chunk: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			onChunk(decoder.decode());
			return;
		}
		onChunk(decoder.decode(value, { stream: true }));
	}
}

function boundedLogs(value: string): string {
	const maximum = 20_000;
	if (value.length <= maximum) return value;
	const half = maximum / 2;
	return `${value.slice(0, half)}\n... logs truncated ...\n${value.slice(-half)}`;
}

function requireEnvironment(name: string): void {
	if (!process.env[name]) throw new Error(`${name} is required`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
