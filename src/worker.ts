import {
	AgentExecutionError,
	type AgentExecutor,
	executeAgent,
} from "./agent-executor";
import type { AgentRunResult } from "./agent-runtime";
import { D1JobStore } from "./d1-job-store";
import { DuplicateJobError, type Job, type JobInput } from "./job";
import { assertAllowedTargetUrl } from "./restricted-browser";
import { createSandboxAgentExecutor } from "./sandbox-agent-executor";

export { AgentToolService } from "./agent-tool-service";
export { ContainerProxy, FormAgentSandbox } from "./form-agent-sandbox";

export interface JobMessage {
	jobId: string;
}

export interface Env {
	DB: D1Database;
	JOB_QUEUE: Queue<JobMessage>;
	SANDBOX?: DurableObjectNamespace<
		import("./form-agent-sandbox").FormAgentSandbox
	>;
	AGENT_EXECUTOR_ENABLED?: string;
	AGENT_MODEL?: string;
	OPENAI_API_KEY?: string;
	BROWSER_USE_API_KEY?: string;
	JOB_API_TOKEN?: string;
}

export interface RegisterJobResult {
	created: boolean;
	job: Job;
}

interface JobQueue {
	send(message: JobMessage): Promise<unknown>;
}

const DEAD_LETTER_QUEUE = "form-agent-jobs-dlq";
const MAX_AGENT_DURATION_MS = 10 * 60 * 1000;
const MAX_JOB_REQUEST_BYTES = 64 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function registerJob(
	db: D1Database,
	queue: JobQueue,
	input: JobInput,
	now: string,
): Promise<RegisterJobResult> {
	const store = new D1JobStore(db);
	let created = true;
	let job: Job;

	try {
		job = await store.create(input, now);
	} catch (error) {
		if (!(error instanceof DuplicateJobError)) {
			throw error;
		}

		created = false;
		const existing = await store.find(input.id);
		if (!existing) {
			throw new Error(`Duplicate job could not be loaded: ${input.id}`);
		}
		job = existing;
	}

	if (job.status === "pending") {
		await queue.send({ jobId: job.id });
	}

	return { created, job };
}

const worker: ExportedHandler<Env, JobMessage> = {
	async fetch(request, env) {
		return handleHttpRequest(request, env);
	},

	async queue(batch, env) {
		await consumeJobBatch(batch, env, createAgentExecutor(env));
	},
};

export default worker;

export async function handleHttpRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/health") {
		return Response.json({ status: "ok" });
	}

	if (url.pathname === "/jobs" && request.method === "POST") {
		if (!isAuthorized(request, env.JOB_API_TOKEN)) {
			return unauthorizedResponse();
		}

		let input: JobInput;
		try {
			input = await parseJobInput(request);
		} catch (error) {
			if (error instanceof InvalidJobRequestError) {
				return apiJson({ error: error.code }, error.status);
			}
			throw error;
		}

		const registered = await registerJob(
			env.DB,
			env.JOB_QUEUE,
			input,
			new Date().toISOString(),
		);
		return apiJson(
			{
				created: registered.created,
				job: toPublicJob(registered.job),
			},
			registered.created ? 201 : 200,
		);
	}

	const jobId = jobIdFromPath(url.pathname);
	if (jobId && request.method === "GET") {
		if (!isAuthorized(request, env.JOB_API_TOKEN)) {
			return unauthorizedResponse();
		}
		const job = await new D1JobStore(env.DB).find(jobId);
		return job
			? apiJson({ job: toPublicJob(job) }, 200)
			: apiJson({ error: "NOT_FOUND" }, 404);
	}

	return new Response("Not Found", { status: 404 });
}

function isAuthorized(request: Request, token: string | undefined): boolean {
	return Boolean(
		token && request.headers.get("authorization") === `Bearer ${token}`,
	);
}

function unauthorizedResponse(): Response {
	return apiJson({ error: "UNAUTHORIZED" }, 401, {
		"www-authenticate": "Bearer",
	});
}

function apiJson(
	body: unknown,
	status: number,
	headers?: HeadersInit,
): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("cache-control", "no-store");
	return Response.json(body, { status, headers: responseHeaders });
}

function jobIdFromPath(pathname: string): string | null {
	const match = /^\/jobs\/([^/]+)$/.exec(pathname);
	if (!match?.[1]) return null;
	try {
		const jobId = decodeURIComponent(match[1]);
		return JOB_ID_PATTERN.test(jobId) ? jobId : null;
	} catch {
		return null;
	}
}

function toPublicJob(job: Job): Omit<Job, "runToken"> {
	const { runToken: _runToken, ...publicJob } = job;
	return publicJob;
}

async function parseJobInput(request: Request): Promise<JobInput> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0];
	if (contentType?.trim().toLowerCase() !== "application/json") {
		throw new InvalidJobRequestError("UNSUPPORTED_MEDIA_TYPE", 415);
	}

	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_JOB_REQUEST_BYTES) {
		throw new InvalidJobRequestError("REQUEST_TOO_LARGE", 413);
	}

	const rawBody = await request.text();
	if (new TextEncoder().encode(rawBody).byteLength > MAX_JOB_REQUEST_BYTES) {
		throw new InvalidJobRequestError("REQUEST_TOO_LARGE", 413);
	}

	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		throw new InvalidJobRequestError("INVALID_JSON", 400);
	}
	if (!isRecord(body)) {
		throw new InvalidJobRequestError("INVALID_JOB", 400);
	}

	const { id, companyId, companyName, targetUrl, targetDomain, payload } = body;
	if (
		typeof id !== "string" ||
		!JOB_ID_PATTERN.test(id) ||
		!validRequiredString(companyId, 128) ||
		!validRequiredString(companyName, 256) ||
		!validRequiredString(targetUrl, 2_048) ||
		!validRequiredString(targetDomain, 253) ||
		!isRecord(payload)
	) {
		throw new InvalidJobRequestError("INVALID_JOB", 400);
	}

	try {
		assertAllowedTargetUrl(targetUrl, targetDomain);
	} catch {
		throw new InvalidJobRequestError("INVALID_JOB", 400);
	}

	return { id, companyId, companyName, targetUrl, targetDomain, payload };
}

function validRequiredString(
	value: unknown,
	maxLength: number,
): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= maxLength
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

class InvalidJobRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

export async function consumeJobBatch(
	batch: MessageBatch<JobMessage>,
	env: Env,
	executor: AgentExecutor,
): Promise<void> {
	const store = new D1JobStore(env.DB);

	for (const message of batch.messages) {
		if (!isJobMessage(message.body)) {
			message.ack();
			continue;
		}

		try {
			const now = new Date().toISOString();
			if (batch.queue === DEAD_LETTER_QUEUE) {
				await store.markDeadLettered(
					message.body.jobId,
					"QUEUE_RETRY_EXHAUSTED",
					now,
				);
				message.ack();
				continue;
			}

			const runToken = message.id;
			const claimed = await store.claimRun(message.body.jobId, runToken, now);
			const job = claimed ?? (await store.find(message.body.jobId));

			if (job?.status !== "running" || job.runToken !== runToken) {
				message.ack();
				continue;
			}
			const attemptedJob = await store.recordRunAttempt(
				job.id,
				runToken,
				message.attempts,
				now,
			);
			if (!attemptedJob) {
				message.ack();
				continue;
			}

			const disposition = await executeClaimedJob(
				store,
				executor,
				attemptedJob,
				runToken,
				now,
			);
			if (disposition === "retry") {
				message.retry({ delaySeconds: 30 });
			} else {
				message.ack();
			}
		} catch {
			message.retry({ delaySeconds: 30 });
		}
	}
}

async function executeClaimedJob(
	store: D1JobStore,
	executor: AgentExecutor,
	job: Job,
	runToken: string,
	now: string,
): Promise<"ack" | "retry"> {
	let result: AgentRunResult;
	try {
		result = await executeAgent(executor, {
			job,
			runToken,
			maxDurationMs: MAX_AGENT_DURATION_MS,
		});
	} catch (error) {
		const current = await store.find(job.id);
		if (current?.status === "submitting") {
			await store.recordUncertain(
				job.id,
				runToken,
				"AGENT_RESULT_UNKNOWN",
				"The agent stopped after submission permission was granted.",
				now,
			);
			return "ack";
		}
		if (current?.status !== "running" || current.runToken !== runToken) {
			return "ack";
		}
		if (!(error instanceof AgentExecutionError) || error.retryable) {
			return "retry";
		}
		await store.recordFailed(
			job.id,
			runToken,
			error.reasonCode,
			error.message,
			now,
		);
		return "ack";
	}

	switch (result.outcome) {
		case "sent": {
			const persisted = await store.find(job.id);
			if (persisted?.status !== "sent") {
				await store.recordUncertain(
					job.id,
					runToken,
					"SENT_RESULT_NOT_PERSISTED",
					"The agent reported a sent form without a persisted sent result.",
					now,
				);
			}
			return "ack";
		}
		case "prohibited":
			if (
				!(await store.recordProhibited(
					job.id,
					runToken,
					result.formUrl,
					result.reasonCode,
					result.reason,
					now,
				))
			) {
				await closeSubmittingConflict(store, job.id, runToken, now);
			}
			return "ack";
		case "uncertain":
			await store.recordUncertain(
				job.id,
				runToken,
				result.reasonCode,
				result.reason,
				now,
			);
			return "ack";
		case "failed":
			if (result.retryable) {
				const current = await store.find(job.id);
				if (current?.status === "submitting") {
					await closeSubmittingConflict(store, job.id, runToken, now);
					return "ack";
				}
				return current?.status === "running" && current.runToken === runToken
					? "retry"
					: "ack";
			}
			if (
				!(await store.recordFailed(
					job.id,
					runToken,
					result.reasonCode,
					result.reason,
					now,
				))
			) {
				await closeSubmittingConflict(store, job.id, runToken, now);
			}
			return "ack";
	}
}

async function closeSubmittingConflict(
	store: D1JobStore,
	jobId: string,
	runToken: string,
	now: string,
): Promise<void> {
	await store.recordUncertain(
		jobId,
		runToken,
		"AGENT_RESULT_CONFLICT",
		"The agent returned a conflicting result after submission permission was granted.",
		now,
	);
}

function createAgentExecutor(env: Env): AgentExecutor {
	if (
		env.AGENT_EXECUTOR_ENABLED === "true" &&
		env.SANDBOX &&
		env.AGENT_MODEL &&
		env.OPENAI_API_KEY &&
		env.BROWSER_USE_API_KEY
	) {
		return createSandboxAgentExecutor(env.SANDBOX, env.AGENT_MODEL);
	}
	return {
		async execute() {
			return {
				outcome: "failed",
				reasonCode: "EXECUTOR_NOT_CONFIGURED",
				reason: "The agent runner binding has not been configured yet.",
				retryable: false,
			};
		},
	};
}

function isJobMessage(value: unknown): value is JobMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"jobId" in value &&
		typeof value.jobId === "string" &&
		value.jobId.length > 0
	);
}
