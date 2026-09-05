import { EFFECTIVE_DRY_RUN_KEY, JOB_ID_PATTERN } from "./job";

/**
 * Payload key that carries the human approval of one real submission. It is
 * kept on the stored payload so the D1 row itself records who approved the
 * send, when, and which content or dry-run it was approved against.
 */
export const SEND_APPROVAL_KEY = "_formAgentSendApproval";

/**
 * API-stamped exemption for the managed test system. A caller-supplied value
 * is discarded so real customer jobs cannot skip approval and dry-run checks.
 * Exempt jobs are reported separately from ordinary real sends.
 */
export const REAL_SEND_GUARD_EXEMPT_KEY = "_formAgentRealSendGuardExempt";

/** Whether the API accepted this job through the test-system exemption. */
export function isRealSendGuardExemptPayload(
	payload: Record<string, unknown>,
): boolean {
	return payload[REAL_SEND_GUARD_EXEMPT_KEY] === true;
}

/** Whether this is an ordinary real send, excluding managed test jobs. */
export function isRealSendPayload(payload: Record<string, unknown>): boolean {
	return (
		payload[EFFECTIVE_DRY_RUN_KEY] === false &&
		!isRealSendGuardExemptPayload(payload)
	);
}

interface ApprovalMetadata {
	/** Person who approved the send; free text the operator supplies. */
	approvedBy: string;
	/** ISO 8601 timestamp of the approval. */
	approvedAt: string;
	note?: string;
}

export type SendApproval = ApprovalMetadata &
	(
		| { dryRunJobId: string; mode?: never; contentFingerprint?: never }
		| { mode: "direct"; contentFingerprint: string; dryRunJobId?: never }
	);

const APPROVAL_KEYS = new Set([
	"approvedBy",
	"approvedAt",
	"dryRunJobId",
	"mode",
	"contentFingerprint",
	"note",
]);
const MAX_APPROVED_BY_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;
/** Calendar date, time, and either `Z` or a numeric offset. */
const ISO_8601_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates one approval record. Unknown keys are rejected so that nothing
 * else can ride along inside the approval object, and every field is bounded
 * because the record is stored verbatim on the job payload.
 */
export function isSendApproval(value: unknown): value is SendApproval {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !APPROVAL_KEYS.has(key))) return false;

	const {
		approvedBy,
		approvedAt,
		dryRunJobId,
		mode,
		contentFingerprint,
		note,
	} = record;
	if (
		typeof approvedBy !== "string" ||
		approvedBy.trim().length === 0 ||
		approvedBy.length > MAX_APPROVED_BY_LENGTH
	) {
		return false;
	}
	if (!isIso8601(approvedAt)) return false;
	if (mode === "direct") {
		if (
			Object.hasOwn(record, "dryRunJobId") ||
			typeof contentFingerprint !== "string" ||
			!/^[a-f0-9]{64}$/.test(contentFingerprint)
		)
			return false;
	} else if (
		Object.hasOwn(record, "mode") ||
		Object.hasOwn(record, "contentFingerprint") ||
		typeof dryRunJobId !== "string" ||
		!JOB_ID_PATTERN.test(dryRunJobId)
	) {
		return false;
	}
	if (
		note !== undefined &&
		(typeof note !== "string" || note.length > MAX_NOTE_LENGTH)
	) {
		return false;
	}
	return true;
}

export function isIso8601(value: unknown): value is string {
	return (
		typeof value === "string" &&
		ISO_8601_PATTERN.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}
