import { describe, expect, test } from "bun:test";
import {
	createExpectedSubmissionRequest,
	decidePausedRequest,
	MAX_SUBMISSION_REQUESTS,
	type PausedRequest,
	type PausedRequestContext,
	SubmissionRequestPolicy,
} from "../src/browser-use-cdp-submission-policy";
import { describeBlockedSubmissionRequest } from "../src/submission-request-diagnostic";

const TARGET_DOMAIN = "acme.co.jp";
const TOP_FRAME_ID = "frame-top";
const FORM_FRAME_ID = "frame-1";

function context(
	overrides: Partial<PausedRequestContext> = {},
): PausedRequestContext {
	return {
		topFrameId: TOP_FRAME_ID,
		targetDomain: TARGET_DOMAIN,
		allowedHosts: [],
		blockNonSubmitRequests: false,
		// The run has already typed into the form, so no request may be read
		// from outside the target domain any more.
		formDataEntered: true,
		dryRun: false,
		interactionStarted: false,
		expectedNavigationRequest: undefined,
		...overrides,
	};
}

function post(requestId: string, url: string): PausedRequest {
	return {
		requestId,
		resourceType: "XHR",
		frameId: FORM_FRAME_ID,
		request: { url, method: "POST" },
	};
}

function documentGet(requestId: string, url: string): PausedRequest {
	return {
		requestId,
		resourceType: "Document",
		frameId: FORM_FRAME_ID,
		request: { url, method: "GET" },
	};
}

/** A policy with the window open, as it is while an activation runs. */
function activatedPolicy(onObserved: () => void = () => undefined) {
	const policy = new SubmissionRequestPolicy();
	policy.beginAttempt();
	policy.openActivationWindow(onObserved);
	return policy;
}

/** A policy whose GET submission guard is armed for `FORM_FRAME_ID`. */
function getSubmissionPolicy(url: string) {
	const policy = new SubmissionRequestPolicy();
	policy.completeValidation(
		createExpectedSubmissionRequest(url, "get"),
		FORM_FRAME_ID,
	);
	policy.beginSubmit();
	policy.beginAttempt();
	policy.openActivationWindow(() => undefined);
	return policy;
}

describe("SubmissionRequestPolicy activation window", () => {
	test("resets the per-activation count while the per-run budget stays spent", () => {
		const policy = activatedPolicy();

		policy.claim("post-1");
		policy.recordContinued();
		policy.release();
		expect(policy.requestCount).toBe(1);
		expect(policy.snapshot().submissionRequestTotal).toBe(1);

		policy.closeActivationWindow();
		policy.openActivationWindow(() => undefined);

		// A second activation starts from zero requests of its own, but it
		// cannot buy back what the first one spent of the run budget.
		expect(policy.requestCount).toBe(0);
		expect(policy.snapshot().submissionRequestTotal).toBe(1);
	});

	test("closes the window so a later request is no longer authorized", () => {
		const policy = activatedPolicy();
		expect(policy.snapshot().submissionRequestAllowed).toBe(true);

		policy.closeActivationWindow();

		expect(policy.snapshot().submissionRequestAllowed).toBe(false);
	});

	test("stops notifying the observer once the window is closed", () => {
		let observed = 0;
		const policy = activatedPolicy(() => {
			observed += 1;
		});

		policy.claim("post-1");
		policy.recordContinued();
		policy.release();
		expect(observed).toBe(1);

		policy.closeActivationWindow();
		policy.recordContinued();

		// The count still moves, but nobody is waiting on it any more.
		expect(observed).toBe(1);
		expect(policy.requestCount).toBe(2);
	});

	test("ends the attempt together with the window", () => {
		const policy = activatedPolicy();

		policy.endAttempt();

		const state = policy.snapshot();
		expect(state.submissionRequestAllowed).toBe(false);
		expect(state.submissionAttemptInProgress).toBe(false);
	});
});

describe("SubmissionRequestPolicy claims", () => {
	test("spends the budget and holds the request in flight until released", () => {
		const policy = activatedPolicy();

		policy.claim("post-1");

		const claimed = policy.snapshot();
		expect(claimed.submissionRequestInFlight).toBe(true);
		expect(claimed.submissionRequestTotal).toBe(1);
		expect(claimed.submissionRedirectRequestIds.has("post-1")).toBe(true);

		policy.release();

		expect(policy.snapshot().submissionRequestInFlight).toBe(false);
	});

	test("lets the redirect of a claimed request through without spending the budget", () => {
		const policy = activatedPolicy();
		policy.claim("post-1");
		policy.release();

		policy.continueRedirect("redirect-1");

		const state = policy.snapshot();
		expect(state.submissionRequestTotal).toBe(1);
		expect(state.submissionRedirectRequestIds.has("redirect-1")).toBe(true);
	});

	test("forgets the requests of an earlier submission when a new one starts", () => {
		const policy = activatedPolicy();
		policy.claim("post-1");
		policy.release();

		policy.beginSubmit();

		expect(policy.snapshot().submissionRedirectRequestIds.size).toBe(0);
		// The budget is per run, so a new submission does not refill it.
		expect(policy.snapshot().submissionRequestTotal).toBe(1);
	});
});

describe("SubmissionRequestPolicy block stage", () => {
	test("keeps the stage of the first refused request of the attempt", () => {
		const policy = activatedPolicy();

		policy.noteBlocked("request_limit");
		policy.noteBlocked("network_policy");

		expect(policy.blockStage).toBe("request_limit");
	});

	test("ignores a block outside an attempt and starts each attempt clean", () => {
		const policy = new SubmissionRequestPolicy();

		policy.noteBlocked("network_policy");
		expect(policy.blockStage).toBeUndefined();

		policy.beginAttempt();
		policy.noteBlocked("network_policy");
		policy.endAttempt();
		expect(policy.blockStage).toBe("network_policy");

		policy.beginAttempt();
		expect(policy.blockStage).toBeUndefined();
	});
});

describe("submission request diagnostic metadata", () => {
	test("retains only the first blocked request classification", () => {
		const policy = activatedPolicy();
		policy.completeValidation(
			{
				url: "https://acme.co.jp/contact?private=BEFORE_SECRET",
				method: "POST",
			},
			FORM_FRAME_ID,
		);
		policy.noteBlocked("network_policy", {
			requestId: "PRIVATE_ID",
			resourceType: "XHR",
			frameId: FORM_FRAME_ID,
			request: {
				url: "https://outside.test/private?token=AFTER_SECRET",
				method: "POST",
			},
		});
		const first = policy.blockDiagnostic;
		expect(first).toBe(
			"First blocked request: stage=network_policy; method=POST; resource=XHR; origin=other; frame=expected.",
		);
		policy.noteBlocked("continue_request", {
			requestId: "LATER",
			resourceType: "Document",
			frameId: "other",
			request: { url: "https://acme.co.jp/send", method: "GET" },
		});
		expect(policy.blockDiagnostic).toBe(first);
		expect(policy.blockStage).toBe("network_policy");
		policy.endAttempt();
		expect(policy.blockDiagnostic).toBe(first);
		policy.beginAttempt();
		expect(policy.blockDiagnostic).toBeUndefined();
	});
	test("redacts unknown method/resource and all URL and identifier content", () => {
		const policy = activatedPolicy();
		policy.completeValidation(
			{ url: "https://acme.co.jp/user/EXPECTED_SECRET", method: "POST" },
			"FRAME_SECRET",
		);
		policy.noteBlocked("network_policy", {
			requestId: "ID_SECRET",
			resourceType: "RESOURCE_SECRET",
			frameId: "OTHER_FRAME_SECRET",
			request: {
				url: "https://user:PASS_SECRET@outside.test/NAME_SECRET?email=EMAIL_SECRET#BODY_SECRET",
				method: "METHOD_SECRET",
			},
		});
		expect(policy.blockDiagnostic).toBe(
			"First blocked request: stage=network_policy; method=other; resource=other; origin=other; frame=other.",
		);
		expect(policy.blockDiagnostic).not.toContain("SECRET");
		expect(policy.blockDiagnostic).not.toContain("outside.test");
	});
});

describe("bounded submission request classification", () => {
	const paused = (url: string, frameId?: string): PausedRequest => ({
		requestId: "SECRET_ID",
		resourceType: "Document",
		...(frameId ? { frameId } : {}),
		request: { url, method: "get" },
	});
	test("ignores path/query/fragment contents when comparing origins", () => {
		const expected = {
			url: "https://acme.co.jp/private/SECRET_A?name=SECRET_B",
			method: "GET",
		};
		expect(
			describeBlockedSubmissionRequest(
				"expected_request",
				paused("https://acme.co.jp/another/SECRET_C?email=SECRET_D#SECRET_E"),
				expected,
				undefined,
			),
		).toBe(
			"First blocked request: stage=expected_request; method=GET; resource=Document; origin=same; frame=unknown.",
		);
	});
	test.each([
		"INVALID_SECRET",
		"data:text/plain,SECRET",
		"file:///SECRET",
		"javascript:SECRET",
	])("does not retain malformed or non-HTTP URL %s", (url) => {
		const result = describeBlockedSubmissionRequest(
			"network_policy",
			paused(url),
			{ url: "https://acme.co.jp/form", method: "POST" },
			FORM_FRAME_ID,
		);
		expect(result).toContain("origin=unknown; frame=unknown");
		expect(result).not.toContain("SECRET");
	});
	test("does not fabricate an origin match without a reviewed request", () => {
		expect(
			describeBlockedSubmissionRequest(
				"continue_request",
				paused("https://acme.co.jp/SECRET", FORM_FRAME_ID),
				undefined,
				FORM_FRAME_ID,
			),
		).toContain("origin=unknown; frame=expected");
	});
	test("unknown stages are never interpolated into the saved text", () => {
		expect(
			describeBlockedSubmissionRequest(
				"SECRET_STAGE" as never,
				paused("https://acme.co.jp"),
				undefined,
				undefined,
			),
		).toContain("stage=unknown;");
	});
	test("does not attach a later diagnostic to an earlier stage-only block", () => {
		const policy = activatedPolicy();
		policy.noteBlocked("request_limit");
		policy.noteBlocked("network_policy", paused("https://outside.test/SECRET"));
		expect(policy.blockStage).toBe("request_limit");
		expect(policy.blockDiagnostic).toBeUndefined();
	});
	test("ignores diagnostic context before an attempt", () => {
		const policy = new SubmissionRequestPolicy();
		policy.noteBlocked("network_policy", paused("https://outside.test/SECRET"));
		expect(policy.blockDiagnostic).toBeUndefined();
	});
});

describe("SubmissionRequestPolicy validation state", () => {
	test("drops the recorded submission when a new validation starts", () => {
		const policy = new SubmissionRequestPolicy();
		policy.completeValidation(
			createExpectedSubmissionRequest("https://acme.co.jp/send", "post"),
			FORM_FRAME_ID,
		);
		policy.noteValidatedInput(11);
		policy.noteValidatedInput(22);
		expect(policy.validatedInputBackendNodeId).toBe(11);

		policy.beginValidation();

		expect(policy.expectedRequest).toBeUndefined();
		expect(policy.validatedInputBackendNodeId).toBeUndefined();
		// The frame is only replaced by the next successful validation.
		expect(policy.expectedFrameId).toBe(FORM_FRAME_ID);
	});

	test("clears what the current document owns and keeps the run budget", () => {
		const policy = getSubmissionPolicy("https://acme.co.jp/search");
		policy.noteValidatedInput(7);
		policy.claim("post-1");
		policy.release();

		policy.clear();

		expect(policy.expectedRequest).toBeUndefined();
		expect(policy.expectedFrameId).toBeUndefined();
		expect(policy.validatedInputBackendNodeId).toBeUndefined();
		const state = policy.snapshot();
		// A new document is not a new run: the budget and the GET guard stay.
		expect(state.submissionRequestTotal).toBe(1);
		expect(state.getSubmissionGuard).toBeDefined();
	});

	test("arms the GET submission guard only once per run", () => {
		const policy = new SubmissionRequestPolicy();
		policy.completeValidation(
			createExpectedSubmissionRequest("https://acme.co.jp/search", "get"),
			FORM_FRAME_ID,
		);
		policy.beginSubmit();

		policy.completeValidation(
			createExpectedSubmissionRequest("https://acme.co.jp/other", "get"),
			"frame-2",
		);
		policy.beginSubmit();

		expect(policy.snapshot().getSubmissionGuard).toEqual({
			request: { url: "https://acme.co.jp/search", method: "GET" },
			frameId: FORM_FRAME_ID,
		});
	});

	test("leaves the guard unarmed for an unsafe submission", () => {
		const policy = new SubmissionRequestPolicy();
		policy.completeValidation(
			createExpectedSubmissionRequest("https://acme.co.jp/send", "post"),
			FORM_FRAME_ID,
		);

		policy.beginSubmit();

		expect(policy.snapshot().getSubmissionGuard).toBeUndefined();
	});
});

describe("decidePausedRequest", () => {
	test("refuses every request while the domain scope is unknown", () => {
		const policy = activatedPolicy();

		const decision = decidePausedRequest(
			post("post-1", "https://acme.co.jp/send"),
			policy.snapshot(),
			context({ targetDomain: undefined }),
		);

		expect(decision.action).toBe("fail");
		expect(decision.blockStage).toBe("network_policy");
	});

	test("claims a same-domain post made inside the activation window", () => {
		const policy = activatedPolicy();

		const decision = decidePausedRequest(
			post("post-1", "https://acme.co.jp/wp-json/contact-form-7/v1/feedback"),
			policy.snapshot(),
			context({ blockNonSubmitRequests: true }),
		);

		expect(decision).toEqual({
			action: "continue",
			claimSubmission: true,
			continueRedirect: false,
			claimNavigation: false,
			claimCompletionNavigation: false,
			allowedByVerificationProvider: false,
			submissionRelated: true,
			blockStage: "network_policy",
		});
	});

	test("refuses a submission request that leaves the target domain", () => {
		const policy = activatedPolicy();

		const decision = decidePausedRequest(
			post("offsite-1", "https://forms.other.test/collect"),
			policy.snapshot(),
			context(),
		);

		expect(decision.action).toBe("fail");
		expect(decision.blockStage).toBe("network_policy");
		expect(decision.submissionRelated).toBe(true);
	});

	test("refuses the request past the per-run submission budget", () => {
		const policy = activatedPolicy();
		for (let index = 0; index < MAX_SUBMISSION_REQUESTS; index += 1) {
			policy.claim(`post-${index + 1}`);
			policy.recordContinued();
			policy.release();
		}

		const decision = decidePausedRequest(
			post("post-6", "https://acme.co.jp/api/step-6"),
			policy.snapshot(),
			context(),
		);

		expect(decision.action).toBe("fail");
		expect(decision.blockStage).toBe("request_limit");
		expect(decision.submissionRelated).toBe(true);
	});

	test("continues the redirect of a claimed request without claiming it", () => {
		const policy = activatedPolicy();
		policy.completeValidation(
			createExpectedSubmissionRequest("https://acme.co.jp/send", "post"),
			FORM_FRAME_ID,
		);
		policy.claim("post-1");
		policy.release();

		const decision = decidePausedRequest(
			{
				requestId: "redirect-1",
				redirectedRequestId: "post-1",
				resourceType: "Document",
				frameId: FORM_FRAME_ID,
				request: { url: "https://acme.co.jp/thanks", method: "GET" },
			},
			policy.snapshot(),
			// Everything that is not this submission is locked out, so only the
			// redirect authorization can let this one through.
			context({ blockNonSubmitRequests: true }),
		);

		expect(decision.action).toBe("continue");
		expect(decision.claimSubmission).toBe(false);
		expect(decision.continueRedirect).toBe(true);
		expect(decision.submissionRelated).toBe(true);
	});

	test("lets a verification provider request through outside the submission", () => {
		const policy = new SubmissionRequestPolicy();

		const decision = decidePausedRequest(
			{
				requestId: "recaptcha-1",
				resourceType: "XHR",
				frameId: FORM_FRAME_ID,
				request: {
					url: "https://www.google.com/recaptcha/api2/reload",
					method: "POST",
				},
			},
			policy.snapshot(),
			context({ blockNonSubmitRequests: true }),
		);

		expect(decision.action).toBe("continue");
		expect(decision.allowedByVerificationProvider).toBe(true);
		// The widget is never the submission, so it stays out of the claim and
		// out of the block-stage diagnostics.
		expect(decision.claimSubmission).toBe(false);
		expect(decision.submissionRelated).toBe(false);
	});

	test("refuses every request of a dry-run once the form was touched", () => {
		const policy = activatedPolicy();

		const decision = decidePausedRequest(
			post("dry-run-1", "https://acme.co.jp/send"),
			policy.snapshot(),
			context({ dryRun: true, interactionStarted: true }),
		);

		expect(decision.action).toBe("fail");
		expect(decision.blockStage).toBe("network_policy");
	});

	test("claims the expected GET submission once", () => {
		const policy = getSubmissionPolicy("https://acme.co.jp/search");

		const decision = decidePausedRequest(
			documentGet("get-1", "https://acme.co.jp/search?name=taro"),
			policy.snapshot(),
			context({ blockNonSubmitRequests: true }),
		);

		expect(decision.action).toBe("continue");
		expect(decision.claimSubmission).toBe(true);
	});

	test("refuses a second expected GET while the claimed one is in flight", () => {
		const policy = getSubmissionPolicy("https://acme.co.jp/search");
		policy.claim("get-1");

		const decision = decidePausedRequest(
			documentGet("get-2", "https://acme.co.jp/search?name=taro"),
			policy.snapshot(),
			context({ blockNonSubmitRequests: true }),
		);

		expect(decision.action).toBe("fail");
		expect(decision.blockStage).toBe("expected_request");
		expect(decision.submissionRelated).toBe(true);
	});

	test("lets the expected GET be claimed again after the claim was released", () => {
		const policy = getSubmissionPolicy("https://acme.co.jp/search");
		policy.claim("get-1");
		policy.release();

		const decision = decidePausedRequest(
			documentGet("get-2", "https://acme.co.jp/search?name=taro"),
			policy.snapshot(),
			context({ blockNonSubmitRequests: true }),
		);

		expect(decision.action).toBe("continue");
		expect(decision.claimSubmission).toBe(true);
	});

	test("claims the navigation the driver is waiting for", () => {
		const policy = new SubmissionRequestPolicy();

		const decision = decidePausedRequest(
			{
				requestId: "nav-1",
				resourceType: "Document",
				frameId: TOP_FRAME_ID,
				request: { url: "https://acme.co.jp/contact#form", method: "GET" },
			},
			policy.snapshot(),
			context({
				blockNonSubmitRequests: true,
				expectedNavigationRequest: {
					url: "https://acme.co.jp/contact",
					frameId: TOP_FRAME_ID,
					claimed: false,
				},
			}),
		);

		expect(decision.action).toBe("continue");
		expect(decision.claimNavigation).toBe(true);
	});

	test("reports the navigation claim even when the network policy refuses", () => {
		const policy = new SubmissionRequestPolicy();

		const decision = decidePausedRequest(
			{
				requestId: "nav-1",
				resourceType: "Document",
				frameId: TOP_FRAME_ID,
				request: { url: "https://acme.co.jp/contact", method: "GET" },
			},
			policy.snapshot(),
			context({
				dryRun: true,
				interactionStarted: true,
				expectedNavigationRequest: {
					url: "https://acme.co.jp/contact",
					frameId: TOP_FRAME_ID,
					claimed: false,
				},
			}),
		);

		// The dry-run lock refuses the request, but the expected navigation was
		// already spent by the time it did.
		expect(decision.action).toBe("fail");
		expect(decision.claimNavigation).toBe(true);
	});

	test("does not claim a navigation that was already claimed", () => {
		const policy = new SubmissionRequestPolicy();

		const decision = decidePausedRequest(
			{
				requestId: "nav-2",
				resourceType: "Document",
				frameId: TOP_FRAME_ID,
				request: { url: "https://acme.co.jp/contact", method: "GET" },
			},
			policy.snapshot(),
			context({
				blockNonSubmitRequests: true,
				expectedNavigationRequest: {
					url: "https://acme.co.jp/contact",
					frameId: TOP_FRAME_ID,
					claimed: true,
				},
			}),
		);

		expect(decision.action).toBe("fail");
		expect(decision.claimNavigation).toBe(false);
	});
});

describe("POST followed by a script completion navigation", () => {
	function submittedPolicy() {
		const policy = getSubmissionPolicy("https://acme.co.jp/contact");
		policy.claim("server-action");
		policy.recordContinued(post("server-action", "https://acme.co.jp/contact"));
		policy.release();
		policy.closeActivationWindow();
		return policy;
	}
	test("allows one same-origin queryless completion document after POST, without counting another submission", () => {
		const policy = submittedPolicy();
		const request = documentGet(
			"completion",
			"https://acme.co.jp/contact-success",
		);
		const decision = decidePausedRequest(
			request,
			policy.snapshot(),
			context({ blockNonSubmitRequests: true }),
		);
		expect(decision.action).toBe("continue");
		expect(decision.claimSubmission).toBe(false);
		expect(decision.claimCompletionNavigation).toBe(true);
		policy.claimCompletionNavigation();
		expect(
			decidePausedRequest(
				request,
				policy.snapshot(),
				context({ blockNonSubmitRequests: true }),
			).action,
		).toBe("fail");
		expect(policy.requestCount).toBe(1);
	});
	test.each([
		[
			"same POST or GET action",
			"https://acme.co.jp/contact",
			"Document",
			FORM_FRAME_ID,
		],
		[
			"external",
			"https://other.co.jp/contact-success",
			"Document",
			FORM_FRAME_ID,
		],
		[
			"other subdomain",
			"https://other.acme.co.jp/contact-success",
			"Document",
			FORM_FRAME_ID,
		],
		[
			"query",
			"https://acme.co.jp/contact-success?email=private",
			"Document",
			FORM_FRAME_ID,
		],
		["fetch", "https://acme.co.jp/contact-success", "Fetch", FORM_FRAME_ID],
		[
			"different frame",
			"https://acme.co.jp/contact-success",
			"Document",
			TOP_FRAME_ID,
		],
	])("blocks %s after POST", (_name, url, resourceType, frameId) => {
		const request = {
			...documentGet("completion", url),
			resourceType,
			frameId,
		};
		expect(
			decidePausedRequest(
				request,
				submittedPolicy().snapshot(),
				context({ blockNonSubmitRequests: true }),
			).action,
		).toBe("fail");
	});
	test.each([
		"https://acme.co.jp/contact",
		"https://other.acme.co.jp/leak?email=private",
		"https://acme.co.jp/complete?email=private",
		"https://acme.co.jp/second-completion",
	])("does not let a claimed script completion redirect to %s", (url) => {
		const policy = submittedPolicy();
		policy.claimCompletionNavigation();
		const request = {
			...documentGet("completion-redirect", url),
			redirectedRequestId: "completion",
		};
		expect(
			decidePausedRequest(
				request,
				policy.snapshot(),
				context({ blockNonSubmitRequests: true }),
			).action,
		).toBe("fail");
	});
	test("does not permit a completion page before POST, in dry-run, or after the attempt", () => {
		const request = documentGet(
			"completion",
			"https://acme.co.jp/contact-success",
		);
		const policy = submittedPolicy();
		expect(
			decidePausedRequest(
				request,
				getSubmissionPolicy("https://acme.co.jp/contact").snapshot(),
				context({ blockNonSubmitRequests: true }),
			).action,
		).toBe("fail");
		expect(
			decidePausedRequest(
				request,
				policy.snapshot(),
				context({
					blockNonSubmitRequests: true,
					dryRun: true,
					interactionStarted: true,
				}),
			).action,
		).toBe("fail");
		policy.endAttempt();
		expect(
			decidePausedRequest(
				request,
				policy.snapshot(),
				context({ blockNonSubmitRequests: true }),
			).action,
		).toBe("fail");
	});
});
