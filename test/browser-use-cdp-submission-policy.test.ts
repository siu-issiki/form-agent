import { describe, expect, test } from "bun:test";
import {
	createExpectedSubmissionRequest,
	decidePausedRequest,
	MAX_SUBMISSION_REQUESTS,
	type PausedRequest,
	type PausedRequestContext,
	SubmissionRequestPolicy,
} from "../src/browser-use-cdp-submission-policy";

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
