/**
 * Shape every job id must have. It lives here because the API path parser, the
 * registration check, and the send-approval record all have to agree on it.
 */
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type JobStatus =
	| "pending"
	| "running"
	| "submitting"
	| "sent"
	| "prohibited"
	| "uncertain"
	| "failed"
	| "dead_lettered";

export interface JobInput {
	id: string;
	companyId: string;
	companyName: string;
	targetUrl: string;
	targetDomain: string;
	allowedHosts: string[];
	payload: Record<string, unknown>;
}

export interface JobResult {
	outcome: "sent" | "prohibited" | "uncertain" | "failed";
	formUrl: string | null;
	reasonCode: string | null;
	reason: string | null;
	completedAt: string;
}

export interface Job extends JobInput {
	status: JobStatus;
	attemptCount: number;
	/**
	 * Pre-submit review denials for this job. It is persisted rather than held
	 * in memory so that a Queue redelivery keeps the same correction budget.
	 */
	submitReviewDenialCount: number;
	runToken: string | null;
	result: JobResult | null;
	createdAt: string;
	updatedAt: string;
}

export type EvidenceStage =
	| "before_submit"
	| "after_submit"
	| "prohibited"
	| "dry_run_before_submit"
	| "dry_run_field_map";

export type EvidenceFailureCode =
	| "SCREENSHOT_FAILED"
	| "SERIALIZE_FAILED"
	| "OBJECT_STORE_FAILED"
	| "EVENT_NOT_RECORDED"
	| "NO_BROWSER_SESSION"
	| "CAPTURE_TIMEOUT";

/** Fixed end state of one agent run, recorded with the run metrics. */
export type AgentRunOutcome =
	| "sent"
	| "prohibited"
	| "uncertain"
	| "failed"
	| "error";

/**
 * Per-run counters of one agent execution. Every field is a number, a boolean,
 * or a fixed code, so the event carries no page content, value, or URL.
 */
export interface AgentRunMetrics {
	turns: number;
	providerRequests: number;
	reviewRequests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cachedTokens: number;
	browserConnectMs: number | null;
	browserConnected: boolean;
	submitReviewAllow: number;
	submitReviewDeny: number;
	durationMs: number;
	outcome: AgentRunOutcome;
}

export interface JobStore {
	create(input: JobInput, now: string): Promise<Job>;
	find(id: string): Promise<Job | null>;
	claimRun(id: string, runToken: string, now: string): Promise<Job | null>;
	recordRunAttempt(
		id: string,
		runToken: string,
		attempt: number,
		now: string,
	): Promise<Job | null>;
	claimSubmission(
		id: string,
		runToken: string,
		now: string,
	): Promise<Job | null>;
	recordSent(
		id: string,
		runToken: string,
		formUrl: string,
		now: string,
	): Promise<Job | null>;
	recordProhibited(
		id: string,
		runToken: string,
		formUrl: string | null,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null>;
	recordUncertain(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null>;
	/**
	 * Counts one pre-submit review denial and returns the new total, or null
	 * when the job is no longer running under this run token.
	 */
	recordSubmitReviewDenial(
		id: string,
		runToken: string,
		now: string,
	): Promise<number | null>;
	recordFailed(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null>;
	/**
	 * Records a submit activation past the first one of the same submission.
	 * The permission itself was taken by the first stage, so this only leaves a
	 * trail of how many stages ran and whether each sent a request.
	 */
	recordSubmitStage(
		id: string,
		runToken: string,
		stage: number,
		requestObserved: boolean,
		now: string,
	): Promise<boolean>;
	/**
	 * Declares the object key before the screenshot reaches the object store.
	 * The same event id later becomes `captured` or `capture_failed`, so a row
	 * that stays `intent` names an orphan object.
	 */
	recordEvidenceIntent(
		id: string,
		runToken: string,
		attempt: number,
		eventId: string,
		stage: EvidenceStage,
		objectKey: string,
		now: string,
	): Promise<boolean>;
	recordEvidenceCaptured(
		id: string,
		runToken: string,
		attempt: number,
		eventId: string,
		stage: EvidenceStage,
		objectKey: string,
		contentType: string,
		sha256: string,
		byteLength: number,
		now: string,
	): Promise<boolean>;
	/**
	 * Captured evidence of one job, oldest first. Only the object identity is
	 * returned: the object bodies hold page content and registration values, so
	 * they stay in the object store.
	 */
	listCapturedEvidence(id: string): Promise<CapturedEvidence[]>;
	recordEvidenceCaptureFailed(
		id: string,
		runToken: string,
		attempt: number,
		eventId: string,
		stage: EvidenceStage,
		failureCode: EvidenceFailureCode,
		now: string,
	): Promise<boolean>;
}

/** One `evidence.captured` row, as the job API exposes it. */
export interface CapturedEvidence {
	stage: EvidenceStage;
	objectKey: string;
	contentType: string;
	capturedAt: string;
}

export class DuplicateJobError extends Error {
	constructor(id: string) {
		super(`Job already exists: ${id}`);
		this.name = "DuplicateJobError";
	}
}
