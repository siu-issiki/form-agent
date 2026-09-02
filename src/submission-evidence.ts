import type { EvidenceFailureCode, EvidenceStage, JobStore } from "./job";
import type { RestrictedBrowserDriver } from "./restricted-browser";

export type { EvidenceFailureCode, EvidenceStage };

export const EVIDENCE_CONTENT_TYPE = "image/jpeg";

/**
 * Upper bound for a single evidence capture (screenshot -> R2 put -> D1
 * record). `after_submit` capture runs in the `submitting` state, before
 * `recordSent`, so a stall here would otherwise be caught only by the
 * agent's overall deadline and turn the run into `uncertain` -- breaking the
 * "best effort, never change the outcome" contract for evidence capture.
 */
export const EVIDENCE_CAPTURE_TIMEOUT_MS = 15_000;

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

	async capture(stage: EvidenceStage): Promise<EvidenceCaptureResult> {
		const eventId = crypto.randomUUID();
		const objectKey = evidenceObjectKey(this.jobId, stage, eventId);
		let expired = false;

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
				// The failure event write is not awaited: a stalled D1 must not
				// extend the timeout past its bound. #failed never rejects.
				void this.#failed(eventId, stage, "CAPTURE_TIMEOUT");
				resolve({ captured: false, failureCode: "CAPTURE_TIMEOUT" });
			}, this.timeoutMs);
		});

		try {
			return await Promise.race([
				this.#captureUnbounded(stage, eventId, objectKey, () => expired),
				timedOut,
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async #captureUnbounded(
		stage: EvidenceStage,
		eventId: string,
		objectKey: string,
		expired: () => boolean,
	): Promise<EvidenceCaptureResult> {
		let bytes: Uint8Array;
		try {
			bytes = await this.driver.captureScreenshot();
		} catch {
			return expired()
				? timeoutResult()
				: this.#failed(eventId, stage, "SCREENSHOT_FAILED");
		}
		if (expired()) return timeoutResult();
		if (bytes.byteLength === 0) {
			return this.#failed(eventId, stage, "SCREENSHOT_FAILED");
		}

		let sha256: string;
		try {
			sha256 = await sha256Hex(bytes);
			if (expired()) return timeoutResult();
			await this.objectStore.put(
				objectKey,
				bytes,
				EVIDENCE_CONTENT_TYPE,
				sha256,
			);
		} catch {
			if (!expired()) {
				return this.#failed(eventId, stage, "OBJECT_STORE_FAILED");
			}
			await this.#discardObject(stage, objectKey);
			await this.#failed(eventId, stage, "CAPTURE_TIMEOUT", false);
			return timeoutResult();
		}
		if (expired()) {
			await this.#discardObject(stage, objectKey);
			await this.#failed(eventId, stage, "CAPTURE_TIMEOUT", false);
			return timeoutResult();
		}

		let recorded: boolean;
		try {
			recorded = await this.jobs.recordEvidenceCaptured(
				this.jobId,
				this.runToken,
				this.attempt,
				eventId,
				stage,
				objectKey,
				sha256,
				bytes.byteLength,
				this.now(),
			);
		} catch {
			recorded = false;
		}
		if (expired()) {
			await this.#failed(eventId, stage, "CAPTURE_TIMEOUT", false);
			await this.#discardObject(stage, objectKey);
			return timeoutResult();
		}
		if (!recorded) {
			await this.#discardObject(stage, objectKey);
			return this.#failed(eventId, stage, "EVENT_NOT_RECORDED");
		}

		logSubmissionEvidence(stage, true);
		return { captured: true, objectKey, body: bytes };
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

export function evidenceObjectKey(
	jobId: string,
	stage: EvidenceStage,
	eventId: string,
): string {
	return `jobs/${jobId}/${stage}/${eventId}.jpg`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// The copy keeps the buffer type narrow enough for the WebCrypto signature.
	const copy = new Uint8Array(bytes);
	const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
	let hex = "";
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}
