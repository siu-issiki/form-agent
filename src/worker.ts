import type { AgentExecutor } from "./agent-executor";
import { D1JobStore } from "./d1-job-store";
import type { Env, JobMessage } from "./env";
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
import { consumeJobBatch } from "./queue-consumer";
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
	isSendApproval,
	REAL_SEND_GUARD_EXEMPT_KEY,
	SEND_APPROVAL_KEY,
} from "./send-approval";
import { R2EvidenceObjectStore } from "./submission-evidence";

export interface RegisterJobResult {
	created: boolean;
	job: Job;
}

interface JobQueue {
	send(message: JobMessage): Promise<unknown>;
}

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
		const refused = await refuseUnapprovedRealSend(env, input);
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
	SEND_APPROVAL_CONTENT_MISMATCH: 400,
};

/**
 * Refuses a job the real-send guard does not allow, as the HTTP answer the
 * caller sees. The decision itself lives in `checkRealSendGuard`; this only
 * maps each refusal onto its status code.
 */
async function refuseUnapprovedRealSend(
	env: Env,
	input: JobInput,
): Promise<Response | null> {
	const decision = await checkRealSendGuard(input, new D1JobStore(env.DB));
	if (decision.allowed) return null;
	return apiJson(
		{ error: decision.refusal },
		REAL_SEND_REFUSAL_STATUS[decision.refusal],
	);
}

/**
 * Reads the domains whose jobs skip the real-send guard. Each entry must be a
 * registrable domain; an entry that is not one is dropped, so a typo removes
 * an exemption rather than granting a wider one. Unset or empty means no
 * exemption at all.
 *
 * This list is for the managed test system only. A customer domain listed here
 * could be sent to with no approval record.
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
 * always removed first: it is what keeps a job out of the real-send
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
