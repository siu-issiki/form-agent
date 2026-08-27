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
	runToken: string | null;
	result: JobResult | null;
	createdAt: string;
	updatedAt: string;
}

export interface JobStore {
	create(input: JobInput, now: string): Promise<Job>;
	find(id: string): Promise<Job | null>;
	claimRun(id: string, runToken: string, now: string): Promise<Job | null>;
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
	recordUncertain(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null>;
}

export class DuplicateJobError extends Error {
	constructor(id: string) {
		super(`Job already exists: ${id}`);
		this.name = "DuplicateJobError";
	}
}

export class InMemoryJobStore implements JobStore {
	readonly #jobs = new Map<string, Job>();

	async create(input: JobInput, now: string): Promise<Job> {
		if (this.#jobs.has(input.id)) {
			throw new DuplicateJobError(input.id);
		}

		const job: Job = {
			...structuredClone(input),
			status: "pending",
			attemptCount: 0,
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

	async recordSent(
		id: string,
		runToken: string,
		formUrl: string,
		now: string,
	): Promise<Job | null> {
		return this.#finishSubmission(id, runToken, now, {
			outcome: "sent",
			formUrl,
			reasonCode: null,
			reason: null,
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
		return this.#finishSubmission(id, runToken, now, {
			outcome: "uncertain",
			formUrl: null,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	#finishSubmission(
		id: string,
		runToken: string,
		now: string,
		result: JobResult,
	): Job | null {
		const job = this.#jobs.get(id);
		if (job?.status !== "submitting" || job.runToken !== runToken) {
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
