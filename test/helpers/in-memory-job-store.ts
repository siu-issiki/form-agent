import {
	type AgentRunMetrics,
	type CapturedEvidence,
	DuplicateJobError,
	type EvidenceFailureCode,
	type EvidenceStage,
	type Job,
	type JobInput,
	type JobResult,
	type JobStore,
} from "../../src/job";

export interface JobEvent {
	jobId: string;
	attempt: number;
	type: string;
	data: Record<string, unknown>;
}

export class InMemoryJobStore implements JobStore {
	readonly #jobs = new Map<string, Job>();
	readonly #evidenceEventIndexes = new Map<string, number>();
	/** `events` carries no timestamp, so the capture time is kept beside it. */
	readonly #evidenceCapturedAt = new Map<string, string>();
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

	/** Mirrors `D1JobStore.recordSubmitStage`: one row per stage past the first. */
	async recordSubmitStage(
		id: string,
		runToken: string,
		stage: number,
		requestObserved: boolean,
		_now: string,
	): Promise<boolean> {
		const job = this.#jobs.get(id);
		if (job?.status !== "submitting" || job.runToken !== runToken) {
			return false;
		}

		this.events.push({
			jobId: id,
			attempt: job.attemptCount,
			type: "submit.stage",
			data: { stage, requestObserved },
		});
		return true;
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
		contentType: string,
		sha256: string,
		byteLength: number,
		now: string,
	): Promise<boolean> {
		const recorded = this.#transitionEvidenceEvent(
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
				contentType,
			},
		);
		if (recorded) this.#evidenceCapturedAt.set(eventId, now);
		return recorded;
	}

	async listCapturedEvidence(id: string): Promise<CapturedEvidence[]> {
		const captured: CapturedEvidence[] = [];
		for (const event of this.events) {
			if (event.jobId !== id || event.type !== "evidence.captured") continue;
			const eventId = event.data.eventId;
			captured.push({
				stage: event.data.stage as EvidenceStage,
				objectKey: event.data.objectKey as string,
				contentType: event.data.contentType as string,
				capturedAt:
					(typeof eventId === "string"
						? this.#evidenceCapturedAt.get(eventId)
						: undefined) ?? "",
			});
		}
		return captured;
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
