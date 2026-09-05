import { sha256Hex } from "./digest";
import type { EvidenceFailureCode, EvidenceStage, JobStore } from "./job";
import type {
	RestrictedBrowserDriver,
	ScreenshotMode,
} from "./restricted-browser";

export type { EvidenceFailureCode, EvidenceStage };

export const EVIDENCE_CONTENT_TYPE = "image/jpeg";

/** Content type of dry-run field maps and submission result snapshots. */
export const EVIDENCE_JSON_CONTENT_TYPE = "application/json";

/**
 * Upper bound for a single evidence capture (screenshot -> R2 put -> D1
 * record). `after_submit` capture runs in the `submitting` state, before
 * `recordSent`, so a stall here would otherwise be caught only by the
 * agent's overall deadline and turn the run into `uncertain` -- breaking the
 * "best effort, never change the outcome" contract for evidence capture.
 */
export const EVIDENCE_CAPTURE_TIMEOUT_MS = 15_000;

/** The step a capture is in, so a timeout says where it stalled. */
type EvidenceCapturePhase =
	| "screenshot"
	| "serialize"
	| "digest"
	| "put"
	| "record";

interface EvidenceCaptureTiming {
	phase: EvidenceCapturePhase;
	screenshotMs: number;
	digestMs: number;
	putMs: number;
	recordMs: number;
	bytes: number;
}

/** Monotonic where the runtime offers it, so a clock step cannot skew a duration. */
function monotonicNow(): number {
	return typeof performance !== "undefined" &&
		typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function elapsedMs(startedAt: number): number {
	return Math.round(monotonicNow() - startedAt);
}

export interface EvidenceObjectStore {
	put(
		key: string,
		body: Uint8Array,
		contentType: string,
		sha256Hex: string,
	): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * Structural view of the R2 binding. The bucket type itself is only available
 * in the Workers type environment, so the store keeps its own minimal shape.
 */
export interface EvidenceBucket {
	put(
		key: string,
		body: Uint8Array,
		options: {
			httpMetadata: { contentType: string };
			sha256: string;
		},
	): Promise<unknown>;
	delete(key: string): Promise<unknown>;
}

export class R2EvidenceObjectStore implements EvidenceObjectStore {
	constructor(private readonly bucket: EvidenceBucket) {}

	async put(
		key: string,
		body: Uint8Array,
		contentType: string,
		sha256Hex: string,
	): Promise<void> {
		await this.bucket.put(key, body, {
			httpMetadata: { contentType },
			sha256: sha256Hex,
		});
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}
}

export class InMemoryEvidenceObjectStore implements EvidenceObjectStore {
	readonly objects = new Map<
		string,
		{ body: Uint8Array; contentType: string; sha256: string }
	>();
	async put(
		key: string,
		body: Uint8Array,
		contentType: string,
		sha256Hex: string,
	): Promise<void> {
		this.objects.set(key, { body, contentType, sha256: sha256Hex });
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}
}

/**
 * Where one capture's bytes come from. The phase name and the failure code
 * follow the source, so a stalled or failed capture still says what it was
 * doing.
 */
interface EvidenceCaptureSource {
	phase: EvidenceCapturePhase;
	contentType: string;
	failureCode: EvidenceFailureCode;
	produce: () => Promise<Uint8Array>;
}

export type EvidenceCaptureResult =
	| { captured: true; objectKey: string; body: Uint8Array }
	| { captured: false; failureCode: EvidenceFailureCode };

export class SubmissionEvidenceRecorder {
	constructor(
		private readonly driver: Pick<RestrictedBrowserDriver, "captureScreenshot">,
		private readonly objectStore: EvidenceObjectStore,
		private readonly jobs: JobStore,
		private readonly jobId: string,
		private readonly runToken: string,
		private readonly attempt: number,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly timeoutMs: number = EVIDENCE_CAPTURE_TIMEOUT_MS,
	) {}

	/**
	 * Screenshot of the current page. Evidence defaults to the whole document:
	 * an operator approving a real submission, and the pre-submit review that
	 * reads the same bytes, both need to see the entire form rather than the one
	 * screen that happened to be scrolled into view.
	 */
	capture(
		stage: EvidenceStage,
		mode: ScreenshotMode = "full_page",
	): Promise<EvidenceCaptureResult> {
		return this.#capture(stage, {
			phase: "screenshot",
			contentType: EVIDENCE_CONTENT_TYPE,
			failureCode: "SCREENSHOT_FAILED",
			produce: () => this.driver.captureScreenshot(mode),
		});
	}

	/**
	 * JSON evidence. The value holds page content and registration values, so
	 * it only ever reaches the object store.
	 */
	captureJson(
		stage: EvidenceStage,
		value: unknown,
	): Promise<EvidenceCaptureResult> {
		return this.#capture(stage, {
			phase: "serialize",
			contentType: EVIDENCE_JSON_CONTENT_TYPE,
			failureCode: "SERIALIZE_FAILED",
			produce: async () => new TextEncoder().encode(JSON.stringify(value)),
		});
	}

	async #capture(
		stage: EvidenceStage,
		source: EvidenceCaptureSource,
	): Promise<EvidenceCaptureResult> {
		const eventId = crypto.randomUUID();
		const objectKey = evidenceObjectKey(
			this.jobId,
			stage,
			eventId,
			source.contentType,
		);
		let expired = false;
		// The capture writes its measurements here as it advances. A stalled
		// capture is exactly what the log is for, and it keeps running after the
		// timeout wins the race, so the timeout branch reports what was reached
		// instead of waiting for a capture that may never return.
		const timing: EvidenceCaptureTiming = {
			phase: source.phase,
			screenshotMs: 0,
			digestMs: 0,
			putMs: 0,
			recordMs: 0,
			bytes: 0,
		};
		let timingReported = false;
		const reportTiming = (didTimeOut: boolean): void => {
			if (timingReported) return;
			timingReported = true;
			console.log(
				JSON.stringify({
					event: "submission_evidence_timing",
					stage,
					timedOut: didTimeOut,
					phase: timing.phase,
					screenshotMs: timing.screenshotMs,
					digestMs: timing.digestMs,
					putMs: timing.putMs,
					recordMs: timing.recordMs,
					bytes: timing.bytes,
				}),
			);
		};

		let timer!: ReturnType<typeof setTimeout>;
		const timedOut = new Promise<EvidenceCaptureResult>((resolve) => {
			timer = setTimeout(() => {
				expired = true;
				// Keep the key in the log in case the Worker stops before a late R2
				// write can be compensated.
				console.warn(
					JSON.stringify({
						event: "submission_evidence_timeout",
						stage,
						objectKey,
					}),
				);
				reportTiming(true);
				// The failure event write is not awaited: a stalled D1 must not
				// extend the timeout past its bound. #failed never rejects.
				void this.#failed(eventId, stage, "CAPTURE_TIMEOUT");
				resolve({ captured: false, failureCode: "CAPTURE_TIMEOUT" });
			}, this.timeoutMs);
		});

		try {
			return await Promise.race([
				this.#captureUnbounded(
					stage,
					source,
					eventId,
					objectKey,
					() => expired,
					timing,
				),
				timedOut,
			]);
		} finally {
			clearTimeout(timer);
			reportTiming(false);
		}
	}

	/**
	 * Writes how long each step took into `timing` as it goes, so the caller can
	 * report what was reached even when this never returns.
	 */
	async #captureUnbounded(
		stage: EvidenceStage,
		source: EvidenceCaptureSource,
		eventId: string,
		objectKey: string,
		expired: () => boolean,
		timing: EvidenceCaptureTiming,
	): Promise<EvidenceCaptureResult> {
		let bytes: Uint8Array;
		timing.phase = source.phase;
		const screenshotStartedAt = monotonicNow();
		try {
			bytes = await source.produce();
		} catch {
			timing.screenshotMs = elapsedMs(screenshotStartedAt);
			return expired()
				? timeoutResult()
				: this.#recordFailure(timing, eventId, stage, source.failureCode);
		}
		timing.screenshotMs = elapsedMs(screenshotStartedAt);
		timing.bytes = bytes.byteLength;
		if (expired()) return timeoutResult();
		if (bytes.byteLength === 0) {
			return this.#recordFailure(timing, eventId, stage, source.failureCode);
		}

		let sha256: string;
		timing.phase = "digest";
		const digestStartedAt = monotonicNow();
		try {
			sha256 = await sha256Hex(bytes);
		} catch {
			timing.digestMs = elapsedMs(digestStartedAt);
			if (!expired()) {
				return this.#recordFailure(
					timing,
					eventId,
					stage,
					"OBJECT_STORE_FAILED",
				);
			}
			await this.#recordFailure(
				timing,
				eventId,
				stage,
				"CAPTURE_TIMEOUT",
				false,
			);
			return timeoutResult();
		}
		timing.digestMs = elapsedMs(digestStartedAt);
		if (expired()) return timeoutResult();

		// The intent names the object before it exists, so a Worker that stops
		// between the upload and the result still leaves the key in D1. Nothing
		// is written to the object store without it.
		timing.phase = "record";
		const intentStartedAt = monotonicNow();
		const intentRecorded = await this.#recordIntent(eventId, stage, objectKey);
		timing.recordMs = elapsedMs(intentStartedAt);
		if (expired()) return timeoutResult();
		if (!intentRecorded) {
			return this.#recordFailure(timing, eventId, stage, "EVENT_NOT_RECORDED");
		}

		timing.phase = "put";
		const putStartedAt = monotonicNow();
		try {
			await this.objectStore.put(objectKey, bytes, source.contentType, sha256);
		} catch {
			timing.putMs = elapsedMs(putStartedAt);
			if (!expired()) {
				return this.#recordFailure(
					timing,
					eventId,
					stage,
					"OBJECT_STORE_FAILED",
				);
			}
			await this.#discardObject(stage, objectKey);
			await this.#recordFailure(
				timing,
				eventId,
				stage,
				"CAPTURE_TIMEOUT",
				false,
			);
			return timeoutResult();
		}
		timing.putMs = elapsedMs(putStartedAt);
		if (expired()) {
			await this.#discardObject(stage, objectKey);
			await this.#failed(eventId, stage, "CAPTURE_TIMEOUT", false);
			return timeoutResult();
		}

		let recorded: boolean;
		timing.phase = "record";
		const recordStartedAt = monotonicNow();
		try {
			recorded = await this.jobs.recordEvidenceCaptured(
				this.jobId,
				this.runToken,
				this.attempt,
				eventId,
				stage,
				objectKey,
				source.contentType,
				sha256,
				bytes.byteLength,
				this.now(),
			);
		} catch {
			recorded = false;
		}
		// Both D1 writes of a capture are reported as one duration.
		timing.recordMs += elapsedMs(recordStartedAt);
		if (expired()) {
			await this.#recordFailure(
				timing,
				eventId,
				stage,
				"CAPTURE_TIMEOUT",
				false,
			);
			await this.#discardObject(stage, objectKey);
			return timeoutResult();
		}
		if (!recorded) {
			await this.#discardObject(stage, objectKey);
			return this.#recordFailure(timing, eventId, stage, "EVENT_NOT_RECORDED");
		}

		logSubmissionEvidence(stage, true);
		return { captured: true, objectKey, body: bytes };
	}

	/**
	 * A primary key conflict with a failure event that a timeout already wrote
	 * is a rejected intent, not a run failure, so the exception stays here.
	 */
	async #recordIntent(
		eventId: string,
		stage: EvidenceStage,
		objectKey: string,
	): Promise<boolean> {
		try {
			return await this.jobs.recordEvidenceIntent(
				this.jobId,
				this.runToken,
				this.attempt,
				eventId,
				stage,
				objectKey,
				this.now(),
			);
		} catch {
			return false;
		}
	}

	async #discardObject(stage: EvidenceStage, objectKey: string): Promise<void> {
		try {
			await this.objectStore.delete(objectKey);
		} catch {
			// The key holds only jobId, stage, and eventId, so it is safe to log
			// for a later manual cleanup of the unreferenced object.
			console.warn(
				JSON.stringify({
					event: "submission_evidence_orphan",
					stage,
					objectKey,
				}),
			);
		}
	}

	/**
	 * The failure event is a D1 write like any other, so a capture that stalls
	 * writing it reports the record phase rather than the step that failed.
	 */
	async #recordFailure(
		timing: EvidenceCaptureTiming,
		eventId: string,
		stage: EvidenceStage,
		failureCode: EvidenceFailureCode,
		shouldLog = true,
	): Promise<EvidenceCaptureResult> {
		timing.phase = "record";
		const startedAt = monotonicNow();
		try {
			return await this.#failed(eventId, stage, failureCode, shouldLog);
		} finally {
			timing.recordMs += elapsedMs(startedAt);
		}
	}

	async #failed(
		eventId: string,
		stage: EvidenceStage,
		failureCode: EvidenceFailureCode,
		shouldLog = true,
	): Promise<EvidenceCaptureResult> {
		await recordEvidenceCaptureFailure(
			this.jobs,
			this.jobId,
			this.runToken,
			this.attempt,
			eventId,
			stage,
			failureCode,
			this.now(),
			shouldLog,
		);
		return { captured: false, failureCode };
	}
}

export async function recordEvidenceCaptureFailure(
	jobs: Pick<JobStore, "recordEvidenceCaptureFailed">,
	jobId: string,
	runToken: string,
	attempt: number,
	eventId: string,
	stage: EvidenceStage,
	failureCode: EvidenceFailureCode,
	now: string,
	shouldLog = true,
): Promise<void> {
	try {
		await jobs.recordEvidenceCaptureFailed(
			jobId,
			runToken,
			attempt,
			eventId,
			stage,
			failureCode,
			now,
		);
	} catch {
		// The evidence outcome must never change the submission outcome.
	}
	if (shouldLog) logSubmissionEvidence(stage, false, failureCode);
}

function timeoutResult(): EvidenceCaptureResult {
	return { captured: false, failureCode: "CAPTURE_TIMEOUT" };
}

export function logSubmissionEvidence(
	stage: EvidenceStage,
	captured: boolean,
	failureCode?: EvidenceFailureCode,
): void {
	console.log(
		JSON.stringify({
			event: "submission_evidence",
			stage,
			captured,
			...(failureCode ? { failureCode } : {}),
		}),
	);
}

/**
 * Fixed-value log line for a dry-run evidence capture that did not happen.
 * The dry-run result is unchanged either way, so the log is the only place a
 * missing capture shows up outside D1.
 */
export function logDryRunEvidenceCaptureFailed(
	stage: EvidenceStage,
	failureCode: EvidenceFailureCode,
): void {
	console.warn(
		JSON.stringify({
			event: "dry_run_evidence_capture_failed",
			stage,
			failureCode,
		}),
	);
}

export function evidenceObjectKey(
	jobId: string,
	stage: EvidenceStage,
	eventId: string,
	contentType: string = EVIDENCE_CONTENT_TYPE,
): string {
	const extension = contentType === EVIDENCE_JSON_CONTENT_TYPE ? "json" : "jpg";
	return `jobs/${jobId}/${stage}/${eventId}.${extension}`;
}
