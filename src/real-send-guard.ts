import { EFFECTIVE_DRY_RUN_KEY, type JobInput, type JobStatus } from "./job";
import { jobContentFingerprint } from "./job-fingerprint";
import {
	isSendApproval,
	REAL_SEND_GUARD_EXEMPT_KEY,
	SEND_APPROVAL_KEY,
} from "./send-approval";

/** Reason code a job carries once it stopped at the dry-run boundary. */
export const DRY_RUN_COMPLETE_REASON_CODE = "DRY_RUN_COMPLETE";

const DAY_MS = 24 * 60 * 60 * 1000;

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
	| "DRY_RUN_CONTENT_MISMATCH"
	| "REAL_SEND_CAP_REACHED";

export type RealSendDecision =
	| { allowed: true }
	| { allowed: false; refusal: RealSendRefusal };

/** The job reads the guard needs; `D1JobStore` satisfies it as it stands. */
export interface RealSendGuardStore {
	find(id: string): Promise<DryRunRecord | null>;
	countRealSendJobsCreatedBetween(
		startAt: string,
		endAt: string,
		excludeId: string,
	): Promise<number>;
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

/** The UTC day `now` falls in, as the half-open ISO range the count uses. */
export function utcDayRange(now: Date): { from: string; to: string } {
	const dayStart = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	return {
		from: new Date(dayStart).toISOString(),
		to: new Date(dayStart + DAY_MS).toISOString(),
	};
}

/**
 * Gate every job that would reach a real submission. A dry-run job is not
 * touched. A real-send job must carry a human approval record, must name a
 * dry-run that already reached the dry-run boundary carrying the same content,
 * and must fit inside the day's cap. The cap defaults to 0, so the path stays
 * shut unless a deploy explicitly opens it.
 *
 * The count and the insert are not one transaction. Real sends are registered
 * by a single operator-run tool, so the window is narrow, and overshooting it
 * would take two concurrent runs; the approval record and the per-row dry-run
 * check still hold in that case.
 */
export async function checkRealSendGuard(
	input: JobInput,
	now: Date,
	dailyCap: number,
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

	if (dailyCap < 1) {
		return { allowed: false, refusal: "REAL_SEND_CAP_REACHED" };
	}
	const { from, to } = utcDayRange(now);
	const used = await store.countRealSendJobsCreatedBetween(from, to, input.id);
	if (used >= dailyCap) {
		return { allowed: false, refusal: "REAL_SEND_CAP_REACHED" };
	}
	return { allowed: true };
}
