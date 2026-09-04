import { D1JobStore } from "./d1-job-store";
import type {
	ProhibitedReasonCode,
	ProhibitionVerification,
} from "./form-prohibition";
import type { EvidenceStage, Job } from "./job";
import {
	type BrowserObservation,
	isSubmitStagePending,
	PAYLOAD_KEY_PATTERN,
	type RestrictedBrowserDriver,
	RestrictedBrowserTools,
	readTrustedFormValues,
	type SubmitActivationStrategy,
	type SubmitReviewDecision,
	type SubmitReviewer,
	type TrustedFormValue,
} from "./restricted-browser";
import {
	type EvidenceObjectStore,
	logDryRunEvidenceCaptureFailed,
	recordEvidenceCaptureFailure,
} from "./submission-evidence";
import {
	ELEMENT_ID_PATTERN,
	SUBMIT_ACTIVATION_STRATEGIES,
} from "./tool-input-patterns";

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

/**
 * The field map is the only dry-run evidence written outside the review call.
 * The screenshot is captured inside it, because the reviewer is handed the
 * same bytes.
 */
const DRY_RUN_FIELD_MAP_STAGE: EvidenceStage = "dry_run_field_map";

export class BrowserToolCoordinator {
	#driver: RestrictedBrowserDriver | undefined;
	/**
	 * Holds the driver while the scope setup and the bootstrap navigate run, so
	 * that an abort in that window still closes the provider session.
	 */
	#pendingDriver: RestrictedBrowserDriver | undefined;
	#tools: RestrictedBrowserTools | undefined;
	#scopeKey: string | undefined;
	#operationTail: Promise<void> = Promise.resolve();
	#closed = false;
	#closePromise: Promise<void> | undefined;
	// Kept past close() so the run metrics can still read the connection cost.
	#connectDurationMs: number | null = null;
	#browserConnected = false;

	constructor(
		private readonly db: D1Database,
		private readonly createDriver: BrowserDriverFactory,
		private readonly evidenceStore: EvidenceObjectStore,
		private readonly createReviewer: (job: Job) => SubmitReviewer,
	) {}

	/** Time spent establishing the browser driver, including a failed attempt. */
	get connectDurationMs(): number | null {
		return this.#connectDurationMs;
	}

	/**
	 * Whether a submit activation is still waiting for a result of its own. The
	 * run must not end as anything but uncertain while that is true.
	 */
	hasUnconfirmedSubmission(): boolean {
		return this.#tools?.hasUnconfirmedSubmission() ?? false;
	}

	/**
	 * Whether the browser driver was established. A failed attempt can still
	 * have created a provider session, so the session count itself is followed
	 * through the driver's own session logs.
	 */
	get browserConnected(): boolean {
		return this.#browserConnected;
	}

	async execute(
		jobId: string,
		runToken: string,
		tool: BrowserToolName,
		params: BrowserToolParams,
	): Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }> {
		return this.#serialize(() => this.#execute(jobId, runToken, tool, params));
	}

	/**
	 * Dry-run path: validates the submit control and runs the same independent
	 * pre-submit review as a real submission, over the same screenshot the real
	 * path reviews. That image is also kept as the `dry_run_before_submit`
	 * evidence.
	 */
	async validateSubmit(
		jobId: string,
		runToken: string,
		params: BrowserToolParams,
	): Promise<SubmitReviewDecision> {
		return this.#serialize(async () => {
			if (this.#closed) throw new BrowserToolInputError();
			const { tools } = await this.#getToolsAndJob(jobId, runToken);
			readSubmitActivationStrategy(params);
			const elementId = readElementId(params);
			return tools.reviewDryRunSubmit(elementId);
		});
	}

	async validateProhibited(
		jobId: string,
		runToken: string,
		reasonCode: ProhibitedReasonCode,
		formUrl: string | null,
		evidence?: string | null,
	): Promise<ProhibitionVerification> {
		return this.#serialize(async () => {
			if (this.#closed) throw new BrowserToolInputError();
			const { tools } = await this.#getToolsAndJob(jobId, runToken);
			return tools.validateProhibited(reasonCode, formUrl, evidence);
		});
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
		await this.#serialize(() =>
			this.#captureEvidence(jobId, runToken, stage),
		).catch(() => undefined);
	}

	/**
	 * Captures the dry-run field map once the pre-submit review has decided.
	 * Like the prohibited capture it never throws and never creates a browser
	 * session, so the dry-run result is the same whether or not it succeeds.
	 */
	async captureDryRunFieldMap(
		jobId: string,
		runToken: string,
		review: SubmitReviewDecision,
	): Promise<void> {
		await this.#serialize(() =>
			this.#captureDryRunFieldMap(jobId, runToken, review),
		).catch(() => undefined);
	}

	/**
	 * Runs `run` after every operation queued before it and leaves the queue
	 * ready for the next one. Browser operations share one page, so they are
	 * strictly serialized; a rejection is absorbed here so that one failure
	 * does not poison the queue, and is still delivered to this caller.
	 */
	#serialize<T>(run: () => Promise<T>): Promise<T> {
		const operation = this.#operationTail.then(run);
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
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
			await this.#recordNoBrowserSession(jobId, runToken, [stage]);
			return;
		}
		await tools.captureEvidence(stage);
	}

	async #captureDryRunFieldMap(
		jobId: string,
		runToken: string,
		review: SubmitReviewDecision,
	): Promise<void> {
		const tools = this.#tools;
		if (
			this.#closed ||
			!tools ||
			this.#scopeKey !== scopeKey(jobId, runToken)
		) {
			logDryRunEvidenceCaptureFailed(
				DRY_RUN_FIELD_MAP_STAGE,
				"NO_BROWSER_SESSION",
			);
			await this.#recordNoBrowserSession(jobId, runToken, [
				DRY_RUN_FIELD_MAP_STAGE,
			]);
			return;
		}
		await tools.captureDryRunFieldMap(review);
	}

	async #recordNoBrowserSession(
		jobId: string,
		runToken: string,
		stages: readonly EvidenceStage[],
	): Promise<void> {
		const store = new D1JobStore(this.db);
		const job = await store.find(jobId);
		if (job?.status !== "running" || job.runToken !== runToken) return;
		for (const stage of stages) {
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
		}
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
		// A two-step form is still being worked on after the first stage took
		// the submission permission, so those two tools also run while the job
		// is `submitting`. Nothing that enters new data does.
		const { job, tools } = await this.#getToolsAndJob(
			jobId,
			runToken,
			tool === "observe" || tool === "submit",
		);
		switch (tool) {
			case "navigate":
				await tools.navigate(readString(params, "url", 2_048));
				return { result: { ok: true } };
			case "observe":
				return { result: await tools.observe() };
			case "click":
				await tools.click(readElementId(params));
				return { result: { ok: true } };
			case "fill": {
				const elementId = readElementId(params);
				const value = readPayloadValue(job, params, 8_192);
				// A candidate list belongs to a choice control, so it is never a
				// legal value for a text-like field.
				if (typeof value !== "string") {
					throw new BrowserToolInputError();
				}
				await tools.fill(elementId, value);
				return { result: { ok: true } };
			}
			case "select": {
				const elementId = readElementId(params);
				const value = readPayloadValue(job, params, 2_048);
				await tools.select(
					elementId,
					typeof value === "string" ? [value] : value,
				);
				return { result: { ok: true } };
			}
			case "submit": {
				const outcome = await tools.submit(
					readElementId(params),
					readSubmitActivationStrategy(params),
				);
				if (isSubmitStagePending(outcome)) {
					return { result: { stage: outcome.pendingStage } };
				}
				const { runToken: _, ...safeJob } = outcome;
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
		const driver = this.#driver ?? this.#pendingDriver;
		this.#driver = undefined;
		this.#pendingDriver = undefined;
		this.#tools = undefined;
		this.#scopeKey = undefined;
		await driver?.close?.();
	}

	async #getToolsAndJob(
		jobId: string,
		runToken: string,
		allowSubmitting = false,
	): Promise<{ job: Job; tools: RestrictedBrowserTools }> {
		const key = scopeKey(jobId, runToken);
		const store = new D1JobStore(this.db);
		const job = await store.find(jobId);
		const statusAllowed =
			job?.status === "running" ||
			(allowSubmitting && job?.status === "submitting");
		if (!job || !statusAllowed || job.runToken !== runToken) {
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
		this.#browserConnected = true;
		this.#pendingDriver = driver;
		// The run may have been aborted while the session was being created. The
		// provider session is released here because close() already ran and no
		// longer holds this driver. driver.close() is idempotent, so closing it
		// again from close() is harmless.
		if (this.#closed) {
			this.#pendingDriver = undefined;
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
			this.#pendingDriver = undefined;
			this.#tools = tools;
			this.#scopeKey = key;
			return { job, tools };
		} catch (error) {
			await driver.close?.().catch(() => undefined);
			// A closed driver must not stay reachable through close().
			this.#pendingDriver = undefined;
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
	const strategy = SUBMIT_ACTIVATION_STRATEGIES.find(
		(candidate) => candidate === value,
	);
	if (!strategy) throw new BrowserToolInputError();
	return strategy;
}

function readPayloadValue(
	job: Job,
	params: BrowserToolParams,
	maxLength: number,
): TrustedFormValue {
	const payloadKey = readString(params, "payloadKey", 64);
	if (!PAYLOAD_KEY_PATTERN.test(payloadKey)) {
		throw new BrowserToolInputError();
	}
	const trusted = readTrustedFormValues(job.payload);
	if (!Object.hasOwn(trusted, payloadKey)) {
		throw new BrowserToolInputError();
	}
	const value = trusted[payloadKey];
	if (value === undefined) {
		throw new BrowserToolInputError();
	}
	if (typeof value === "string" && value.length > maxLength) {
		throw new BrowserToolInputError();
	}
	return value;
}

function readElementId(params: BrowserToolParams): string {
	const value = readString(params, "elementId", 64);
	if (!ELEMENT_ID_PATTERN.test(value)) {
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
