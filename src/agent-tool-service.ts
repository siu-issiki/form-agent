import { WorkerEntrypoint } from "cloudflare:workers";
import { D1JobStore } from "./d1-job-store";
import type { Job } from "./job";
import { assertAllowedTargetUrl } from "./restricted-browser";

export interface AgentToolEnv {
	DB: D1Database;
}

export class AgentToolGateway {
	readonly #store: D1JobStore;

	constructor(
		db: D1Database,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.#store = new D1JobStore(db);
	}

	async find(jobId: string, runToken: string): Promise<Job | null> {
		assertIdentifier(jobId);
		assertIdentifier(runToken);
		const job = await this.#store.find(jobId);
		if (
			!job ||
			(job.status !== "running" && job.status !== "submitting") ||
			job.runToken !== runToken
		) {
			return null;
		}
		return job;
	}

	async claimSubmission(jobId: string, runToken: string): Promise<Job | null> {
		assertIdentifier(jobId);
		assertIdentifier(runToken);
		return this.#store.claimSubmission(jobId, runToken, this.now());
	}

	async recordSent(
		jobId: string,
		runToken: string,
		formUrl: string,
	): Promise<Job | null> {
		const job = await this.find(jobId, runToken);
		if (job?.status !== "submitting") {
			return null;
		}
		assertAllowedTargetUrl(formUrl, job.targetDomain);
		return this.#store.recordSent(jobId, runToken, formUrl, this.now());
	}

	async recordUncertain(
		jobId: string,
		runToken: string,
		reasonCode: string,
		reason: string,
	): Promise<Job | null> {
		assertIdentifier(jobId);
		assertIdentifier(runToken);
		assertReason(reasonCode, reason);
		return this.#store.recordUncertain(
			jobId,
			runToken,
			reasonCode,
			reason,
			this.now(),
		);
	}
}

export class AgentToolService extends WorkerEntrypoint<AgentToolEnv> {
	find(jobId: string, runToken: string): Promise<Job | null> {
		return this.#gateway().find(jobId, runToken);
	}

	claimSubmission(jobId: string, runToken: string): Promise<Job | null> {
		return this.#gateway().claimSubmission(jobId, runToken);
	}

	recordSent(
		jobId: string,
		runToken: string,
		formUrl: string,
	): Promise<Job | null> {
		return this.#gateway().recordSent(jobId, runToken, formUrl);
	}

	recordUncertain(
		jobId: string,
		runToken: string,
		reasonCode: string,
		reason: string,
	): Promise<Job | null> {
		return this.#gateway().recordUncertain(jobId, runToken, reasonCode, reason);
	}

	#gateway(): AgentToolGateway {
		return new AgentToolGateway(this.env.DB);
	}
}

function assertIdentifier(value: string): void {
	if (!value || value.length > 128) {
		throw new Error("Invalid agent tool identifier");
	}
}

function assertReason(reasonCode: string, reason: string): void {
	if (
		!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode) ||
		!reason ||
		reason.length > 1_000
	) {
		throw new Error("Invalid agent tool reason");
	}
}
