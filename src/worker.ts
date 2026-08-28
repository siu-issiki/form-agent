import {
	AgentExecutionError,
	type AgentExecutor,
	executeAgent,
} from "./agent-executor";
import type { AgentRunResult } from "./agent-runtime";
import { D1JobStore } from "./d1-job-store";
import { DuplicateJobError, type Job, type JobInput } from "./job";
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
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}
		return new Response("Not Found", { status: 404 });
	},

	async queue(batch, env) {
		await consumeJobBatch(batch, env, createAgentExecutor(env));
	},
};

export default worker;

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
