import { EFFECTIVE_DRY_RUN_KEY, type JobInput, type JobStatus } from "./job";
import { jobContentFingerprint } from "./job-fingerprint";
import {
	isSendApproval,
	REAL_SEND_GUARD_EXEMPT_KEY,
	SEND_APPROVAL_KEY,
} from "./send-approval";

/** Reason code a job carries once it stopped at the dry-run boundary. */
export const DRY_RUN_COMPLETE_REASON_CODE = "DRY_RUN_COMPLETE";

/**
 * The part of a stored job the guard reads. It is the intersection of the
 * Worker's own `Job` and the `JobState` the operator tool reads back over the
 * API, so both sides run the same checks against the same record: the tool's
 * payload can be null where the Worker's never is, and its result carries only
 * the reason code.
 */
export interface DryRunRecord {
	targetUrl: string;
	companyId: string;
	status: JobStatus;
	payload: Record<string, unknown> | null;
	result: { reasonCode: string | null } | null;
}

/** Why a real send was refused; each code is reported to the caller verbatim. */
export type RealSendRefusal =
	| "SEND_APPROVAL_REQUIRED"
	| "DRY_RUN_NOT_COMPLETED"
	| "DRY_RUN_CONTENT_MISMATCH";

export type RealSendDecision =
	| { allowed: true }
	| { allowed: false; refusal: RealSendRefusal };

/** The job reads the guard needs; `D1JobStore` satisfies it as it stands. */
export interface RealSendGuardStore {
	find(id: string): Promise<DryRunRecord | null>;
}

/**
 * Whether this record is a dry-run that reached the dry-run boundary for the
 * given target: it exists, it ran against the same form URL, it was itself a
 * dry-run, and it stopped with the dry-run completion result. A record whose
 * payload is missing is not treated as a real send, matching the Worker, where
 * the payload is always present.
 */
export function isCompletedDryRunFor(
	dryRun: DryRunRecord | null,
	target: { targetUrl: string },
): dryRun is DryRunRecord {
	return (
		dryRun !== null &&
		dryRun.targetUrl === target.targetUrl &&
		dryRun.payload?.[EFFECTIVE_DRY_RUN_KEY] !== false &&
		dryRun.status === "prohibited" &&
		dryRun.result?.reasonCode === DRY_RUN_COMPLETE_REASON_CODE
	);
}

/**
 * Whether the send carries the content the dry-run actually ran. The approval
 * names a dry-run, so comparing only the form URL would let an approved row be
 * re-registered with a different message or different form values.
 */
export async function matchesDryRunContent(
	dryRun: DryRunRecord,
	input: Pick<JobInput, "targetUrl" | "companyId" | "payload">,
): Promise<boolean> {
	const [approved, requested] = await Promise.all([
		jobContentFingerprint(dryRun.targetUrl, dryRun.companyId, dryRun.payload),
		jobContentFingerprint(input.targetUrl, input.companyId, input.payload),
	]);
	return approved === requested;
}

/**
 * Gate every real submission on a human approval record and a completed
 * dry-run carrying the same content. Registration has no daily volume limit.
 */
export async function checkRealSendGuard(
	input: JobInput,
	store: RealSendGuardStore,
): Promise<RealSendDecision> {
	if (input.payload[EFFECTIVE_DRY_RUN_KEY] !== false) return { allowed: true };
	// The exemption was decided from the env when the payload was stamped, so
	// the caller cannot reach it: a supplied value is discarded there.
	if (input.payload[REAL_SEND_GUARD_EXEMPT_KEY] === true) {
		return { allowed: true };
	}

	const approval = input.payload[SEND_APPROVAL_KEY];
	if (!isSendApproval(approval)) {
		return { allowed: false, refusal: "SEND_APPROVAL_REQUIRED" };
	}

	const dryRun = await store.find(approval.dryRunJobId);
	if (!isCompletedDryRunFor(dryRun, input)) {
		return { allowed: false, refusal: "DRY_RUN_NOT_COMPLETED" };
	}
	if (!(await matchesDryRunContent(dryRun, input))) {
		return { allowed: false, refusal: "DRY_RUN_CONTENT_MISMATCH" };
	}

	return { allowed: true };
}
