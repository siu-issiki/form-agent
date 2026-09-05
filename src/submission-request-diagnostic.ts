import type {
	ExpectedSubmissionRequest,
	PausedRequest,
	SubmissionRequestBlockStage,
} from "./browser-use-cdp-submission-policy";

/** Fixed categories only: never return a request URL, identifier, or free text. */
export function describeBlockedSubmissionRequest(
	stage: SubmissionRequestBlockStage,
	paused: PausedRequest,
	expected: ExpectedSubmissionRequest | undefined,
	expectedFrameId: string | undefined,
): string {
	const method = paused.request.method.toUpperCase();
	const safeMethod = [
		"GET",
		"HEAD",
		"OPTIONS",
		"POST",
		"PUT",
		"PATCH",
		"DELETE",
	].includes(method)
		? method
		: "other";
	const resource = ["Document", "Fetch", "XHR"].includes(
		paused.resourceType ?? "",
	)
		? paused.resourceType
		: "other";
	const safeStage = [
		"expected_request",
		"network_policy",
		"continue_request",
		"request_limit",
	].includes(stage)
		? stage
		: "unknown";
	let origin = "unknown";
	try {
		const actual = new URL(paused.request.url);
		const reviewed = expected ? new URL(expected.url) : undefined;
		if (
			reviewed &&
			["http:", "https:"].includes(actual.protocol) &&
			["http:", "https:"].includes(reviewed.protocol)
		) {
			origin = actual.origin === reviewed.origin ? "same" : "other";
		}
	} catch {
		/* Invalid URLs remain unknown; their text is never retained. */
	}
	const frame =
		!paused.frameId || !expectedFrameId
			? "unknown"
			: paused.frameId === expectedFrameId
				? "expected"
				: "other";
	return `First blocked request: stage=${safeStage}; method=${safeMethod}; resource=${resource}; origin=${origin}; frame=${frame}.`;
}
