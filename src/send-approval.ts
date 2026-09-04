import { JOB_ID_PATTERN } from "./job";

/**
 * Payload key that carries the human approval of one real submission. It is
 * kept on the stored payload so the D1 row itself records who approved the
 * send, when, and which dry-run it was approved against.
 */
export const SEND_APPROVAL_KEY = "_formAgentSendApproval";

export interface SendApproval {
	/** Person who approved the send; free text the operator supplies. */
	approvedBy: string;
	/** ISO 8601 timestamp of the approval. */
	approvedAt: string;
	/** Job id of the dry-run this row already passed. */
	dryRunJobId: string;
	note?: string;
}

const APPROVAL_KEYS = new Set([
	"approvedBy",
	"approvedAt",
	"dryRunJobId",
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

	const { approvedBy, approvedAt, dryRunJobId, note } = record;
	if (
		typeof approvedBy !== "string" ||
		approvedBy.trim().length === 0 ||
		approvedBy.length > MAX_APPROVED_BY_LENGTH
	) {
		return false;
	}
	if (!isIso8601(approvedAt)) return false;
	if (typeof dryRunJobId !== "string" || !JOB_ID_PATTERN.test(dryRunJobId)) {
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
