import { isSendApproval, SEND_APPROVAL_KEY } from "./send-approval";

/**
 * Digest of what a job would actually send: the form URL, the company, and
 * every `formValues` entry, with candidate lists compared in order. Only the
 * digest is compared or logged, so no registrant value leaves this function.
 *
 * This is the content an approval is bound to. A dry-run and the real send
 * approved against it must agree on all of it, otherwise the approval would
 * stand for content nobody reviewed.
 */
export async function jobContentFingerprint(
	targetUrl: unknown,
	companyId: unknown,
	payload: unknown,
): Promise<string> {
	return sha256(
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
	return sha256(
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
							dryRunJobId: approval.dryRunJobId,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
