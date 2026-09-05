import { sha256Hex } from "./digest";
import { isRecord } from "./json-record";
import { isSendApproval, SEND_APPROVAL_KEY } from "./send-approval";

/**
 * Digest of what a job would actually send: the form URL, the company, and
 * every `formValues` entry, with candidate lists compared in order. Only the
 * digest is compared or logged, so no registrant value leaves this function.
 *
 * This is the content an approval is bound to, directly or through a dry-run.
 * The requested send must agree with the approved content on all of it.
 */
export async function jobContentFingerprint(
	targetUrl: unknown,
	companyId: unknown,
	payload: unknown,
): Promise<string> {
	return sha256Hex(
		JSON.stringify({
			targetUrl,
			companyId,
			formValues: sortedFormValues(payload),
		}),
	);
}

/**
 * Digest of the inputs one registration sends. The stored payload also carries
 * `_formAgentEffectiveDryRun`, which the API adds, so the whole payload cannot
 * be compared.
 *
 * For a real send the digest also covers the approval record, because the same
 * job id under the same campaign name may already hold a dry-run registration.
 * That job would queue content this invocation never approved, so it must not
 * read as this registration. The effective mode itself is not in the digest:
 * only the stored side carries it, and `confirmJobRegistration` checks it
 * separately.
 */
export async function jobInputFingerprint(
	targetUrl: unknown,
	payload: unknown,
	realSend = false,
): Promise<string> {
	const values = formValuesOf(payload);
	const approval = isRecord(payload) ? payload[SEND_APPROVAL_KEY] : undefined;
	return sha256Hex(
		JSON.stringify({
			targetUrl,
			subject: values.subject ?? null,
			message: values.message ?? null,
			formValues: sortedFormValues(payload),
			sendApproval:
				realSend && isSendApproval(approval)
					? {
							approvedBy: approval.approvedBy,
							approvedAt: approval.approvedAt,
							...(approval.mode === "direct"
								? {
										mode: approval.mode,
										contentFingerprint: approval.contentFingerprint,
									}
								: { dryRunJobId: approval.dryRunJobId }),
						}
					: null,
		}),
	);
}

function sortedFormValues(payload: unknown): Array<[string, unknown]> {
	const values = formValuesOf(payload);
	return Object.keys(values)
		.sort()
		.map((key) => [key, values[key]]);
}

function formValuesOf(payload: unknown): Record<string, unknown> {
	return isRecord(payload) && isRecord(payload.formValues)
		? payload.formValues
		: {};
}
