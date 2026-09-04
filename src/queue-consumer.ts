import {
	AgentExecutionError,
	type AgentExecutor,
	executeAgent,
} from "./agent-executor";
import type { AgentRunResult } from "./agent-runtime";
import { BrowserUseClient } from "./browser-use-client";
import { reclaimJobSessions } from "./browser-use-session";
import { D1JobStore } from "./d1-job-store";
import type { Env, JobMessage } from "./env";
import { type Job, MAX_ATTEMPTS_KEY } from "./job";

const DEAD_LETTER_QUEUE = "form-agent-jobs-dlq";
const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 300;
const RETRY_JITTER_RATIO = 0.2;
/** 2^10 already exceeds the cap, so the exponent never needs to grow. */
const MAX_RETRY_EXPONENT = 10;
const MAX_AGENT_DURATION_MS = 10 * 60 * 1000;
/** The reclaim runs after the job is already lost, so it waits only briefly. */
const SESSION_RECLAIM_TIMEOUT_MS = 10_000;

/**
 * Exponential backoff with jitter for one Queue redelivery. The jitter is
 * applied first and the cap last, so no delay ever exceeds the cap.
 */
export function computeRetryDelaySeconds(
	attempt: number,
	random: number = Math.random(),
): number {
	const safeAttempt =
		Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
	const exponent = Math.min(safeAttempt - 1, MAX_RETRY_EXPONENT);
	const base = BASE_RETRY_DELAY_SECONDS * 2 ** exponent;
	const safeRandom = Number.isFinite(random)
		? Math.min(Math.max(random, 0), 1)
		: 0.5;
	const jitter = 1 + (safeRandom * 2 - 1) * RETRY_JITTER_RATIO;
	return Math.min(
		MAX_RETRY_DELAY_SECONDS,
		Math.max(1, Math.round(base * jitter)),
	);
}

/**
 * A Worker killed mid-attempt, by the CPU limit for example, leaves the browser
 * sessions of that attempt running until the provider timeout expires, and each
 * one holds a concurrency slot. The attempt-limit paths end the job without
 * building a driver, so nothing else would release them; the reclaim is best
 * effort and never changes the recorded result.
 */
async function reclaimAttemptSessions(env: Env, jobId: string): Promise<void> {
	if (!env.BROWSER_USE_API_KEY) return;
	try {
		await reclaimJobSessions(
			new BrowserUseClient(env.BROWSER_USE_API_KEY, fetch),
			jobId,
			AbortSignal.timeout(SESSION_RECLAIM_TIMEOUT_MS),
		);
	} catch {
		// The provider is unreachable; the sessions expire on their own timeout.
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

		let attemptedJob: Job | null = null;
		let executionStartedAt: number | null = null;
		// Computed once so the recorded delay is the delay the Queue receives.
		const retryDelaySeconds = computeRetryDelaySeconds(message.attempts);
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
				// Best effort: the message is acknowledged either way, and the
				// event only exists so that a job left in `submitting` by a
				// stopped Worker is findable.
				if (job) {
					await store
						.recordRedeliveryIgnored(job.id, job.status, now)
						.catch(() => undefined);
				}
				message.ack();
				continue;
			}
			attemptedJob = await store.recordRunAttempt(
				job.id,
				runToken,
				message.attempts,
				now,
			);
			if (!attemptedJob) {
				message.ack();
				continue;
			}
			if (hasExceededAttemptLimit(attemptedJob)) {
				await reclaimAttemptSessions(env, attemptedJob.id);
				const failed = await store.recordFailed(
					attemptedJob.id,
					runToken,
					"JOB_ATTEMPT_LIMIT_REACHED",
					"The job was redelivered after its attempt limit.",
					now,
				);
				if (failed) {
					message.ack();
					continue;
				}
				throw new Error("Job attempt limit result was not persisted");
			}

			executionStartedAt = Date.now();
			const disposition = await executeClaimedJob(
				store,
				executor,
				attemptedJob,
				runToken,
				now,
				retryDelaySeconds,
			);
			if (disposition === "retry") {
				message.retry({ delaySeconds: retryDelaySeconds });
			} else {
				message.ack();
			}
		} catch {
			console.warn(
				JSON.stringify({
					event: "queue_consumer_error",
					reasonCode: "QUEUE_CONSUMER_ERROR",
				}),
			);
			if (attemptedJob && hasReachedAttemptLimit(attemptedJob)) {
				await reclaimAttemptSessions(env, attemptedJob.id);
				await store.recordFailed(
					attemptedJob.id,
					message.id,
					"QUEUE_CONSUMER_ERROR",
					"The queue consumer failed at the job attempt limit.",
					new Date().toISOString(),
				);
				message.ack();
				continue;
			}
			if (attemptedJob) {
				await recordRetryScheduled(
					store,
					attemptedJob,
					message.id,
					"QUEUE_CONSUMER_ERROR",
					"consumer",
					executionStartedAt ?? Date.now(),
					retryDelaySeconds,
				);
			}
			message.retry({ delaySeconds: retryDelaySeconds });
		}
	}
}

async function executeClaimedJob(
	store: D1JobStore,
	executor: AgentExecutor,
	job: Job,
	runToken: string,
	now: string,
	retryDelaySeconds: number,
): Promise<"ack" | "retry"> {
	const startedAt = Date.now();
	let result: AgentRunResult;
	try {
		result = await executeAgent(executor, {
			job,
			runToken,
			maxDurationMs: MAX_AGENT_DURATION_MS,
		});
	} catch (error) {
		return handleAgentException(
			store,
			error,
			job,
			runToken,
			now,
			startedAt,
			retryDelaySeconds,
		);
	}
	return handleAgentResult(
		store,
		result,
		job,
		runToken,
		now,
		startedAt,
		retryDelaySeconds,
	);
}

/**
 * The `agent_execution_error` log fields for one thrown error. The key order is
 * the order the log has always had -- reasonCode, retryable, then the optional
 * CDP method/kind pair and detail -- so callers spread it straight into the
 * event object.
 */
interface AgentErrorDescription {
	reasonCode: string;
	retryable: boolean;
	method?: string;
	kind?: string | undefined;
	detail?: string;
}

/**
 * Reads the log fields off an error. Anything that is not an
 * `AgentExecutionError` is an unexpected failure and stays retryable.
 */
function describeAgentError(error: unknown): AgentErrorDescription {
	if (!(error instanceof AgentExecutionError)) {
		return { reasonCode: "UNEXPECTED_AGENT_ERROR", retryable: true };
	}
	return {
		reasonCode: error.reasonCode,
		retryable: error.retryable,
		...(error.cdpMethod
			? { method: error.cdpMethod, kind: error.cdpKind }
			: {}),
		...(error.detail ? { detail: error.detail } : {}),
	};
}

/**
 * Ends a retryable attempt the same way whether it came from a thrown error or
 * from a `failed` result: the attempt limit turns it into a recorded failure
 * that is acknowledged, and anything below the limit is scheduled for one more
 * delivery. `source` is the only field the two callers differ on.
 */
async function decideRetryOrFail(
	store: D1JobStore,
	job: Job,
	runToken: string,
	reasonCode: string,
	source: "exception" | "result",
	startedAt: number,
	retryDelaySeconds: number,
	now: string,
): Promise<"ack" | "retry"> {
	if (hasReachedAttemptLimit(job)) {
		await store.recordFailed(
			job.id,
			runToken,
			reasonCode,
			"The agent failed at the job attempt limit.",
			now,
		);
		return "ack";
	}
	await recordRetryScheduled(
		store,
		job,
		runToken,
		reasonCode,
		source,
		startedAt,
		retryDelaySeconds,
	);
	return "retry";
}

async function handleAgentException(
	store: D1JobStore,
	error: unknown,
	job: Job,
	runToken: string,
	now: string,
	startedAt: number,
	retryDelaySeconds: number,
): Promise<"ack" | "retry"> {
	const described = describeAgentError(error);
	console.warn(
		JSON.stringify({
			event: "agent_execution_error",
			...described,
		}),
	);
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
		return decideRetryOrFail(
			store,
			job,
			runToken,
			described.reasonCode,
			"exception",
			startedAt,
			retryDelaySeconds,
			now,
		);
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

async function handleAgentResult(
	store: D1JobStore,
	result: AgentRunResult,
	job: Job,
	runToken: string,
	now: string,
	startedAt: number,
	retryDelaySeconds: number,
): Promise<"ack" | "retry"> {
	console.info(
		JSON.stringify({
			event: "agent_execution_result",
			outcome: result.outcome,
			reasonCode: "reasonCode" in result ? result.reasonCode : null,
			retryable: result.outcome === "failed" ? result.retryable : false,
		}),
	);

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
			// `recordUncertain` accepts `submitting` as well as `running`, so a
			// concurrent submission cannot make this write lose: no conflict to close.
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
				if (current?.status !== "running" || current.runToken !== runToken) {
					return "ack";
				}
				return decideRetryOrFail(
					store,
					job,
					runToken,
					result.reasonCode,
					"result",
					startedAt,
					retryDelaySeconds,
					now,
				);
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

/**
 * Reached: this attempt is the last one the job is allowed. It gates the
 * failure paths inside an attempt -- `decideRetryOrFail` and the catch in
 * `consumeJobBatch` -- which record a failure instead of scheduling one more
 * delivery.
 */
function hasReachedAttemptLimit(job: Job): boolean {
	const value = job.payload[MAX_ATTEMPTS_KEY];
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		job.attemptCount >= value
	);
}

/**
 * Exceeded: a previous attempt was already the last one, so this delivery is
 * one too many. It gates the redelivery check near the top of
 * `consumeJobBatch`, which ends the job before any agent work starts.
 */
function hasExceededAttemptLimit(job: Job): boolean {
	const value = job.payload[MAX_ATTEMPTS_KEY];
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		job.attemptCount > value
	);
}

async function recordRetryScheduled(
	store: D1JobStore,
	job: Job,
	runToken: string,
	reasonCode: string,
	source: "consumer" | "exception" | "result",
	startedAt: number,
	delaySeconds: number,
): Promise<void> {
	try {
		const recorded = await store.recordRetryScheduled(
			job.id,
			runToken,
			job.attemptCount,
			reasonCode,
			source,
			Math.max(0, Date.now() - startedAt),
			delaySeconds,
			new Date().toISOString(),
		);
		if (!recorded) {
			console.warn(
				JSON.stringify({
					event: "retry_event_not_recorded",
					reasonCode,
				}),
			);
		}
	} catch {
		console.warn(
			JSON.stringify({
				event: "retry_event_record_failed",
				reasonCode,
			}),
		);
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

function isJobMessage(value: unknown): value is JobMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"jobId" in value &&
		typeof value.jobId === "string" &&
		value.jobId.length > 0
	);
}
