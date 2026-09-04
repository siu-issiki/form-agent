import {
	AgentExecutionError,
	type AgentExecutor,
	executeAgent,
} from "./agent-executor";
import type { AgentRunResult } from "./agent-runtime";
import { BrowserUseClient } from "./browser-use-client";
import { reclaimJobSessions } from "./browser-use-session";
import { D1JobStore } from "./d1-job-store";
import {
	DRY_RUN_KEY,
	DuplicateJobError,
	EFFECTIVE_DRY_RUN_KEY,
	JOB_ID_PATTERN,
	type Job,
	type JobInput,
	MAX_ATTEMPTS_KEY,
} from "./job";
import { isRecord } from "./json-record";
import { checkRealSendGuard, type RealSendRefusal } from "./real-send-guard";
import { ResponsesAgentExecutor } from "./responses-agent-executor";
import {
	assertAllowedTargetUrl,
	isTrustedFormValue,
	normalizeAllowedHosts,
	normalizeTargetDomain,
	PAYLOAD_KEY_PATTERN,
} from "./restricted-browser";
import {
	isRealSendPayload,
	isSendApproval,
	REAL_SEND_GUARD_EXEMPT_KEY,
	SEND_APPROVAL_KEY,
} from "./send-approval";
import { R2EvidenceObjectStore } from "./submission-evidence";

export interface JobMessage {
	jobId: string;
}

export interface Env {
	DB: D1Database;
	JOB_QUEUE: Queue<JobMessage>;
	EVIDENCE_BUCKET: R2Bucket;
	AGENT_EXECUTOR_ENABLED?: string;
	AGENT_MODEL?: string;
	AGENT_SUBMIT_REVIEW_MODEL?: string;
	AGENT_DRY_RUN?: string;
	OPENAI_API_KEY?: string;
	BROWSER_USE_API_KEY?: string;
	JOB_API_TOKEN?: string;
	/**
	 * How many real-send jobs may be registered in one UTC day. Unset, empty,
	 * or unparsable means 0: the API then accepts no real-send job at all, so a
	 * plain deploy that carries only the values in `wrangler.jsonc` closes the
	 * path again.
	 */
	REAL_SEND_DAILY_CAP?: string;
	/**
	 * Comma-separated registrable domains whose jobs skip the real-send guard.
	 * It exists for the managed test system only: those submissions are real by
	 * nature, have no dry-run to approve against, and must not spend the day's
	 * cap. Unset or empty means no exemption. A customer domain must never be
	 * listed here -- anything on this list can be sent to with no human
	 * approval record at all.
	 */
	REAL_SEND_GUARD_EXEMPT_DOMAINS?: string;
}

export interface RegisterJobResult {
	created: boolean;
	job: Job;
}

interface JobQueue {
	send(message: JobMessage): Promise<unknown>;
}

const DEAD_LETTER_QUEUE = "form-agent-jobs-dlq";
const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 300;
const RETRY_JITTER_RATIO = 0.2;
/** 2^10 already exceeds the cap, so the exponent never needs to grow. */
const MAX_RETRY_EXPONENT = 10;
const MAX_AGENT_DURATION_MS = 10 * 60 * 1000;
/** The reclaim runs after the job is already lost, so it waits only briefly. */
const SESSION_RECLAIM_TIMEOUT_MS = 10_000;
const MAX_JOB_REQUEST_BYTES = 64 * 1024;

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
		if (!hasSameInput(existing, input)) {
			throw new ConflictingJobError(input.id);
		}
		job = existing;
	}

	if (job.status === "pending") {
		// A real send that has sat pending across a UTC day boundary no longer
		// sits under the cap it was accepted against, and its approval was made
		// against a dry-run of another day. Re-queueing it would send without
		// either check being current, so the operator has to re-approve.
		if (isRealSendPayload(job.payload) && !isSameUtcDay(job.createdAt, now)) {
			throw new StaleRealSendError(job.id);
		}
		await queue.send({ jobId: job.id });
	}

	return { created, job };
}

/** Compares two ISO timestamps by UTC day; an unparsable value is never equal. */
function isSameUtcDay(left: string, right: string): boolean {
	const leftDay = utcDay(left);
	return leftDay !== null && leftDay === utcDay(right);
}

function utcDay(value: string): string | null {
	const time = Date.parse(value);
	return Number.isFinite(time)
		? new Date(time).toISOString().slice(0, 10)
		: null;
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
			input = markRealSendGuardExemption(
				freezeDryRunMode(
					await parseJobInput(request),
					isAgentDryRun(env.AGENT_DRY_RUN),
				),
				realSendGuardExemptDomains(env.REAL_SEND_GUARD_EXEMPT_DOMAINS),
			);
		} catch (error) {
			if (error instanceof InvalidJobRequestError) {
				return apiJson({ error: error.code }, error.status);
			}
			throw error;
		}

		const now = new Date();
		const refused = await refuseUnapprovedRealSend(env, input, now);
		if (refused) return refused;

		let registered: RegisterJobResult;
		try {
			registered = await registerJob(
				env.DB,
				env.JOB_QUEUE,
				input,
				now.toISOString(),
			);
		} catch (error) {
			if (error instanceof ConflictingJobError) {
				return apiJson({ error: "JOB_ID_CONFLICT" }, 409);
			}
			if (error instanceof StaleRealSendError) {
				return apiJson({ error: "REAL_SEND_STALE" }, 409);
			}
			throw error;
		}
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
		const store = new D1JobStore(env.DB);
		const job = await store.find(jobId);
		if (!job) return apiJson({ error: "NOT_FOUND" }, 404);
		// Only the object identity: the evidence objects themselves hold the
		// page and the registration values, and stay in R2.
		const evidence = await store.listCapturedEvidence(jobId);
		return apiJson({ job: toPublicJob(job), evidence }, 200);
	}

	return new Response("Not Found", { status: 404 });
}

/** HTTP status each real-send refusal is reported with. */
const REAL_SEND_REFUSAL_STATUS: Record<RealSendRefusal, number> = {
	SEND_APPROVAL_REQUIRED: 400,
	DRY_RUN_NOT_COMPLETED: 400,
	DRY_RUN_CONTENT_MISMATCH: 400,
	REAL_SEND_CAP_REACHED: 429,
};

/**
 * Refuses a job the real-send guard does not allow, as the HTTP answer the
 * caller sees. The decision itself lives in `checkRealSendGuard`; this only
 * maps each refusal onto its status code.
 */
async function refuseUnapprovedRealSend(
	env: Env,
	input: JobInput,
	now: Date,
): Promise<Response | null> {
	const decision = await checkRealSendGuard(
		input,
		now,
		realSendDailyCap(env.REAL_SEND_DAILY_CAP),
		new D1JobStore(env.DB),
	);
	if (decision.allowed) return null;
	return apiJson(
		{ error: decision.refusal },
		REAL_SEND_REFUSAL_STATUS[decision.refusal],
	);
}

/**
 * Reads the daily real-send cap. Anything that is not a plain non-negative
 * integer is 0, so a typo in a deploy flag closes the path instead of opening
 * an unintended one.
 */
export function realSendDailyCap(value: string | undefined): number {
	const trimmed = value?.trim() ?? "";
	return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : 0;
}

/**
 * Reads the domains whose jobs skip the real-send guard. Each entry must be a
 * registrable domain; an entry that is not one is dropped, so a typo removes
 * an exemption rather than granting a wider one. Unset or empty means no
 * exemption at all, which is the state a plain deploy leaves behind.
 *
 * This list is for the managed test system only. A customer domain listed here
 * could be sent to with no approval record and without spending the day's cap.
 */
export function realSendGuardExemptDomains(
	value: string | undefined,
): string[] {
	const exempt: string[] = [];
	for (const entry of (value ?? "").split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		try {
			exempt.push(normalizeTargetDomain(trimmed));
		} catch {
			// Not a registrable domain, so it can never match a job's domain.
		}
	}
	return exempt;
}

/**
 * Whether the job's target domain is one of the exempt domains, or below it.
 * The job domain is only case-folded here rather than reduced to a registrable
 * domain, so that a host under an exempt domain also matches; every entry it
 * is compared against is already a registrable domain.
 */
export function isRealSendGuardExempt(
	targetDomain: string,
	exemptDomains: readonly string[],
): boolean {
	const normalized = targetDomain.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized) return false;
	return exemptDomains.some(
		(domain) => normalized === domain || normalized.endsWith(`.${domain}`),
	);
}

/**
 * Stamps the exemption the API decided from its own configuration. The key is
 * always removed first: it is what keeps a job out of the daily real-send
 * count, so a caller must never be able to set it. A job that is not exempt
 * keeps exactly the payload it arrived with.
 */
function markRealSendGuardExemption(
	input: JobInput,
	exemptDomains: readonly string[],
): JobInput {
	const { [REAL_SEND_GUARD_EXEMPT_KEY]: _supplied, ...payload } = input.payload;
	return {
		...input,
		payload: isRealSendGuardExempt(input.targetDomain, exemptDomains)
			? { ...payload, [REAL_SEND_GUARD_EXEMPT_KEY]: true }
			: payload,
	};
}

function freezeDryRunMode(
	input: JobInput,
	environmentDryRun: boolean,
): JobInput {
	return {
		...input,
		payload: {
			...input.payload,
			[EFFECTIVE_DRY_RUN_KEY]:
				environmentDryRun || input.payload[DRY_RUN_KEY] === true,
		},
	};
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

	const rawBody = await readBoundedBody(request);

	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		throw new InvalidJobRequestError("INVALID_JSON", 400);
	}
	if (!isRecord(body)) {
		throw new InvalidJobRequestError("INVALID_JOB", 400);
	}

	const {
		id,
		companyId,
		companyName,
		targetUrl,
		targetDomain,
		allowedHosts = [],
		payload,
	} = body;
	if (
		typeof id !== "string" ||
		!JOB_ID_PATTERN.test(id) ||
		!validRequiredString(companyId, 128) ||
		!validRequiredString(companyName, 256) ||
		!validRequiredString(targetUrl, 2_048) ||
		!validRequiredString(targetDomain, 253) ||
		!Array.isArray(allowedHosts) ||
		!isRecord(payload) ||
		!hasValidSendApproval(payload) ||
		!hasValidFormValues(payload)
	) {
		throw new InvalidJobRequestError("INVALID_JOB", 400);
	}

	try {
		const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
		assertAllowedTargetUrl(targetUrl, targetDomain, normalizedAllowedHosts);
		return {
			id,
			companyId,
			companyName,
			targetUrl,
			targetDomain,
			allowedHosts: normalizedAllowedHosts,
			payload,
		};
	} catch {
		throw new InvalidJobRequestError("INVALID_JOB", 400);
	}
}

/**
 * A malformed approval record is rejected for every job, dry-run included, so
 * that the audit trail never holds a half-filled approval.
 */
function hasValidSendApproval(payload: Record<string, unknown>): boolean {
	const approval = payload[SEND_APPROVAL_KEY];
	return approval === undefined || isSendApproval(approval);
}

function hasValidFormValues(payload: Record<string, unknown>): boolean {
	const requestedDryRun = payload[DRY_RUN_KEY];
	if (requestedDryRun !== undefined && typeof requestedDryRun !== "boolean") {
		return false;
	}
	const maxAttempts = payload[MAX_ATTEMPTS_KEY];
	if (
		maxAttempts !== undefined &&
		(typeof maxAttempts !== "number" ||
			!Number.isInteger(maxAttempts) ||
			maxAttempts < 1 ||
			maxAttempts > 4)
	) {
		return false;
	}
	const formValues = payload.formValues;
	if (!isRecord(formValues) || Object.keys(formValues).length === 0) {
		return false;
	}
	// A value is either a single string or an ordered candidate list for one
	// choice control; both contracts live in restricted-browser so that the
	// registration and the tool handler can never diverge.
	return Object.entries(formValues).every(
		([key, value]) =>
			PAYLOAD_KEY_PATTERN.test(key) && isTrustedFormValue(value),
	);
}

async function readBoundedBody(request: Request): Promise<string> {
	if (!request.body) return "";

	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let body = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_JOB_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new InvalidJobRequestError("REQUEST_TOO_LARGE", 413);
			}
			body += decoder.decode(value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		reader.releaseLock();
	}
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

class InvalidJobRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

class ConflictingJobError extends Error {
	constructor(id: string) {
		super(`Job input conflicts with the existing job: ${id}`);
	}
}

class StaleRealSendError extends Error {
	constructor(id: string) {
		super(`Pending real-send job is from an earlier UTC day: ${id}`);
	}
}

function hasSameInput(job: Job, input: JobInput): boolean {
	return (
		job.companyId === input.companyId &&
		job.companyName === input.companyName &&
		job.targetUrl === input.targetUrl &&
		job.targetDomain === input.targetDomain &&
		hasSameJsonValue(job.allowedHosts, input.allowedHosts) &&
		hasSameJsonValue(job.payload, input.payload)
	);
}

function hasSameJsonValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => hasSameJsonValue(value, right[index]))
		);
	}
	if (!isRecord(left) || !isRecord(right)) return false;

	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] && hasSameJsonValue(left[key], right[key]),
		)
	);
}

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
		console.warn(
			JSON.stringify({
				event: "agent_execution_error",
				reasonCode:
					error instanceof AgentExecutionError
						? error.reasonCode
						: "UNEXPECTED_AGENT_ERROR",
				retryable:
					error instanceof AgentExecutionError ? error.retryable : true,
				...(error instanceof AgentExecutionError && error.cdpMethod
					? { method: error.cdpMethod, kind: error.cdpKind }
					: {}),
				...(error instanceof AgentExecutionError && error.detail
					? { detail: error.detail }
					: {}),
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
			if (hasReachedAttemptLimit(job)) {
				await store.recordFailed(
					job.id,
					runToken,
					error instanceof AgentExecutionError
						? error.reasonCode
						: "UNEXPECTED_AGENT_ERROR",
					"The agent failed at the job attempt limit.",
					now,
				);
				return "ack";
			}
			await recordRetryScheduled(
				store,
				job,
				runToken,
				error instanceof AgentExecutionError
					? error.reasonCode
					: "UNEXPECTED_AGENT_ERROR",
				"exception",
				startedAt,
				retryDelaySeconds,
			);
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
				if (hasReachedAttemptLimit(job)) {
					await store.recordFailed(
						job.id,
						runToken,
						result.reasonCode,
						"The agent failed at the job attempt limit.",
						now,
					);
					return "ack";
				}
				await recordRetryScheduled(
					store,
					job,
					runToken,
					result.reasonCode,
					"result",
					startedAt,
					retryDelaySeconds,
				);
				return "retry";
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

function hasReachedAttemptLimit(job: Job): boolean {
	const value = job.payload[MAX_ATTEMPTS_KEY];
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		job.attemptCount >= value
	);
}

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

function createAgentExecutor(env: Env): AgentExecutor {
	if (
		env.AGENT_EXECUTOR_ENABLED === "true" &&
		env.AGENT_MODEL &&
		env.OPENAI_API_KEY &&
		env.BROWSER_USE_API_KEY &&
		env.EVIDENCE_BUCKET
	) {
		return new ResponsesAgentExecutor({
			db: env.DB,
			evidenceStore: new R2EvidenceObjectStore(env.EVIDENCE_BUCKET),
			model: env.AGENT_MODEL,
			reviewModel: env.AGENT_SUBMIT_REVIEW_MODEL || env.AGENT_MODEL,
			openAiApiKey: env.OPENAI_API_KEY,
			browserUseApiKey: env.BROWSER_USE_API_KEY,
			// Jobs created before effective mode persistence must remain dry-run.
			dryRun: true,
		});
	}
	return {
		async execute() {
			return {
				outcome: "failed",
				reasonCode: "EXECUTOR_NOT_CONFIGURED",
				reason: "The agent executor has not been configured yet.",
				retryable: false,
			};
		},
	};
}

export function isAgentDryRun(value: string | undefined): boolean {
	return value !== "false";
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
