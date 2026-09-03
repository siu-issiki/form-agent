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

export type EvidenceStage = "before_submit" | "after_submit" | "prohibited";

export type EvidenceFailureCode =
	| "SCREENSHOT_FAILED"
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

export interface JobEvent {
	jobId: string;
	attempt: number;
	type: string;
	data: Record<string, unknown>;
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
		sha256: string,
		byteLength: number,
		now: string,
	): Promise<boolean>;
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

export class DuplicateJobError extends Error {
	constructor(id: string) {
		super(`Job already exists: ${id}`);
		this.name = "DuplicateJobError";
	}
}

export class InMemoryJobStore implements JobStore {
	readonly #jobs = new Map<string, Job>();
	readonly #evidenceEventIndexes = new Map<string, number>();
	readonly events: JobEvent[] = [];

	async create(input: JobInput, now: string): Promise<Job> {
		if (this.#jobs.has(input.id)) {
			throw new DuplicateJobError(input.id);
		}

		const job: Job = {
			...structuredClone(input),
			status: "pending",
			attemptCount: 0,
			submitReviewDenialCount: 0,
			runToken: null,
			result: null,
			createdAt: now,
			updatedAt: now,
		};
		this.#jobs.set(job.id, job);
		return structuredClone(job);
	}

	async find(id: string): Promise<Job | null> {
		const job = this.#jobs.get(id);
		return job ? structuredClone(job) : null;
	}

	async claimRun(
		id: string,
		runToken: string,
		now: string,
	): Promise<Job | null> {
		const job = this.#jobs.get(id);
		if (job?.status !== "pending") {
			return null;
		}

		const updated: Job = {
			...job,
			status: "running",
			attemptCount: job.attemptCount + 1,
			runToken,
			updatedAt: now,
		};
		this.#jobs.set(id, updated);
		return structuredClone(updated);
	}

	async claimSubmission(
		id: string,
		runToken: string,
		now: string,
	): Promise<Job | null> {
		const job = this.#jobs.get(id);
		if (job?.status !== "running" || job.runToken !== runToken) {
			return null;
		}

		const updated: Job = { ...job, status: "submitting", updatedAt: now };
		this.#jobs.set(id, updated);
		return structuredClone(updated);
	}

	async recordRunAttempt(
		id: string,
		runToken: string,
		attempt: number,
		now: string,
	): Promise<Job | null> {
		const job = this.#jobs.get(id);
		if (job?.status !== "running" || job.runToken !== runToken) {
			return null;
		}

		const updated: Job = {
			...job,
			attemptCount: Math.max(job.attemptCount, attempt),
			updatedAt: now,
		};
		this.#jobs.set(id, updated);
		return structuredClone(updated);
	}

	async recordSent(
		id: string,
		runToken: string,
		formUrl: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["submitting"], now, {
			outcome: "sent",
			formUrl,
			reasonCode: null,
			reason: null,
			completedAt: now,
		});
	}

	async recordProhibited(
		id: string,
		runToken: string,
		formUrl: string | null,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["running"], now, {
			outcome: "prohibited",
			formUrl,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	async recordUncertain(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["running", "submitting"], now, {
			outcome: "uncertain",
			formUrl: null,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	async recordSubmitReviewDenial(
		id: string,
		runToken: string,
		now: string,
	): Promise<number | null> {
		const job = this.#jobs.get(id);
		if (job?.status !== "running" || job.runToken !== runToken) {
			return null;
		}

		const submitReviewDenialCount = job.submitReviewDenialCount + 1;
		this.#jobs.set(id, { ...job, submitReviewDenialCount, updatedAt: now });
		return submitReviewDenialCount;
	}

	async recordFailed(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["running"], now, {
			outcome: "failed",
			formUrl: null,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	/** Mirrors `D1JobStore.recordAgentRunMetrics`: one row per finished run. */
	async recordAgentRunMetrics(
		id: string,
		runToken: string,
		attempt: number,
		metrics: AgentRunMetrics,
		_now: string,
	): Promise<boolean> {
		const job = this.#jobs.get(id);
		if (
			!job ||
			job.status === "pending" ||
			job.status === "dead_lettered" ||
			job.runToken !== runToken
		) {
			return false;
		}

		this.events.push({
			jobId: id,
			attempt,
			type: "agent.run_metrics",
			data: { ...metrics },
		});
		return true;
	}

	async recordEvidenceIntent(
		id: string,
		runToken: string,
		attempt: number,
		eventId: string,
		stage: EvidenceStage,
		objectKey: string,
		_now: string,
	): Promise<boolean> {
		return this.#recordEvidenceEvent(
			id,
			runToken,
			attempt,
			eventId,
			"evidence.intent",
			{ eventId, stage, objectKey },
		);
	}

	async recordEvidenceCaptured(
		id: string,
		_runToken: string,
		attempt: number,
		eventId: string,
		stage: EvidenceStage,
		objectKey: string,
		sha256: string,
		byteLength: number,
		_now: string,
	): Promise<boolean> {
		return this.#transitionEvidenceEvent(
			id,
			attempt,
			eventId,
			["evidence.intent"],
			"evidence.captured",
			{
				eventId,
				stage,
				objectKey,
				sha256,
				byteLength,
				contentType: "image/jpeg",
			},
		);
	}

	async recordEvidenceCaptureFailed(
		id: string,
		runToken: string,
		attempt: number,
		eventId: string,
		stage: EvidenceStage,
		failureCode: EvidenceFailureCode,
		_now: string,
	): Promise<boolean> {
		const index = this.#evidenceEventIndexes.get(eventId);
		if (index !== undefined) {
			// The object key survives the failure so an upload that was already
			// started stays traceable.
			const objectKey = this.events[index]?.data.objectKey;
			return this.#transitionEvidenceEvent(
				id,
				attempt,
				eventId,
				["evidence.intent", "evidence.captured"],
				"evidence.capture_failed",
				{
					stage,
					failureCode,
					...(objectKey === undefined ? {} : { objectKey }),
				},
			);
		}

		return this.#recordEvidenceEvent(
			id,
			runToken,
			attempt,
			eventId,
			"evidence.capture_failed",
			{
				stage,
				failureCode,
			},
		);
	}

	#transitionEvidenceEvent(
		id: string,
		attempt: number,
		eventId: string,
		fromTypes: readonly string[],
		type: string,
		data: Record<string, unknown>,
	): boolean {
		const index = this.#evidenceEventIndexes.get(eventId);
		if (index === undefined) return false;
		const existing = this.events[index];
		if (
			!existing ||
			existing.jobId !== id ||
			existing.attempt !== attempt ||
			!fromTypes.includes(existing.type)
		) {
			return false;
		}

		this.events[index] = { jobId: id, attempt, type, data };
		return true;
	}

	#recordEvidenceEvent(
		id: string,
		runToken: string,
		attempt: number,
		eventId: string,
		type: string,
		data: Record<string, unknown>,
	): boolean {
		const job = this.#jobs.get(id);
		if (
			!job ||
			(job.status !== "running" && job.status !== "submitting") ||
			job.runToken !== runToken ||
			job.attemptCount !== attempt ||
			this.#evidenceEventIndexes.has(eventId)
		) {
			return false;
		}

		this.#evidenceEventIndexes.set(eventId, this.events.length);
		this.events.push({
			jobId: id,
			attempt: job.attemptCount,
			type,
			data,
		});
		return true;
	}

	#finish(
		id: string,
		runToken: string,
		expectedStatuses: readonly ("running" | "submitting")[],
		now: string,
		result: JobResult,
	): Job | null {
		const job = this.#jobs.get(id);
		if (
			!job ||
			!expectedStatuses.includes(job.status as "running" | "submitting") ||
			job.runToken !== runToken
		) {
			return null;
		}

		const updated: Job = {
			...job,
			status: result.outcome,
			result,
			updatedAt: now,
		};
		this.#jobs.set(id, updated);
		return structuredClone(updated);
	}
}
