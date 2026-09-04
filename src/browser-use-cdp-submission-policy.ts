import { BROWSER_ERROR } from "./browser-error-messages";
import {
	assertAllowedBrowserRequest,
	isVerificationProviderRequest,
} from "./browser-network-policy";
import { BrowserElementError } from "./restricted-browser";

export interface PausedRequest {
	requestId: string;
	redirectedRequestId?: string;
	resourceType?: string;
	frameId?: string;
	request: { url: string; method: string };
}

export interface ExpectedSubmissionRequest {
	url: string;
	method: string;
}

export type SubmissionRequestBlockStage =
	| "expected_request"
	| "network_policy"
	| "request_limit";

type GetSubmissionRequestDisposition = "claim" | "block" | "ignore";

/**
 * How many unsafe requests one run may send while a submission is authorized.
 * The form action is no longer compared, so this cap -- together with the
 * domain check -- is what bounds a page that keeps posting during the
 * activation window.
 */
export const MAX_SUBMISSION_REQUESTS = 5;

export function shouldBlockNonSubmitRequest(
	blockNonSubmitRequests: boolean,
	submissionRequestAuthorized: boolean,
	navigationRequestAuthorized: boolean,
	submissionRedirectAuthorized = false,
): boolean {
	return (
		blockNonSubmitRequests &&
		!submissionRequestAuthorized &&
		!navigationRequestAuthorized &&
		!submissionRedirectAuthorized
	);
}

export function isAuthorizedSubmissionRedirect(
	paused: PausedRequest,
	previousRequestIds: ReadonlySet<string>,
	expectedFrameId: string | undefined,
): boolean {
	return (
		paused.redirectedRequestId !== undefined &&
		previousRequestIds.has(paused.redirectedRequestId) &&
		["GET", "HEAD"].includes(paused.request.method.toUpperCase()) &&
		["Document", "Fetch", "XHR"].includes(paused.resourceType ?? "") &&
		(expectedFrameId === undefined || paused.frameId === expectedFrameId)
	);
}

export function isExpectedNavigationDocumentRequest(
	request: ExpectedSubmissionRequest,
	resourceType: string | undefined,
	frameId: string | undefined,
	expected: { url: string; frameId?: string },
): boolean {
	return (
		request.method.toUpperCase() === "GET" &&
		resourceType === "Document" &&
		(expected.frameId === undefined || frameId === expected.frameId) &&
		canonicalHttpRequestUrl(request.url) === expected.url
	);
}

/** The request URL as the navigation bookkeeping records it: no fragment. */
export function canonicalHttpRequestUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.hash = "";
	return url.toString();
}

export function createExpectedSubmissionRequest(
	formAction: string,
	formMethod: string,
): ExpectedSubmissionRequest {
	const url = new URL(formAction);
	if (!["http:", "https:"].includes(url.protocol) || !formMethod) {
		throw new BrowserElementError();
	}
	url.hash = "";
	return { url: url.toString(), method: formMethod.toUpperCase() };
}

/**
 * Whether the request is the GET form submission `validateSubmit` recorded.
 * A GET submission is a plain document navigation, so it can only be told
 * apart from any other navigation by its URL; unsafe submissions are no longer
 * matched this way.
 */
export function isExpectedSubmissionRequest(
	request: { url: string; method: string },
	expected: ExpectedSubmissionRequest | undefined,
): boolean {
	const url = new URL(request.url);
	url.hash = "";
	if (!expected || request.method.toUpperCase() !== expected.method)
		return false;
	if (expected.method !== "GET") return url.toString() === expected.url;
	const expectedUrl = new URL(expected.url);
	return (
		url.origin === expectedUrl.origin && url.pathname === expectedUrl.pathname
	);
}

export function getSubmissionRequestDisposition(
	request: { url: string; method: string },
	resourceType: string | undefined,
	requestFrameId: string | undefined,
	expected: ExpectedSubmissionRequest | undefined,
	expectedFrameId: string | undefined,
	getSubmissionGuardActive: boolean,
	submissionRequestAllowed: boolean,
	submissionRequestCount: number,
	submissionRequestInFlight: boolean,
): GetSubmissionRequestDisposition {
	if (
		!getSubmissionGuardActive ||
		resourceType !== "Document" ||
		expected?.method !== "GET" ||
		!isExpectedSubmissionRequest(request, expected)
	) {
		return "ignore";
	}
	if (!requestFrameId || !expectedFrameId) return "block";
	if (requestFrameId !== expectedFrameId) return "ignore";
	return submissionRequestAllowed &&
		submissionRequestCount === 0 &&
		!submissionRequestInFlight
		? "claim"
		: "block";
}

/** The guard that keeps a GET submission from being replayed as a navigation. */
export interface GetSubmissionGuard {
	request: ExpectedSubmissionRequest;
	frameId?: string;
}

/**
 * The submission state {@link decidePausedRequest} reads. It is a plain
 * read-only view of {@link SubmissionRequestPolicy} so the decision cannot
 * mutate anything on its way to the answer.
 */
export interface SubmissionRequestPolicySnapshot {
	readonly submissionRequestAllowed: boolean;
	readonly submissionRequestInFlight: boolean;
	readonly submissionRequestCount: number;
	readonly submissionRequestTotal: number;
	readonly submissionAttemptInProgress: boolean;
	readonly submissionRedirectRequestIds: ReadonlySet<string>;
	readonly expectedSubmissionFrameId: string | undefined;
	readonly getSubmissionGuard: GetSubmissionGuard | undefined;
}

/**
 * The driver state outside the submission window that the same decision needs:
 * the domain scope, the network locks, and the navigation the driver expects.
 */
export interface PausedRequestContext {
	readonly topFrameId: string | undefined;
	readonly targetDomain: string | undefined;
	readonly allowedHosts: readonly string[];
	readonly blockNonSubmitRequests: boolean;
	readonly formDataEntered: boolean;
	readonly dryRun: boolean;
	readonly interactionStarted: boolean;
	readonly expectedNavigationRequest:
		| { url: string; frameId?: string; claimed: boolean }
		| undefined;
}

/**
 * What the driver must do with the paused request. `claimNavigation` is
 * reported even when the request ends refused: the expected navigation is
 * claimed before the network policy runs, so a refusal there still spends it.
 */
export interface PausedRequestDecision {
	readonly action: "continue" | "fail";
	readonly claimSubmission: boolean;
	readonly continueRedirect: boolean;
	readonly claimNavigation: boolean;
	readonly allowedByVerificationProvider: boolean;
	readonly submissionRelated: boolean;
	readonly blockStage: SubmissionRequestBlockStage;
}

/**
 * Decides a paused request without touching any state. Every refusal -- a
 * thrown {@link BrowserElementError}, a network policy rejection, an
 * unparsable URL -- is caught here and reported as `action: "fail"` together
 * with the stage that refused it, so the caller never has to catch anything.
 */
export function decidePausedRequest(
	paused: PausedRequest,
	state: SubmissionRequestPolicySnapshot,
	context: PausedRequestContext,
): PausedRequestDecision {
	const unsafeRequest = !["GET", "HEAD", "OPTIONS"].includes(
		paused.request.method.toUpperCase(),
	);
	// The widget's own iframe loads as a `Document` request below the top
	// frame. Only a request known to come from a subframe may take that path,
	// so an unknown `frameId` keeps counting as the top frame.
	const subframeRequest =
		paused.frameId !== undefined && paused.frameId !== context.topFrameId;
	// A known verification widget (reCAPTCHA / hCaptcha / Turnstile) is never
	// the form submission, so it stays outside the submission claim and out of
	// the block-stage diagnostics.
	const verificationProviderRequest = isVerificationProviderRequest(
		paused.request.url,
		paused.request.method,
		paused.resourceType,
		subframeRequest,
	);
	let blockStage: SubmissionRequestBlockStage = "network_policy";
	let submissionRelatedRequest = unsafeRequest && !verificationProviderRequest;
	let claimNavigationRequest = false;
	try {
		if (!context.targetDomain) {
			throw new Error(BROWSER_ERROR.DOMAIN_SCOPE_NOT_CONFIGURED);
		}
		const canContinueSubmissionRedirect =
			state.submissionAttemptInProgress &&
			isAuthorizedSubmissionRedirect(
				paused,
				state.submissionRedirectRequestIds,
				state.expectedSubmissionFrameId,
			);
		const getSubmissionGuard = state.getSubmissionGuard;
		const getSubmissionDisposition =
			canContinueSubmissionRedirect || verificationProviderRequest
				? "ignore"
				: getSubmissionRequestDisposition(
						paused.request,
						paused.resourceType,
						paused.frameId,
						getSubmissionGuard?.request,
						getSubmissionGuard?.frameId,
						getSubmissionGuard !== undefined,
						state.submissionRequestAllowed,
						state.submissionRequestCount,
						state.submissionRequestInFlight,
					);
		submissionRelatedRequest ||= getSubmissionDisposition !== "ignore";
		if (getSubmissionDisposition === "block") {
			blockStage = "expected_request";
			throw new BrowserElementError();
		}
		// Once the pre-submit review has allowed the submission, every unsafe
		// request the page makes inside the activation window is treated as
		// part of that submission. The form `action` is deliberately not
		// compared: a page script may post the entered values to another
		// endpoint of the same site, which is how WordPress Contact Form 7
		// and similar plugins submit. What still holds the values on the
		// target site is the domain check below; how many such requests one
		// run may make is bounded by MAX_SUBMISSION_REQUESTS.
		const submissionWindowRequest =
			state.submissionRequestAllowed &&
			unsafeRequest &&
			!verificationProviderRequest;
		if (
			submissionWindowRequest &&
			state.submissionRequestTotal >= MAX_SUBMISSION_REQUESTS
		) {
			blockStage = "request_limit";
			throw new BrowserElementError();
		}
		const canClaimSubmissionRequest =
			getSubmissionDisposition === "claim" || submissionWindowRequest;
		submissionRelatedRequest ||= canContinueSubmissionRedirect;
		const expectedNavigationRequest = context.expectedNavigationRequest;
		claimNavigationRequest =
			expectedNavigationRequest !== undefined &&
			!expectedNavigationRequest.claimed &&
			isExpectedNavigationDocumentRequest(
				paused.request,
				paused.resourceType,
				paused.frameId,
				expectedNavigationRequest,
			);
		blockStage = "network_policy";
		const allowedByVerificationProvider = assertAllowedBrowserRequest(
			paused.request.url,
			context.targetDomain,
			paused.request.method,
			canClaimSubmissionRequest,
			!context.formDataEntered && paused.resourceType !== "Document",
			(context.dryRun && context.interactionStarted) ||
				shouldBlockNonSubmitRequest(
					context.blockNonSubmitRequests,
					canClaimSubmissionRequest,
					claimNavigationRequest,
					canContinueSubmissionRedirect,
				),
			context.allowedHosts,
			paused.resourceType,
			subframeRequest,
		);
		return {
			action: "continue",
			claimSubmission: canClaimSubmissionRequest,
			continueRedirect:
				!canClaimSubmissionRequest && canContinueSubmissionRedirect,
			claimNavigation: claimNavigationRequest,
			allowedByVerificationProvider,
			submissionRelated: submissionRelatedRequest,
			blockStage,
		};
	} catch {
		return {
			action: "fail",
			claimSubmission: false,
			continueRedirect: false,
			claimNavigation: claimNavigationRequest,
			allowedByVerificationProvider: false,
			submissionRelated: submissionRelatedRequest,
			blockStage,
		};
	}
}

/**
 * The state behind the submission window: what the pre-submit review
 * authorized, how much of the per-run budget is spent, and which requests the
 * current submission already owns.
 *
 * The whole point of this object is that a claim cannot be raced. Between
 * {@link SubmissionRequestPolicy.snapshot} and
 * {@link SubmissionRequestPolicy.claim} the caller must not `await`: the CDP
 * event loop delivers several `Fetch.requestPaused` events in the same tick,
 * so a suspension there would let two of them read the same budget and both
 * claim it. Every method here is therefore synchronous and must stay so.
 */
export class SubmissionRequestPolicy {
	#submissionRequestAllowed = false;
	#submissionRequestInFlight = false;
	#submissionRequestCount = 0;
	/** Submission requests continued across the whole run, capped by {@link MAX_SUBMISSION_REQUESTS}. */
	#submissionRequestTotal = 0;
	#submissionAttemptInProgress = false;
	#submissionRequestBlockStage: SubmissionRequestBlockStage | undefined;
	/**
	 * Requests already continued as part of the current submission. A redirect
	 * names the request it came from, so the set is what lets the follow-up of
	 * any claimed request through.
	 */
	readonly #submissionRedirectRequestIds = new Set<string>();
	#expectedSubmissionRequest: ExpectedSubmissionRequest | undefined;
	#expectedSubmissionFrameId: string | undefined;
	#getSubmissionGuard: GetSubmissionGuard | undefined;
	#validatedSubmitInputBackendNodeId: number | undefined;
	#submissionRequestObserved: (() => void) | undefined;

	/** The submission `validateSubmit` last recorded, if it succeeded. */
	get expectedRequest(): ExpectedSubmissionRequest | undefined {
		return this.#expectedSubmissionRequest;
	}

	/** The frame the validated submit control belongs to. */
	get expectedFrameId(): string | undefined {
		return this.#expectedSubmissionFrameId;
	}

	/** A field of this run the validated submit control shares a form with. */
	get validatedInputBackendNodeId(): number | undefined {
		return this.#validatedSubmitInputBackendNodeId;
	}

	/** Requests continued during the current activation window. */
	get requestCount(): number {
		return this.#submissionRequestCount;
	}

	/** The stage that refused the first blocked request of the attempt. */
	get blockStage(): SubmissionRequestBlockStage | undefined {
		return this.#submissionRequestBlockStage;
	}

	/** Drops what a previous `validateSubmit` recorded before inspecting again. */
	beginValidation(): void {
		this.#expectedSubmissionRequest = undefined;
		this.#validatedSubmitInputBackendNodeId = undefined;
	}

	/** Remembers the first field of this run the submit control owns. */
	noteValidatedInput(backendNodeId: number): void {
		this.#validatedSubmitInputBackendNodeId ??= backendNodeId;
	}

	/** Records the submission the inspected control is expected to send. */
	completeValidation(
		expected: ExpectedSubmissionRequest,
		frameId: string | undefined,
	): void {
		this.#expectedSubmissionRequest = expected;
		this.#expectedSubmissionFrameId = frameId;
	}

	/**
	 * Starts a submission: the requests of any earlier one are forgotten, and a
	 * GET submission arms the guard that keeps it from being replayed. The
	 * guard is armed once per run, so a retry keeps the first one.
	 */
	beginSubmit(): void {
		this.#submissionRedirectRequestIds.clear();
		if (this.#expectedSubmissionRequest?.method === "GET") {
			this.#getSubmissionGuard ??= {
				request: this.#expectedSubmissionRequest,
				...(this.#expectedSubmissionFrameId
					? { frameId: this.#expectedSubmissionFrameId }
					: {}),
			};
		}
	}

	/** Opens the attempt the block-stage diagnostics are reported for. */
	beginAttempt(): void {
		this.#submissionAttemptInProgress = true;
		this.#submissionRequestBlockStage = undefined;
	}

	/** Closes the attempt and the window, whatever the activation did. */
	endAttempt(): void {
		this.#submissionRequestAllowed = false;
		this.#submissionAttemptInProgress = false;
	}

	/**
	 * Opens the window in which unsafe requests count as this submission. The
	 * per-activation count starts again at zero while the per-run budget stays
	 * spent, so a second activation cannot buy back the first one's requests.
	 */
	openActivationWindow(onObserved: () => void): void {
		this.#submissionRequestCount = 0;
		this.#submissionRequestInFlight = false;
		this.#submissionRequestObserved = onObserved;
		this.#submissionRequestAllowed = true;
	}

	/** Closes the window, so a later request needs a new pre-submit review. */
	closeActivationWindow(): void {
		this.#submissionRequestAllowed = false;
		this.#submissionRequestObserved = undefined;
	}

	/**
	 * Spends one unit of the per-run budget on the request and marks it
	 * in flight. MUST be called synchronously after {@link snapshot}: an
	 * `await` in between would let a second paused request read the same
	 * budget and claim it too.
	 */
	claim(requestId: string): void {
		this.#submissionRequestInFlight = true;
		this.#submissionRequestTotal += 1;
		this.#submissionRedirectRequestIds.add(requestId);
	}

	/**
	 * Lets the follow-up of a request that was already continued through
	 * without spending the budget.
	 */
	continueRedirect(requestId: string): void {
		this.#submissionRedirectRequestIds.add(requestId);
	}

	/** Releases the in-flight claim, whether the continue succeeded or not. */
	release(): void {
		this.#submissionRequestInFlight = false;
	}

	/** Counts a claimed request the browser actually continued. */
	recordContinued(): void {
		this.#submissionRequestCount += 1;
		this.#submissionRequestObserved?.();
	}

	/**
	 * Keeps the stage that refused the first blocked request of the attempt,
	 * which is the one the uncertain reason code reports.
	 */
	noteBlocked(stage: SubmissionRequestBlockStage): void {
		if (!this.#submissionAttemptInProgress) return;
		this.#submissionRequestBlockStage ??= stage;
	}

	/** The read-only view {@link decidePausedRequest} decides from. */
	snapshot(): SubmissionRequestPolicySnapshot {
		return {
			submissionRequestAllowed: this.#submissionRequestAllowed,
			submissionRequestInFlight: this.#submissionRequestInFlight,
			submissionRequestCount: this.#submissionRequestCount,
			submissionRequestTotal: this.#submissionRequestTotal,
			submissionAttemptInProgress: this.#submissionAttemptInProgress,
			submissionRedirectRequestIds: this.#submissionRedirectRequestIds,
			expectedSubmissionFrameId: this.#expectedSubmissionFrameId,
			getSubmissionGuard: this.#getSubmissionGuard,
		};
	}

	/**
	 * Forgets everything tied to the elements of the current document. The
	 * per-run budget and the GET guard deliberately survive: a new document is
	 * not a new run.
	 */
	clear(): void {
		this.#expectedSubmissionRequest = undefined;
		this.#validatedSubmitInputBackendNodeId = undefined;
		this.#expectedSubmissionFrameId = undefined;
	}
}
