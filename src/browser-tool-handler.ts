import { D1JobStore } from "./d1-job-store";
import type { Job } from "./job";
import {
	type BrowserObservation,
	PAYLOAD_KEY_PATTERN,
	type ProhibitedReasonCode,
	type RestrictedBrowserDriver,
	RestrictedBrowserTools,
	readTrustedFormValues,
	type SubmitActivationStrategy,
	type SubmitReviewDecision,
	type SubmitReviewer,
} from "./restricted-browser";
import {
	type EvidenceObjectStore,
	recordEvidenceCaptureFailure,
} from "./submission-evidence";

export type BrowserToolName =
	| "navigate"
	| "observe"
	| "click"
	| "fill"
	| "select"
	| "submit";

export type BrowserToolParams = Record<string, unknown>;

export type BrowserDriverFactory = (
	job: Job,
) => Promise<RestrictedBrowserDriver>;

export class BrowserToolInputError extends Error {}

export type BrowserToolSetupStage =
	| "driver_connect"
	| "scope_setup"
	| "bootstrap_navigate";

export class BrowserToolSetupError extends Error {
	constructor(
		readonly stage: BrowserToolSetupStage,
		readonly originalError: unknown,
	) {
		super("The browser tool setup failed");
		this.name = "BrowserToolSetupError";
	}
}

export class BrowserToolCoordinator {
	#driver: RestrictedBrowserDriver | undefined;
	#tools: RestrictedBrowserTools | undefined;
	#scopeKey: string | undefined;
	#operationTail: Promise<void> = Promise.resolve();
	#closed = false;
	#closePromise: Promise<void> | undefined;
	// Kept past close() so the run metrics can still read the connection cost.
	#connectDurationMs: number | null = null;
	#browserSessionCreated = false;

	constructor(
		private readonly db: D1Database,
		private readonly createDriver: BrowserDriverFactory,
		private readonly evidenceStore: EvidenceObjectStore,
		private readonly createReviewer: (job: Job) => SubmitReviewer,
	) {}

	/** Time spent creating the browser session, including a failed attempt. */
	get connectDurationMs(): number | null {
		return this.#connectDurationMs;
	}

	get browserSessionCreated(): boolean {
		return this.#browserSessionCreated;
	}

	async execute(
		jobId: string,
		runToken: string,
		tool: BrowserToolName,
		params: BrowserToolParams,
	): Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }> {
		const operation = this.#operationTail.then(() =>
			this.#execute(jobId, runToken, tool, params),
		);
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/**
	 * Dry-run path: validates the submit control and runs the same independent
	 * pre-submit review as a real submission, without a screenshot because the
	 * dry-run never captures evidence.
	 */
	async validateSubmit(
		jobId: string,
		runToken: string,
		params: BrowserToolParams,
	): Promise<SubmitReviewDecision> {
		const operation = this.#operationTail.then(async () => {
			if (this.#closed) throw new BrowserToolInputError();
			const { tools } = await this.#getToolsAndJob(jobId, runToken);
			readSubmitActivationStrategy(params);
			const elementId = readElementId(params);
			await tools.validateSubmit(elementId);
			return tools.reviewSubmit(elementId, null);
		});
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async validateProhibited(
		jobId: string,
		runToken: string,
		reasonCode: ProhibitedReasonCode,
		formUrl: string | null,
	): Promise<void> {
		const operation = this.#operationTail.then(async () => {
			if (this.#closed) throw new BrowserToolInputError();
			const { tools } = await this.#getToolsAndJob(jobId, runToken);
			await tools.validateProhibited(reasonCode, formUrl);
		});
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/**
	 * Captures evidence for a prohibited outcome. It never throws and never
	 * creates a browser session, so the agent result is unaffected.
	 */
	async captureEvidence(
		jobId: string,
		runToken: string,
		stage: "prohibited",
	): Promise<void> {
		const operation = this.#operationTail.then(() =>
			this.#captureEvidence(jobId, runToken, stage),
		);
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation.catch(() => undefined);
	}

	async #captureEvidence(
		jobId: string,
		runToken: string,
		stage: "prohibited",
	): Promise<void> {
		const tools = this.#tools;
		if (
			this.#closed ||
			!tools ||
			this.#scopeKey !== scopeKey(jobId, runToken)
		) {
			const store = new D1JobStore(this.db);
			const job = await store.find(jobId);
			if (job?.status !== "running" || job.runToken !== runToken) return;
			await recordEvidenceCaptureFailure(
				store,
				jobId,
				runToken,
				job.attemptCount,
				crypto.randomUUID(),
				stage,
				"NO_BROWSER_SESSION",
				new Date().toISOString(),
			);
			return;
		}
		await tools.captureEvidence(stage);
	}

	async #execute(
		jobId: string,
		runToken: string,
		tool: BrowserToolName,
		params: BrowserToolParams,
	): Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }> {
		if (this.#closed) {
			throw new BrowserToolInputError();
		}
		const { job, tools } = await this.#getToolsAndJob(jobId, runToken);
		switch (tool) {
			case "navigate":
				await tools.navigate(readString(params, "url", 2_048));
				return { result: { ok: true } };
			case "observe":
				return { result: await tools.observe() };
			case "click":
				await tools.click(readElementId(params));
				return { result: { ok: true } };
			case "fill":
				await tools.fill(
					readElementId(params),
					readPayloadValue(job, params, 8_192),
				);
				return { result: { ok: true } };
			case "select":
				await tools.select(
					readElementId(params),
					readPayloadValue(job, params, 2_048),
				);
				return { result: { ok: true } };
			case "submit": {
				const job = await tools.submit(
					readElementId(params),
					readSubmitActivationStrategy(params),
				);
				const { runToken: _, ...safeJob } = job;
				return { job: safeJob };
			}
		}
	}

	/**
	 * The close releases the provider session, so the caller must be able to wait
	 * for it. A second call joins the first instead of returning early.
	 */
	async close(): Promise<void> {
		this.#closed = true;
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		const driver = this.#driver;
		this.#driver = undefined;
		this.#tools = undefined;
		this.#scopeKey = undefined;
		await driver?.close?.();
	}

	async #getToolsAndJob(
		jobId: string,
		runToken: string,
	): Promise<{ job: Job; tools: RestrictedBrowserTools }> {
		const key = scopeKey(jobId, runToken);
		const store = new D1JobStore(this.db);
		const job = await store.find(jobId);
		if (job?.status !== "running" || job.runToken !== runToken) {
			throw new BrowserToolInputError();
		}
		if (this.#tools) {
			if (this.#scopeKey !== key) {
				throw new BrowserToolInputError();
			}
			return { job, tools: this.#tools };
		}

		let driver: RestrictedBrowserDriver;
		const connectStartedAt = Date.now();
		try {
			driver = await this.createDriver(job);
		} catch (error) {
			this.#connectDurationMs = Math.max(0, Date.now() - connectStartedAt);
			throw new BrowserToolSetupError("driver_connect", error);
		}
		this.#connectDurationMs = Math.max(0, Date.now() - connectStartedAt);
		this.#browserSessionCreated = true;
		// The run may have been aborted while the session was being created. The
		// provider session is released here because close() already ran and no
		// longer holds this driver.
		if (this.#closed) {
			await driver.close?.().catch(() => undefined);
			throw new BrowserToolInputError();
		}
		try {
			let tools: RestrictedBrowserTools;
			try {
				tools = await RestrictedBrowserTools.create(
					driver,
					store,
					jobId,
					runToken,
					this.evidenceStore,
					this.createReviewer(job),
				);
			} catch (error) {
				throw new BrowserToolSetupError("scope_setup", error);
			}
			try {
				await tools.navigate(job.targetUrl);
			} catch (error) {
				throw new BrowserToolSetupError("bootstrap_navigate", error);
			}
			if (this.#closed) {
				throw new BrowserToolInputError();
			}
			this.#driver = driver;
			this.#tools = tools;
			this.#scopeKey = key;
			return { job, tools };
		} catch (error) {
			await driver.close?.().catch(() => undefined);
			throw error;
		}
	}
}

function scopeKey(jobId: string, runToken: string): string {
	return `${jobId}\u0000${runToken}`;
}

function readSubmitActivationStrategy(
	params: BrowserToolParams,
): SubmitActivationStrategy {
	const value = params.activationStrategy;
	if (value === "dom" || value === "mouse" || value === "enter") return value;
	throw new BrowserToolInputError();
}

function readPayloadValue(
	job: Job,
	params: BrowserToolParams,
	maxLength: number,
): string {
	const payloadKey = readString(params, "payloadKey", 64);
	if (!PAYLOAD_KEY_PATTERN.test(payloadKey)) {
		throw new BrowserToolInputError();
	}
	const trusted = readTrustedFormValues(job.payload);
	if (!Object.hasOwn(trusted, payloadKey)) {
		throw new BrowserToolInputError();
	}
	const value = trusted[payloadKey];
	if (typeof value !== "string" || value.length > maxLength) {
		throw new BrowserToolInputError();
	}
	return value;
}

function readElementId(params: BrowserToolParams): string {
	const value = readString(params, "elementId", 64);
	if (!/^fa-[a-z0-9-]+$/.test(value)) {
		throw new BrowserToolInputError();
	}
	return value;
}

function readString(
	params: BrowserToolParams,
	key: string,
	maxLength: number,
	allowEmpty = false,
): string {
	const value = params[key];
	if (
		typeof value !== "string" ||
		(!allowEmpty && !value) ||
		value.length > maxLength
	) {
		throw new BrowserToolInputError();
	}
	return value;
}

export type { BrowserObservation };
