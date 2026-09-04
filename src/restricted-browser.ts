import { parse } from "tldts";
import { BROWSER_ERROR } from "./browser-error-messages";
import {
	checkProhibitionEvidence,
	detectProhibitedReasonCodes,
	detectProhibitedTextReasonCodes,
	isProhibitedReasonCode,
	logProhibitionEvidence,
	type ProhibitedReasonCode,
	type ProhibitionEvidenceOutcome,
	type ProhibitionVerification,
	readProhibitedReasonCodes,
} from "./form-prohibition";
import type { Job, JobStore } from "./job";
import { isRecord } from "./json-record";
import {
	type ObservedField,
	type ObservedForm,
	parseObservedForms,
} from "./observed-form";
import {
	EVIDENCE_CONTENT_TYPE,
	type EvidenceCaptureResult,
	type EvidenceObjectStore,
	logDryRunEvidenceCaptureFailed,
	SubmissionEvidenceRecorder,
} from "./submission-evidence";
import type { SUBMIT_ACTIVATION_STRATEGIES } from "./tool-input-patterns";

/** A denial only allows one correction; the second denial ends the job. */
const MAX_SUBMIT_REVIEW_DENIALS = 2;
/**
 * How many submit activations one run may make. A Japanese inquiry form often
 * answers the first submission with a confirmation screen whose own button
 * sends the message, so a single activation is not always the whole
 * submission. The pre-submit review runs on the first stage only; every later
 * stage has to prove that the page still carries the reviewed values.
 */
export const MAX_SUBMIT_STAGES = 3;
/** How much of the entered message a confirmation screen has to repeat. */
const SUBMIT_STAGE_BODY_PREFIX_LENGTH = 40;
/** Matches a single address, so the entered email can be told from other text. */
const ENTERED_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBMIT_REVIEW_REASON_LENGTH = 500;
const SUBMIT_REVIEW_BUDGET_EXHAUSTED_REASON =
	"Pre-submit review denied the submission and its correction budget is exhausted.";
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are flattened on purpose
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/g;

export interface BrowserObservation {
	url: string;
	forms: unknown[];
	pageText?: string;
	pageTextTruncated?: boolean;
	navigationLinks?: Array<{ url: string; text: string }>;
	prohibitedReasonCodes?: ProhibitedReasonCode[];
}

export type SubmitReviewReasonCode =
	| "INPUTS_MATCH"
	| "INPUT_MISMATCH"
	| "SALES_PROHIBITED"
	| "FORM_PURPOSE_INCOMPATIBLE"
	| "WRONG_FORM"
	| "UNCLEAR";

export interface SubmitReviewDecision {
	decision: "allow" | "deny";
	reasonCode: SubmitReviewReasonCode;
	reason: string;
}

export interface SubmitReviewInput {
	targetDomain: string;
	targetUrl: string;
	currentUrl: string;
	formValues: Record<string, TrustedFormValue>;
	observation: BrowserObservation;
	submitElementId: string;
	screenshot: { contentType: "image/jpeg"; bytes: Uint8Array } | null;
}

export interface SubmitReviewer {
	review(input: SubmitReviewInput): Promise<SubmitReviewDecision>;
}

export interface ObservedFieldState {
	elementId: string;
	value: string;
	checked: boolean;
}

/** One observed form field, as the dry-run field map records it. */
export interface DryRunEvidenceField {
	elementId: string;
	label: string | null;
	name: string | null;
	type: string | null;
	required: boolean | null;
	value: string;
	checked?: boolean;
}

export interface DryRunEvidenceFieldMap {
	targetUrl: string;
	capturedAt: string;
	submitReview: {
		decision: SubmitReviewDecision["decision"];
		reasonCode: SubmitReviewReasonCode;
	};
	fields: DryRunEvidenceField[];
}

/**
 * Flattens the latest observation into the fields an operator checks before a
 * real send. Submit controls and buttons are left out for the same reason the
 * review fingerprint drops them: they are not fields anyone filled in. A
 * password value is never carried, matching the driver's own observation.
 */
export function dryRunFieldMap(
	forms: readonly ObservedForm[],
	review: SubmitReviewDecision,
	targetUrl: string,
	capturedAt: string,
): DryRunEvidenceFieldMap {
	const fields: DryRunEvidenceField[] = [];
	for (const form of forms) {
		for (const field of form.fields ?? []) {
			if (!isReviewComparableField(field.tag, field.type)) continue;
			if (field.elementId === undefined) continue;
			const type = field.type ?? null;
			fields.push({
				elementId: field.elementId,
				label: field.label ?? null,
				name: field.name ?? null,
				type,
				required: field.required ?? null,
				value: type === "password" ? "" : (field.value ?? ""),
				...(field.checked === undefined ? {} : { checked: field.checked }),
			});
		}
	}
	return {
		targetUrl,
		capturedAt,
		submitReview: { decision: review.decision, reasonCode: review.reasonCode },
		fields,
	};
}

/**
 * Canonical description of the values a reviewer judged, used to require that
 * a correction actually changed something. Element ids are excluded so that a
 * re-render which only renumbers elements does not read as a correction.
 */
export function observationFingerprint(
	observedForms: readonly ObservedForm[],
): string {
	const forms: unknown[] = [];
	for (const form of observedForms) {
		// A form the page did not describe with a field array is recorded as
		// null, which stays distinct from a form that reported no fields.
		if (!form.fields) {
			forms.push(null);
			continue;
		}
		const fields: unknown[] = [];
		for (const field of form.fields) {
			if (!isReviewComparableField(field.tag, field.type)) continue;
			// Parsing already narrowed every property to the type its readers
			// expect, so anything else the page reported reads as null here,
			// the way the scalar reduction did before it. The one shape that
			// differs is a boolean in a string-typed property or the reverse,
			// which no driver produces.
			fields.push([
				field.tag ?? null,
				field.type ?? null,
				field.name ?? null,
				field.label ?? null,
				field.value ?? null,
				field.checked ?? null,
			]);
		}
		forms.push(fields);
	}
	return JSON.stringify(forms);
}

/**
 * Mirrors the driver's own exclusion rule so that the observation and the live
 * read-back always describe the same set of elements. Submit controls and
 * buttons are excluded because activating them is what `submit` does.
 */
export function isReviewComparableField(tag: unknown, type: unknown): boolean {
	if (tag === "button") return false;
	if (tag === "input" && (type === "submit" || type === "image")) return false;
	return true;
}

/** The pre-submit review rejected this submission. */
export class SubmitReviewDeniedError extends Error {
	constructor(readonly reasonCode: SubmitReviewReasonCode) {
		super("The pre-submit review denied the submission");
		this.name = "SubmitReviewDeniedError";
	}
}

/** The pre-submit review could not produce a decision. */
export class SubmitReviewUnavailableError extends Error {
	constructor() {
		super("The pre-submit review could not be completed");
		this.name = "SubmitReviewUnavailableError";
	}
}

export const PAYLOAD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_PAYLOAD_VALUE_LENGTH = 8_192;
export const MAX_CANDIDATE_COUNT = 10;
export const MAX_CANDIDATE_LENGTH = 256;
export const MAX_CANDIDATE_TOTAL_LENGTH = 2_048;

/**
 * A trusted payload value is either a single value or an ordered set of
 * candidate labels the registrant allowed for one choice control. The handler
 * picks the first candidate the control actually offers; the model only ever
 * names the key.
 */
export type TrustedFormValue = string | readonly string[];

export function isTrustedPayloadString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PAYLOAD_VALUE_LENGTH
	);
}

/** The candidate list contract shared by `POST /jobs` and the tool handler. */
export function isTrustedCandidateList(
	value: unknown,
): value is readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > MAX_CANDIDATE_COUNT
	) {
		return false;
	}
	let totalLength = 0;
	for (const candidate of value) {
		if (
			typeof candidate !== "string" ||
			candidate.length < 1 ||
			candidate.length > MAX_CANDIDATE_LENGTH
		) {
			return false;
		}
		totalLength += candidate.length;
	}
	return totalLength <= MAX_CANDIDATE_TOTAL_LENGTH;
}

export function isTrustedFormValue(value: unknown): value is TrustedFormValue {
	return isTrustedPayloadString(value) || isTrustedCandidateList(value);
}

/**
 * Narrows `job.payload.formValues` to the entries the trusted handler is
 * willing to enter into a form. It lives here so that the browser tool handler
 * and the pre-submit review share exactly one definition of a trusted value.
 */
export function readTrustedFormValues(
	payload: Record<string, unknown>,
): Record<string, TrustedFormValue> {
	const formValues = payload.formValues;
	// A null prototype keeps inherited members such as `constructor` out of the
	// result, so a payloadKey can only ever resolve to a job-supplied value.
	const trusted: Record<string, TrustedFormValue> = Object.create(null);
	if (!isRecord(formValues)) return trusted;
	for (const [key, value] of Object.entries(formValues)) {
		if (!PAYLOAD_KEY_PATTERN.test(key)) continue;
		if (isTrustedPayloadString(value)) {
			trusted[key] = value;
			continue;
		}
		if (isTrustedCandidateList(value)) {
			// A frozen copy keeps a later mutation of the parsed payload from
			// changing what the handler already resolved.
			trusted[key] = Object.freeze([...value]);
		}
	}
	return trusted;
}

export type BrowserSubmitResult =
	| { outcome: "sent"; formUrl: string }
	| {
			outcome: "uncertain";
			reasonCode: string;
			reason: string;
	  };

/**
 * The driver's code for "the submission request went out, but the page never
 * showed a completion". It is the one outcome a further stage may follow.
 */
export const SUBMIT_CONFIRMATION_NOT_OBSERVED =
	"SUBMIT_CONFIRMATION_NOT_OBSERVED";

/**
 * One stage was activated and the page has not confirmed a completed send.
 * The model may observe and call `submit` again; nothing has been recorded.
 */
export interface SubmitStagePending {
	pendingStage: number;
}

export function isSubmitStagePending(
	value: Job | SubmitStagePending,
): value is SubmitStagePending {
	return "pendingStage" in value;
}

/**
 * Whether the browser saw a submission request leave the page. `sent` is only
 * reported after one was observed, and the uncertain code above says the same
 * in the case where no completion followed.
 */
export function submitRequestObserved(result: BrowserSubmitResult): boolean {
	return (
		result.outcome === "sent" ||
		result.reasonCode === SUBMIT_CONFIRMATION_NOT_OBSERVED
	);
}

export type SubmitActivationStrategy =
	(typeof SUBMIT_ACTIVATION_STRATEGIES)[number];

/** Which part of the page a screenshot covers. */
export type ScreenshotMode = "viewport" | "full_page";

export interface RestrictedBrowserDriver {
	close?(): Promise<void>;
	restrictToDomain(
		targetDomain: string,
		allowedHosts: readonly string[],
	): Promise<void>;
	currentUrl(): Promise<string>;
	navigate(url: string): Promise<void>;
	observe(): Promise<BrowserObservation>;
	clickNonSubmit(elementId: string): Promise<void>;
	fill(elementId: string, value: string): Promise<void>;
	/**
	 * Applies the first candidate the control actually offers. The candidates
	 * come from the job payload, never from the model.
	 */
	select(elementId: string, candidates: readonly string[]): Promise<void>;
	/**
	 * `requireEnteredInput` is false only for a later stage of the same
	 * submission, where the confirmation screen no longer holds the fields this
	 * run filled.
	 */
	validateSubmit(
		elementId: string,
		requireEnteredInput?: boolean,
	): Promise<void>;
	/**
	 * Re-reads the live state of every element named by the latest observation,
	 * excluding submit controls and buttons. It is used to detect a page that
	 * changed itself between the review and the submission.
	 */
	readObservedFieldStates(): Promise<ObservedFieldState[]>;
	/**
	 * Reads the visible body text of the current document, truncated at the
	 * driver's page text limit. Used right after a submit stage to tell a
	 * confirmation screen that repeats the entered values from a page that
	 * no longer shows them.
	 */
	readPageText?(): Promise<string>;
	/**
	 * Rediscovers the form that owns the submit control and returns a canonical
	 * string covering every control it holds, hidden and disabled included.
	 * Comparing two snapshots detects elements added, removed, or altered
	 * between the review and the submission, which a read-back limited to the
	 * previously observed elements cannot see.
	 */
	readFormSnapshot(elementId: string): Promise<string>;
	/**
	 * `viewport` captures the visible screen only. `full_page` captures the
	 * whole document, downscaled so the payload stays inside the CDP message
	 * limit. The caller picks, because evidence wants the whole form while a
	 * fallback wants the cheapest capture that can still succeed.
	 */
	captureScreenshot(mode: ScreenshotMode): Promise<Uint8Array>;
	submit(
		elementId: string,
		activationStrategy: SubmitActivationStrategy,
		requireEnteredInput?: boolean,
	): Promise<BrowserSubmitResult>;
}

export class NavigationPolicyError extends Error {
	constructor() {
		super("Browser navigation is outside the allowed target domain");
		this.name = "NavigationPolicyError";
	}
}

export class BrowserElementError extends Error {
	constructor() {
		super("The browser element is unavailable or incompatible");
		this.name = "BrowserElementError";
	}
}

export class BrowserFormInvalidError extends BrowserElementError {
	constructor() {
		super();
		this.name = "BrowserFormInvalidError";
	}
}

export type BrowserElementOperation = "click" | "fill" | "select";

/**
 * A CDP command failed while an element was being operated. The page most
 * likely moved under the operation, so the model re-observes and continues
 * instead of the whole run ending as a browser failure.
 */
export class BrowserElementOperationError extends BrowserElementError {
	constructor(readonly operation: BrowserElementOperation) {
		super();
		this.name = "BrowserElementOperationError";
	}
}

/**
 * The form that owns the submit control carries a prohibition. It is separate
 * from a plain element error so that the model is told to finish as prohibited
 * instead of treating the block as a technical failure.
 */
export class SubmitProhibitedError extends BrowserElementError {
	constructor(
		readonly reasonCodes: ProhibitedReasonCode[],
		readonly pageProhibited: boolean,
	) {
		super();
		this.name = "SubmitProhibitedError";
	}
}

/** The latest observation is older than the latest trusted input. */
export class ObservationStaleError extends BrowserElementError {
	constructor() {
		super();
		this.name = "ObservationStaleError";
	}
}

/** The review denied the inputs and no field has been changed since. */
export class CorrectionRequiredError extends BrowserElementError {
	constructor() {
		super();
		this.name = "CorrectionRequiredError";
	}
}

/**
 * A later submit stage was refused because the page did not show the values
 * the review already approved. It is separate from a plain element error so
 * that the model is told to observe the confirmation screen rather than to
 * pick another control.
 */
export class SubmitStageUnverifiedError extends BrowserElementError {
	constructor() {
		super();
		this.name = "SubmitStageUnverifiedError";
	}
}

/** The page changed between the review and the submission. */
export class FormStateChangedError extends BrowserElementError {
	constructor() {
		super();
		this.name = "FormStateChangedError";
	}
}

/**
 * The model quoted a sentence for the prohibition but the handler could not
 * confirm it against the observed page text. The code says which check failed
 * so the diagnostic can distinguish a fabricated quote from a real sentence
 * that does not state a refusal.
 */
export class ProhibitionEvidenceError extends BrowserElementError {
	constructor(
		readonly code: Exclude<
			ProhibitionEvidenceOutcome,
			"PROHIBITION_EVIDENCE_VERIFIED"
		>,
	) {
		super();
		this.name = "ProhibitionEvidenceError";
	}
}

export class SubmissionNotAuthorizedError extends Error {
	constructor() {
		super("The job did not grant submission permission");
		this.name = "SubmissionNotAuthorizedError";
	}
}

export class SubmissionEvidenceError extends Error {
	constructor() {
		super("The submission evidence could not be captured before submission");
		this.name = "SubmissionEvidenceError";
	}
}

export class SubmissionResultUncertainError extends Error {
	constructor() {
		super("The submission result is uncertain and must not be retried");
		this.name = "SubmissionResultUncertainError";
	}
}

export type BrowserSubmitFailureStage =
	| "SUBMIT_OPERATION"
	| "SUBMIT_VALIDATE"
	| "SUBMIT_READ_BEFORE_TEXT"
	| "SUBMIT_READ_AFTER_TEXT"
	| "SUBMIT_CLICK"
	| "SUBMIT_ACTIVATE"
	| "POST_SUBMIT_URL_CHECK";

export type BrowserSubmitFailureCode =
	| "ELEMENT_UNAVAILABLE"
	| "NAVIGATION_POLICY"
	| "CDP_CONNECTION_CLOSED"
	| "CDP_COMMAND_TIMEOUT"
	| "CDP_COMMAND_SEND_FAILED"
	| "CDP_COMMAND_FAILED"
	| "CDP_PAYLOAD_TOO_LARGE"
	| "PAGE_EVALUATION_FAILED"
	| "UNKNOWN";

export class BrowserSubmitDiagnosticError extends Error {
	constructor(
		readonly stage: BrowserSubmitFailureStage,
		readonly diagnosticCode: BrowserSubmitFailureCode,
	) {
		super("The browser submit operation failed");
		this.name = "BrowserSubmitDiagnosticError";
	}
}

export function createBrowserSubmitDiagnosticError(
	stage: BrowserSubmitFailureStage,
	error: unknown,
): BrowserSubmitDiagnosticError {
	return new BrowserSubmitDiagnosticError(stage, classifyBrowserFailure(error));
}

/**
 * What one submit activation produced: either the browser's result or the
 * error the driver threw, never both. Both are carried on so that the failure
 * is recorded as a submission result instead of escaping as an error.
 */
interface SubmitActivationOutcome {
	result: BrowserSubmitResult | undefined;
	submitError: unknown;
}

export class RestrictedBrowserTools {
	readonly #targetDomain: string;
	readonly #targetUrl: string;
	readonly #allowedHosts: string[];
	readonly #formValues: Record<string, TrustedFormValue>;
	readonly #successfulInputElementIds = new Set<string>();
	readonly #allowedNavigationUrls = new Set<string>();
	#latestObservation: BrowserObservation | undefined;
	/**
	 * `#latestObservation.forms`, typed once by `parseObservedForms`. It is
	 * written and cleared with the observation itself, so it never describes a
	 * page that observation does not.
	 */
	#latestObservedForms: ObservedForm[] = [];
	#inputRevision = 0;
	#observationRevision = -1;
	/** Bounds the handler's own re-observation to one per input revision. */
	#prohibitionReverifiedRevision = -1;
	/** Submit activations already made in this run, capped by MAX_SUBMIT_STAGES. */
	#submitStage = 0;
	/** Set while an activation happened and no result has been recorded for it. */
	#unconfirmedSubmission = false;
	/** Values `fill` entered, used to recognise a confirmation screen. */
	readonly #enteredValues: string[] = [];
	#deniedFingerprint: string | undefined;
	#correctionInputApplied = false;

	private constructor(
		private readonly driver: RestrictedBrowserDriver,
		private readonly jobs: JobStore,
		private readonly jobId: string,
		private readonly runToken: string,
		private readonly recorder: SubmissionEvidenceRecorder,
		private readonly reviewer: SubmitReviewer,
		targetDomain: string,
		allowedHosts: readonly string[],
		targetUrl: string,
		formValues: Record<string, TrustedFormValue>,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.#targetDomain = normalizeTargetDomain(targetDomain);
		this.#allowedHosts = normalizeAllowedHosts(allowedHosts);
		this.#targetUrl = targetUrl;
		this.#formValues = formValues;
		this.#allowedNavigationUrls.add(canonicalNavigationUrl(targetUrl));
	}

	static async create(
		driver: RestrictedBrowserDriver,
		jobs: JobStore,
		jobId: string,
		runToken: string,
		evidenceStore: EvidenceObjectStore,
		reviewer: SubmitReviewer,
		now: () => string = () => new Date().toISOString(),
	): Promise<RestrictedBrowserTools> {
		const job = await jobs.find(jobId);
		if (job?.status !== "running" || job.runToken !== runToken) {
			throw new SubmissionNotAuthorizedError();
		}

		const targetDomain = normalizeTargetDomain(job.targetDomain);
		const allowedHosts = normalizeAllowedHosts(job.allowedHosts);
		assertAllowedTargetUrl(job.targetUrl, targetDomain, allowedHosts);
		await driver.restrictToDomain(targetDomain, allowedHosts);
		return new RestrictedBrowserTools(
			driver,
			jobs,
			jobId,
			runToken,
			new SubmissionEvidenceRecorder(
				driver,
				evidenceStore,
				jobs,
				jobId,
				runToken,
				job.attemptCount,
				now,
			),
			reviewer,
			targetDomain,
			allowedHosts,
			job.targetUrl,
			readTrustedFormValues(job.payload),
			now,
		);
	}

	captureEvidence(stage: "prohibited"): Promise<EvidenceCaptureResult> {
		return this.recorder.capture(stage);
	}

	/**
	 * Dry-run review. The screen is captured once, before the review, and the
	 * same bytes are both handed to the reviewer and kept as the
	 * `dry_run_before_submit` evidence -- so what an operator later looks at is
	 * the image the review judged, not a re-capture of a page that may have
	 * moved since. This mirrors the real `submit` path, which reviews the
	 * `before_submit` screenshot.
	 *
	 * The capture is best effort: a failure leaves the review to run without an
	 * image, exactly as it did before any evidence existed.
	 */
	async reviewDryRunSubmit(elementId: string): Promise<SubmitReviewDecision> {
		await this.validateSubmit(elementId);
		let capture: EvidenceCaptureResult;
		try {
			capture = await this.recorder.capture("dry_run_before_submit");
		} catch {
			capture = { captured: false, failureCode: "SCREENSHOT_FAILED" };
		}
		if (!capture.captured) {
			logDryRunEvidenceCaptureFailed(
				"dry_run_before_submit",
				capture.failureCode,
			);
		}
		return this.reviewSubmit(
			elementId,
			capture.captured
				? { contentType: EVIDENCE_CONTENT_TYPE, bytes: capture.body }
				: null,
		);
	}

	/**
	 * The values the reviewed screen carried, written after the decision it
	 * records. It holds page content and registration values, so it exists only
	 * as an object in the evidence store: nothing about it reaches D1 or the
	 * logs beyond the object key. Best effort, like the screenshot.
	 */
	async captureDryRunFieldMap(review: SubmitReviewDecision): Promise<void> {
		const fieldMap = await this.recorder.captureJson(
			"dry_run_field_map",
			dryRunFieldMap(
				this.#latestObservedForms,
				review,
				this.#targetUrl,
				this.now(),
			),
		);
		if (!fieldMap.captured) {
			logDryRunEvidenceCaptureFailed("dry_run_field_map", fieldMap.failureCode);
		}
	}

	async navigate(url: string): Promise<void> {
		this.#assertAllowedUrl(url);
		const canonicalUrl = canonicalNavigationPermissionUrl(url);
		if (!this.#allowedNavigationUrls.has(canonicalUrl)) {
			const currentUrl = await this.driver.currentUrl();
			this.#assertAllowedUrl(currentUrl);
			if (canonicalNavigationPermissionUrl(currentUrl) === canonicalUrl) return;
			throw new NavigationPolicyError();
		}
		await this.driver.navigate(url);
		await this.#assertCurrentUrlAllowed();
		// Reset: everything that described the page just left. The element ids and
		// the observation belong to that page, and the navigation permissions come
		// from the links it showed. The revision bump makes the missing
		// observation stale for `#observationIsFresh`, and re-arms the one
		// re-observation `validateProhibited` is allowed per input revision.
		this.#successfulInputElementIds.clear();
		this.#latestObservation = undefined;
		this.#latestObservedForms = [];
		this.#allowedNavigationUrls.clear();
		this.#inputRevision += 1;
		// Deliberately kept: `#enteredValues` is what this run typed anywhere on
		// the site and is how a later stage recognises a confirmation screen;
		// `#deniedFingerprint` / `#correctionInputApplied` hold a denied review
		// that navigating away does not correct; `#submitStage` /
		// `#unconfirmedSubmission` record an activation that already happened, and
		// no navigation may hand the run a fresh submission permission.
	}

	async observe(): Promise<BrowserObservation> {
		await this.#assertCurrentUrlAllowed();
		const observation = await this.driver.observe();
		this.#assertAllowedUrl(observation.url);
		const navigationLinks = observation.navigationLinks?.filter((link) => {
			try {
				this.#assertAllowedUrl(link.url);
				return true;
			} catch {
				return false;
			}
		});
		const trustedForms = trustObservedForms(observation.forms);
		// The one place page-supplied form data is typed. `forms` itself stays
		// the observed JSON, because that is what the model is shown.
		const observedForms = parseObservedForms(trustedForms);
		const trustedObservation: BrowserObservation = {
			...observation,
			forms: trustedForms,
			...(navigationLinks ? { navigationLinks } : {}),
			prohibitedReasonCodes: detectProhibitedReasonCodes({
				forms: observedForms,
				...(observation.pageText === undefined
					? {}
					: { pageText: observation.pageText }),
			}),
		};
		this.#latestObservation = trustedObservation;
		this.#latestObservedForms = observedForms;
		this.#observationRevision = this.#inputRevision;
		this.#allowedNavigationUrls.clear();
		this.#allowedNavigationUrls.add(
			canonicalNavigationPermissionUrl(trustedObservation.url),
		);
		for (const link of trustedObservation.navigationLinks ?? []) {
			this.#allowedNavigationUrls.add(
				canonicalNavigationPermissionUrl(link.url),
			);
		}
		return trustedObservation;
	}

	async click(elementId: string): Promise<void> {
		await this.driver.clickNonSubmit(elementId);
		await this.#assertCurrentUrlAllowed();
		this.#inputRevision += 1;
	}

	async fill(elementId: string, value: string): Promise<void> {
		await this.driver.fill(elementId, value);
		await this.#assertCurrentUrlAllowed();
		this.#enteredValues.push(value);
		this.#successfulInputElementIds.add(elementId);
		this.#inputRevision += 1;
		// A denied review is only cleared once an input actually changed the
		// observed values, which `validateSubmit` decides from the fingerprint.
		this.#correctionInputApplied = true;
	}

	async select(
		elementId: string,
		candidates: readonly string[],
	): Promise<void> {
		await this.driver.select(elementId, candidates);
		await this.#assertCurrentUrlAllowed();
		this.#successfulInputElementIds.add(elementId);
		this.#inputRevision += 1;
		this.#correctionInputApplied = true;
	}

	async validateSubmit(
		elementId: string,
		requireEnteredInput = true,
	): Promise<void> {
		if (requireEnteredInput && this.#successfulInputElementIds.size < 1) {
			throw new BrowserElementError();
		}
		if (this.#deniedFingerprint !== undefined && !this.#hasCorrectedInputs()) {
			throw new CorrectionRequiredError();
		}
		if (!this.#observationIsFresh()) {
			throw new ObservationStaleError();
		}
		const formReasonCodes = prohibitedReasonCodesForElement(
			this.#latestObservedForms,
			elementId,
		);
		if (formReasonCodes.length > 0) {
			// Only codes the page-level detection also carries can pass
			// `validateProhibited`, so the model is never handed a code that its
			// `finish_prohibited` call would then be rejected for.
			const pageReasonCodes =
				this.#latestObservation?.prohibitedReasonCodes ?? [];
			const verifiable = formReasonCodes.filter((code) =>
				pageReasonCodes.includes(code),
			);
			throw new SubmitProhibitedError(
				verifiable.length > 0 ? verifiable : formReasonCodes,
				verifiable.length > 0,
			);
		}
		await this.#assertCurrentUrlAllowed();
		await this.driver.validateSubmit(elementId, requireEnteredInput);
		await this.#assertCurrentUrlAllowed();
	}

	/**
	 * Accepts a prohibition claim either from the handler's own pattern
	 * detection or from a sentence the model quoted, when that sentence is
	 * present verbatim in the observed page text. The quote is verified, never
	 * trusted: the fixed patterns cannot cover every Japanese refusal, but the
	 * model still cannot invent a prohibition the page does not state.
	 */
	async validateProhibited(
		reasonCode: ProhibitedReasonCode,
		formUrl: string | null,
		evidence?: string | null,
	): Promise<ProhibitionVerification> {
		const observation = await this.#assertProhibitionClaimContext(formUrl);
		return await this.#verifyProhibitionClaim(
			reasonCode,
			evidence,
			observation,
		);
	}

	/**
	 * Checks what a prohibition claim is allowed to rest on: an observation
	 * taken after the last input, describing both the page the claim names and
	 * the page the browser is actually on.
	 */
	async #assertProhibitionClaimContext(
		formUrl: string | null,
	): Promise<BrowserObservation> {
		const observation = this.#latestObservation;
		// Observing after the last input stays the model's obligation, and a URL
		// mismatch is not something a fresh observation can repair.
		if (!this.#observationIsFresh() || !observation) {
			throw new BrowserElementError();
		}
		if (
			(formUrl !== null &&
				canonicalNavigationUrl(formUrl) !==
					canonicalNavigationUrl(observation.url)) ||
			canonicalNavigationPermissionUrl(await this.driver.currentUrl()) !==
				canonicalNavigationPermissionUrl(observation.url)
		) {
			throw new BrowserElementError();
		}
		return observation;
	}

	/**
	 * Decides what the page itself supports: its own detected reason codes, a
	 * quoted sentence found verbatim in its text, or, once per input revision,
	 * the same two against a fresh observation of the same page.
	 */
	async #verifyProhibitionClaim(
		reasonCode: ProhibitedReasonCode,
		evidence: string | null | undefined,
		observation: BrowserObservation,
	): Promise<ProhibitionVerification> {
		if (observation.prohibitedReasonCodes?.includes(reasonCode)) {
			return "REASON_CODES";
		}
		let evidenceOutcome = checkProhibitionEvidence(
			reasonCode,
			evidence,
			observation.pageText,
		);
		if (evidenceOutcome === "PROHIBITION_EVIDENCE_VERIFIED") {
			logProhibitionEvidence(evidenceOutcome);
			return "PROHIBITION_EVIDENCE_VERIFIED";
		}
		// Whether the handler can read a prohibition depends on the page's own
		// rendering, so one fresh observation is allowed for each input
		// revision. It also gives a truncated page text a second chance to carry
		// the quoted sentence. It replaces the driver's element set, which the
		// PROHIBITION_NOT_VERIFIED guidance already tells the model to re-read.
		if (this.#prohibitionReverifiedRevision === this.#inputRevision) {
			if (evidenceOutcome) logProhibitionEvidence(evidenceOutcome);
			throw evidenceOutcome
				? new ProhibitionEvidenceError(evidenceOutcome)
				: new BrowserElementError();
		}
		this.#prohibitionReverifiedRevision = this.#inputRevision;
		const reobserved = await this.observe();
		// The re-observation must describe the same page, otherwise anything it
		// carries would corroborate a URL that was never checked.
		const samePage =
			canonicalNavigationPermissionUrl(reobserved.url) ===
			canonicalNavigationPermissionUrl(observation.url);
		const verified =
			samePage &&
			reobserved.prohibitedReasonCodes?.includes(reasonCode) === true;
		console.log(JSON.stringify({ event: "prohibition_reverified", verified }));
		if (verified) return "REASON_CODES";
		if (samePage) {
			evidenceOutcome = checkProhibitionEvidence(
				reasonCode,
				evidence,
				reobserved.pageText,
			);
			if (evidenceOutcome === "PROHIBITION_EVIDENCE_VERIFIED") {
				logProhibitionEvidence(evidenceOutcome);
				return "PROHIBITION_EVIDENCE_VERIFIED";
			}
		}
		if (evidenceOutcome) logProhibitionEvidence(evidenceOutcome);
		throw evidenceOutcome
			? new ProhibitionEvidenceError(evidenceOutcome)
			: new BrowserElementError();
	}

	/**
	 * Runs the independent pre-submit review over the latest trusted
	 * observation. It must run before `claimSubmission`, because the reviewer
	 * consumes a provider request that D1 only grants while the job is still
	 * `running`.
	 */
	async reviewSubmit(
		elementId: string,
		screenshot: { contentType: "image/jpeg"; bytes: Uint8Array } | null,
	): Promise<SubmitReviewDecision> {
		const observation = this.#latestObservation;
		if (!observation) {
			throw new BrowserElementError();
		}
		return this.reviewer.review({
			targetDomain: this.#targetDomain,
			targetUrl: this.#targetUrl,
			currentUrl: observation.url,
			formValues: this.#formValues,
			observation,
			submitElementId: elementId,
			screenshot,
		});
	}

	/**
	 * Activates one submit control. The first call runs the pre-submit review
	 * and takes the submission permission; a later call is a further stage of
	 * the same submission -- the confirmation screen of a two-step form -- and
	 * is accepted only while the page still carries the reviewed values.
	 */
	async submit(
		elementId: string,
		activationStrategy: SubmitActivationStrategy = "mouse",
	): Promise<Job | SubmitStagePending> {
		const { stage, firstStage, persisted } =
			await this.#acceptSubmitStage(elementId);
		if (!firstStage) {
			return this.#activateSubmitStage(stage, elementId, activationStrategy);
		}
		await this.#assertSubmitReviewBudgetRemains(persisted);
		await this.#runPreSubmitReview(elementId);
		return this.#activateSubmitStage(stage, elementId, activationStrategy);
	}

	/**
	 * Accepts this call as the next stage of the run's one submission and
	 * returns the job row that permits it.
	 */
	async #acceptSubmitStage(elementId: string): Promise<{
		stage: number;
		firstStage: boolean;
		persisted: Job;
	}> {
		const stage = this.#submitStage + 1;
		// A further stage exists only for a submission still waiting for its own
		// confirmation. Once a result was recorded, the job is finished and a
		// second activation would be a second submission.
		if (stage > MAX_SUBMIT_STAGES || !this.#canActivateFurtherStage()) {
			throw new SubmissionNotAuthorizedError();
		}
		const firstStage = stage === 1;
		await this.validateSubmit(elementId, firstStage);

		// The denial budget is read from D1 before anything else happens, so a
		// failed uncertain write cannot leave a spent job open to another
		// review that happens to allow. A later stage runs while the job is
		// already `submitting`, which is the permission the first stage took.
		const persisted = await this.jobs.find(this.jobId);
		if (
			persisted?.status !== (firstStage ? "running" : "submitting") ||
			persisted.runToken !== this.runToken
		) {
			throw new SubmissionNotAuthorizedError();
		}
		return { stage, firstStage, persisted };
	}

	/** Ends the submission as uncertain when the denial budget is already spent. */
	async #assertSubmitReviewBudgetRemains(persisted: Job): Promise<void> {
		if (persisted.submitReviewDenialCount < MAX_SUBMIT_REVIEW_DENIALS) {
			return;
		}
		await this.#recordUncertain(
			"PRE_SUBMIT_REVIEW_DENIED",
			SUBMIT_REVIEW_BUDGET_EXHAUSTED_REASON,
		);
		throw new SubmissionResultUncertainError();
	}

	/**
	 * Captures the pre-submission evidence, runs the review over it and, once
	 * the reviewed page is proven unchanged, takes the submission permission.
	 * Returns only when the run may activate the control.
	 */
	async #runPreSubmitReview(elementId: string): Promise<void> {
		// Nothing is submitted until the pre-submission evidence exists.
		const before = await this.recorder.capture("before_submit");
		if (!before.captured) {
			throw new SubmissionEvidenceError();
		}

		// Taken before the review so that anything the page adds, removes, or
		// alters while the review runs shows up as a different snapshot.
		const snapshotBefore = await this.driver.readFormSnapshot(elementId);

		const decision = await this.reviewSubmit(elementId, {
			contentType: EVIDENCE_CONTENT_TYPE,
			bytes: before.body,
		});
		if (decision.decision === "deny") {
			await this.#failDeniedReview(decision);
		}

		// The reviewed page is not the page that gets submitted unless nothing
		// moved in between. Untrusted page scripts run during the review.
		await this.#assertReviewedStateUnchanged(elementId, snapshotBefore);

		const authorized = await this.jobs.claimSubmission(
			this.jobId,
			this.runToken,
			this.now(),
		);
		if (
			!authorized ||
			normalizeTargetDomain(authorized.targetDomain) !== this.#targetDomain ||
			!hasSameStringArray(
				normalizeAllowedHosts(authorized.allowedHosts),
				this.#allowedHosts,
			)
		) {
			throw new SubmissionNotAuthorizedError();
		}
	}

	/**
	 * Spends the denial budget for a denied review and ends this submit call,
	 * either as a correctable denial or as an uncertain result.
	 */
	async #failDeniedReview(decision: SubmitReviewDecision): Promise<never> {
		// Only a mismatch between the entered values and the payload is
		// correctable by the agent. Every other denial is a judgement about
		// the page or the form itself, which a retry cannot change.
		const correctable = decision.reasonCode === "INPUT_MISMATCH";
		const denialCount = await this.#spendSubmitReviewDenial(correctable);
		if (correctable && denialCount < MAX_SUBMIT_REVIEW_DENIALS) {
			// Force both a real input change and a fresh observation so the
			// next review sees corrected values instead of the denied ones.
			// The fingerprint makes a re-entry of the same values visible as
			// the non-correction it is.
			this.#deniedFingerprint = observationFingerprint(
				this.#latestObservedForms,
			);
			this.#correctionInputApplied = false;
			this.#inputRevision += 1;
			throw new SubmitReviewDeniedError(decision.reasonCode);
		}
		await this.#recordUncertain(
			"PRE_SUBMIT_REVIEW_DENIED",
			submitReviewDeniedReason(decision, denialCount),
		);
		throw new SubmissionResultUncertainError();
	}

	/**
	 * Activates the control and turns what the browser reports into a result.
	 * The first stage arrives here with the submission permission already
	 * taken; a later stage first has to prove the page still shows the
	 * reviewed values, and is recorded as a `submit.stage` event instead.
	 */
	async #activateSubmitStage(
		stage: number,
		elementId: string,
		activationStrategy: SubmitActivationStrategy,
	): Promise<Job | SubmitStagePending> {
		const activation = await this.#activateSubmitControl(
			stage,
			elementId,
			activationStrategy,
		);
		const result = await this.#validatePostSubmitUrl(activation);
		const pending = await this.#offerFurtherStage(stage, result);
		if (pending) return pending;
		return await this.#persistSubmitResult(result);
	}

	/**
	 * Presses the control and captures whatever the driver throws, so a failed
	 * activation becomes a recorded result instead of an escaping error. A
	 * stage past the first has to prove the page still shows the reviewed
	 * values first, and is written as a `submit.stage` event of its own.
	 */
	async #activateSubmitControl(
		stage: number,
		elementId: string,
		activationStrategy: SubmitActivationStrategy,
	): Promise<SubmitActivationOutcome> {
		const firstStage = stage === 1;
		if (!firstStage) {
			await this.#assertSubmitStageValues();
			// Every stage sends something, so every stage is preceded by its own
			// evidence of what the page held.
			const before = await this.recorder.capture("before_submit");
			if (!before.captured) {
				throw new SubmissionEvidenceError();
			}
		}
		this.#submitStage = stage;
		// Set before the activation, and never reset by this method: from here on
		// a submit control was pressed and no result has been recorded for it, so
		// the run reports an unconfirmed submission even if the driver throws.
		this.#unconfirmedSubmission = true;

		let result: BrowserSubmitResult | undefined;
		let submitError: unknown;
		try {
			result = await this.driver.submit(
				elementId,
				activationStrategy,
				firstStage,
			);
		} catch (error) {
			submitError = error;
		}
		// Whatever the page shows now was never observed, so a further stage
		// cannot run until the model has taken a fresh observation.
		this.#inputRevision += 1;
		if (!firstStage) {
			await this.#recordSubmitStage(
				stage,
				result !== undefined && submitRequestObserved(result),
			);
		}
		return { result, submitError };
	}

	/**
	 * Reads the page the activation left behind and captures the post-submit
	 * evidence. An activation that failed, or that landed outside the allowed
	 * domain, ends here as a recorded uncertain result; otherwise the browser's
	 * own result is handed on.
	 */
	async #validatePostSubmitUrl({
		result,
		submitError,
	}: SubmitActivationOutcome): Promise<BrowserSubmitResult> {
		// The post-submit URL is read before the screenshot capture. If the
		// screenshot fails and closes the CDP connection, the already-captured
		// URL still lets us validate a successful submission instead of
		// letting a best-effort capture failure change the submission result.
		let postSubmitUrl: string | undefined;
		let postSubmitUrlError: unknown;
		if (submitError === undefined && result) {
			try {
				postSubmitUrl = await this.driver.currentUrl();
			} catch (error) {
				postSubmitUrlError = error;
			}
		}
		// The post-submission evidence is best effort and never changes the result.
		await this.recorder.capture("after_submit");
		if (submitError !== undefined || !result) {
			const diagnostic =
				submitError instanceof BrowserSubmitDiagnosticError
					? submitError
					: createBrowserSubmitDiagnosticError("SUBMIT_OPERATION", submitError);
			await this.#recordUncertain(
				"SUBMIT_RESULT_UNKNOWN",
				submitFailureReason(diagnostic),
			);
			throw new SubmissionResultUncertainError();
		}
		try {
			if (postSubmitUrlError !== undefined) {
				throw postSubmitUrlError;
			}
			this.#assertAllowedUrl(postSubmitUrl as string);
		} catch (error) {
			await this.#recordUncertain(
				"SUBMIT_RESULT_UNKNOWN",
				submitFailureReason(
					createBrowserSubmitDiagnosticError("POST_SUBMIT_URL_CHECK", error),
				),
			);
			throw new SubmissionResultUncertainError();
		}
		return result;
	}

	/**
	 * Decides whether this activation may be followed by another stage instead
	 * of being recorded as a result. Returns undefined when it may not, and the
	 * caller records the browser's result as it stands.
	 */
	async #offerFurtherStage(
		stage: number,
		result: BrowserSubmitResult,
	): Promise<SubmitStagePending | undefined> {
		if (
			result.outcome !== "uncertain" ||
			result.reasonCode !== SUBMIT_CONFIRMATION_NOT_OBSERVED ||
			stage >= MAX_SUBMIT_STAGES
		) {
			return undefined;
		}
		// The activation reached the page and a submission request went out,
		// but nothing confirmed a completed send. A two-step form answers
		// exactly like this, and its confirmation screen repeats the entered
		// email and the start of the entered body, so the next stage is
		// offered only when the page right after the activation still shows
		// them. Nothing is recorded yet and the job stays `submitting`.
		// A page that no longer shows them is either a form the site reset
		// after the POST or the page that follows the final stage; offering
		// another stage there only spends model turns on observations of a
		// page that can never confirm anything, so the submission ends as
		// uncertain right away.
		const shown = await this.#pageStillShowsReviewedValues();
		console.log(
			JSON.stringify({
				event: "browser_submit_stage_check",
				stage,
				reviewedValuesShown: shown,
			}),
		);
		if (shown) return { pendingStage: stage };
		// Otherwise the caller records it as uncertain
		// SUBMIT_CONFIRMATION_NOT_OBSERVED.
		return undefined;
	}

	/** Writes the browser's result to D1 and returns the job it produced. */
	async #persistSubmitResult(result: BrowserSubmitResult): Promise<Job> {
		if (result.outcome === "uncertain") {
			// Reset before the write: this activation's result is the uncertain one
			// being recorded now, so nothing is left waiting for a confirmation.
			this.#unconfirmedSubmission = false;
			const uncertain = await this.jobs.recordUncertain(
				this.jobId,
				this.runToken,
				result.reasonCode,
				result.reason,
				this.now(),
			);
			if (!uncertain) {
				throw new SubmissionResultUncertainError();
			}
			return uncertain;
		}

		try {
			this.#assertAllowedUrl(result.formUrl);
		} catch {
			await this.#recordUncertain(
				"SUBMIT_TARGET_INVALID",
				"The browser reported a submission target outside the allowed domain.",
			);
			throw new SubmissionResultUncertainError();
		}

		try {
			// Reset before the write: this activation's result is the sent one being
			// recorded now. A failed write falls through to `#recordUncertain`,
			// which resets it again for the uncertain result recorded instead.
			this.#unconfirmedSubmission = false;
			const sent = await this.jobs.recordSent(
				this.jobId,
				this.runToken,
				result.formUrl,
				this.now(),
			);
			if (!sent) {
				throw new Error("Sent result was not persisted");
			}
			return sent;
		} catch {
			await this.#recordUncertain(
				"RESULT_PERSIST_FAILED",
				"The form appeared sent, but the result could not be persisted.",
			);
			throw new SubmissionResultUncertainError();
		}
	}

	/**
	 * Records this denial in D1 and returns its ordinal. A denial that offers
	 * no correction consumes the whole remaining budget, so a failed uncertain
	 * write cannot leave the job open to a later review that allows.
	 */
	async #spendSubmitReviewDenial(correctable: boolean): Promise<number> {
		const denialCount = await this.jobs.recordSubmitReviewDenial(
			this.jobId,
			this.runToken,
			this.now(),
		);
		if (denialCount === null) {
			throw new SubmissionNotAuthorizedError();
		}
		if (correctable && denialCount < MAX_SUBMIT_REVIEW_DENIALS) {
			return denialCount;
		}
		for (
			let spent = denialCount;
			spent < MAX_SUBMIT_REVIEW_DENIALS;
			spent += 1
		) {
			if (
				(await this.jobs.recordSubmitReviewDenial(
					this.jobId,
					this.runToken,
					this.now(),
				)) === null
			) {
				throw new SubmissionNotAuthorizedError();
			}
		}
		return denialCount;
	}

	/** Whether an activation is still waiting for a result of its own. */
	hasUnconfirmedSubmission(): boolean {
		return this.#unconfirmedSubmission;
	}

	/**
	 * Whether `#latestObservation` still describes the page as it stands now.
	 *
	 * The invariant it names: after anything that can change the page, the model
	 * has to observe again before the handler acts on an observation. Every such
	 * operation -- `navigate`, `click`, `fill`, `select`, a submit activation, a
	 * denied review, a detected form-state change -- increments
	 * `#inputRevision` and owns that side of the invariant; only `observe`
	 * copies the current revision into `#observationRevision`. A caller that
	 * changes the page without bumping `#inputRevision` would leave a stale
	 * observation looking fresh, so the bump belongs with the change itself, not
	 * with the reader.
	 */
	#observationIsFresh(): boolean {
		return this.#observationRevision === this.#inputRevision;
	}

	#canActivateFurtherStage(): boolean {
		return this.#submitStage === 0 || this.#unconfirmedSubmission;
	}

	/**
	 * A later stage is only allowed on a page that still carries what the
	 * review approved: a confirmation screen repeating the entered address and
	 * the start of the entered message, or the same fields still holding them.
	 * Without that check a second activation could press any control on
	 * whatever page the site navigated to.
	 */
	async #assertSubmitStageValues(): Promise<void> {
		const observation = this.#latestObservation;
		if (
			!observation ||
			!(await this.#pageShowsReviewedValues(observation.pageText ?? ""))
		) {
			throw new SubmitStageUnverifiedError();
		}
	}

	/** The email and body-prefix this run entered, or undefined when either is unknown. */
	#reviewedValueProbe(): { email: string; bodyPrefix: string } | undefined {
		const email = this.#enteredValues
			.find((value) => ENTERED_EMAIL_PATTERN.test(value.trim()))
			?.trim();
		const body = this.#enteredValues.reduce(
			(longest, value) => (value.length > longest.length ? value : longest),
			"",
		);
		if (!email || !body) return undefined;
		return {
			email,
			bodyPrefix: body.slice(0, SUBMIT_STAGE_BODY_PREFIX_LENGTH),
		};
	}

	/** True when the page text, or failing that the observed fields, still hold both reviewed values. */
	async #pageShowsReviewedValues(pageText: string): Promise<boolean> {
		const probe = this.#reviewedValueProbe();
		if (!probe) return false;
		if (pageText.includes(probe.email) && pageText.includes(probe.bodyPrefix)) {
			return true;
		}
		let values: string[];
		try {
			values = (await this.driver.readObservedFieldStates()).map(
				(state) => state.value,
			);
		} catch {
			return false;
		}
		return (
			values.some((value) => value.includes(probe.email)) &&
			values.some((value) => value.includes(probe.bodyPrefix))
		);
	}

	/**
	 * Same check against the page as it stands now, not against the latest
	 * observation, so it can be applied right after an activation changed it.
	 */
	async #pageStillShowsReviewedValues(): Promise<boolean> {
		let pageText = "";
		try {
			pageText = (await this.driver.readPageText?.()) ?? "";
		} catch {
			pageText = "";
		}
		return await this.#pageShowsReviewedValues(pageText);
	}

	/**
	 * Records a stage past the first. The submission permission was already
	 * taken by the first stage, so only fixed values are written: which stage
	 * this was and whether a request left the page.
	 */
	async #recordSubmitStage(
		stage: number,
		requestObserved: boolean,
	): Promise<void> {
		try {
			await this.jobs.recordSubmitStage(
				this.jobId,
				this.runToken,
				stage,
				requestObserved,
				this.now(),
			);
		} catch {
			// The event is a record of what happened, never a gate on it.
		}
	}

	/** True once an input changed the values a denied review looked at. */
	#hasCorrectedInputs(): boolean {
		const observation = this.#latestObservation;
		if (!observation || !this.#correctionInputApplied) return false;
		return (
			observationFingerprint(this.#latestObservedForms) !==
			this.#deniedFingerprint
		);
	}

	async #assertCurrentUrlAllowed(): Promise<void> {
		this.#assertAllowedUrl(await this.driver.currentUrl());
	}

	/**
	 * Confirms that the page still matches the observation the reviewer saw.
	 * A mismatch forces a fresh observation instead of submitting content that
	 * was never reviewed.
	 */
	async #assertReviewedStateUnchanged(
		elementId: string,
		snapshotBefore: string,
	): Promise<void> {
		const observation = this.#latestObservation;
		if (!observation) throw new FormStateChangedError();
		let unchanged: boolean;
		try {
			const currentUrl = await this.driver.currentUrl();
			this.#assertAllowedUrl(currentUrl);
			// The observed-field read-back ties the reviewed observation to the
			// live values; the form snapshot covers everything the observation
			// never showed, including hidden and disabled controls.
			const states = await this.driver.readObservedFieldStates();
			const snapshotAfter = await this.driver.readFormSnapshot(elementId);
			unchanged =
				canonicalNavigationPermissionUrl(currentUrl) ===
					canonicalNavigationPermissionUrl(observation.url) &&
				hasSameObservedFieldStates(this.#latestObservedForms, states) &&
				snapshotAfter === snapshotBefore;
		} catch (error) {
			if (error instanceof NavigationPolicyError) throw error;
			unchanged = false;
		}
		if (!unchanged) {
			this.#inputRevision += 1;
			throw new FormStateChangedError();
		}
	}

	#assertAllowedUrl(rawUrl: string): void {
		assertAllowedTargetUrl(rawUrl, this.#targetDomain, this.#allowedHosts);
	}

	async #recordUncertain(reasonCode: string, reason: string): Promise<void> {
		this.#unconfirmedSubmission = false;
		try {
			await this.jobs.recordUncertain(
				this.jobId,
				this.runToken,
				reasonCode,
				reason,
				this.now(),
			);
		} catch {
			// The caller still receives an uncertain result and must never retry submit.
		}
	}
}

/**
 * Strips the prohibition text a page carried and replaces it with the reason
 * codes it implies, so the model is never shown text it could be steered by.
 * It stays a raw-to-raw transform: its result is both what `observe` returns
 * and what `parseObservedForms` then types, and everything a form reported
 * beyond these three properties has to survive it untouched.
 */
function trustObservedForms(forms: unknown[]): unknown[] {
	return forms.map((form) => {
		if (!isRecord(form)) return form;
		const {
			prohibitionText,
			prohibitionTexts,
			prohibitedReasonCodes,
			...visibleForm
		} = form;
		const texts = Array.isArray(prohibitionTexts)
			? prohibitionTexts.filter(
					(value): value is string => typeof value === "string",
				)
			: typeof prohibitionText === "string"
				? [prohibitionText]
				: null;
		if (!texts) {
			return {
				...visibleForm,
				...(Array.isArray(prohibitedReasonCodes)
					? {
							prohibitedReasonCodes: prohibitedReasonCodes.filter(
								isProhibitedReasonCode,
							),
						}
					: {}),
			};
		}
		const codes: ProhibitedReasonCode[] = [];
		const detectionTexts = [...texts];
		for (let index = 1; index < texts.length; index += 1) {
			const previous = texts[index - 1];
			const current = texts[index];
			if (previous !== undefined && current !== undefined) {
				detectionTexts.push(`${previous.slice(-128)} ${current.slice(0, 128)}`);
			}
		}
		for (const text of detectionTexts) {
			for (const code of detectProhibitedTextReasonCodes(text)) {
				if (!codes.includes(code)) codes.push(code);
			}
		}
		return {
			...visibleForm,
			prohibitedReasonCodes: codes,
		};
	});
}

function prohibitedReasonCodesForElement(
	forms: readonly ObservedForm[],
	elementId: string,
): ProhibitedReasonCode[] {
	for (const form of forms) {
		const ownsElement = (form.fields ?? []).some(
			(field) => field.elementId === elementId,
		);
		if (ownsElement) return readProhibitedReasonCodes(form);
	}
	throw new BrowserElementError();
}

function canonicalNavigationUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.hash = "";
	return url.toString();
}

function canonicalNavigationPermissionUrl(rawUrl: string): string {
	return new URL(rawUrl).toString();
}

/**
 * The reviewer's free-form reason is the only untrusted text this module
 * persists. It is reachable through `GET /jobs/:id`, so control characters and
 * line breaks are flattened and the text is truncated before storage. The model
 * never sees it; only the fixed reason code is returned to the agent.
 */
function submitReviewDeniedReason(
	decision: SubmitReviewDecision,
	denialCount: number,
): string {
	const reason = decision.reason
		.replace(CONTROL_CHARACTER_PATTERN, " ")
		.slice(0, MAX_SUBMIT_REVIEW_REASON_LENGTH);
	return `Pre-submit review denied the submission (reasonCode: ${decision.reasonCode}, denials: ${denialCount}). ${reason}`;
}

/**
 * Compares the observation the reviewer saw with the live element states.
 * Element sets must match exactly; values always, and checked state only where
 * the observation reported one.
 */
function hasSameObservedFieldStates(
	forms: readonly ObservedForm[],
	states: readonly ObservedFieldState[],
): boolean {
	const observed = new Map<string, ObservedField>();
	for (const form of forms) {
		for (const field of form.fields ?? []) {
			if (field.elementId === undefined) continue;
			if (!isReviewComparableField(field.tag, field.type)) continue;
			observed.set(field.elementId, field);
		}
	}
	if (states.length !== observed.size) return false;
	for (const state of states) {
		const field = observed.get(state.elementId);
		if (!field) return false;
		if (field.value !== undefined && field.value !== state.value) return false;
		if (field.checked !== undefined && field.checked !== state.checked) {
			return false;
		}
	}
	return true;
}

function submitFailureReason(error: BrowserSubmitDiagnosticError): string {
	return `The browser operation failed after submission permission was granted. Diagnostic: ${error.stage}/${error.diagnosticCode}.`;
}

function classifyBrowserFailure(error: unknown): BrowserSubmitFailureCode {
	if (error instanceof BrowserElementError) return "ELEMENT_UNAVAILABLE";
	if (error instanceof NavigationPolicyError) return "NAVIGATION_POLICY";
	if (!(error instanceof Error)) return "UNKNOWN";
	if (error.name === "BrowserUseCdpPayloadTooLargeError") {
		return "CDP_PAYLOAD_TOO_LARGE";
	}
	switch (error.message) {
		case BROWSER_ERROR.CDP_CONNECTION_IS_CLOSED:
		case BROWSER_ERROR.CDP_CONNECTION_CLOSED:
			return "CDP_CONNECTION_CLOSED";
		case BROWSER_ERROR.CDP_COMMAND_TIMED_OUT:
			return "CDP_COMMAND_TIMEOUT";
		case BROWSER_ERROR.CDP_COMMAND_NOT_SENT:
			return "CDP_COMMAND_SEND_FAILED";
		case BROWSER_ERROR.CDP_COMMAND_FAILED:
			return "CDP_COMMAND_FAILED";
		case BROWSER_ERROR.PAGE_EVALUATION_FAILED:
			return "PAGE_EVALUATION_FAILED";
		default:
			return "UNKNOWN";
	}
}

export function assertAllowedTargetUrl(
	rawUrl: string,
	targetDomain: string,
	allowedHosts: readonly string[] = [],
): void {
	const normalizedTargetDomain = normalizeTargetDomain(targetDomain);
	const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new NavigationPolicyError();
	}

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	const allowedHost =
		hostname === normalizedTargetDomain ||
		hostname.endsWith(`.${normalizedTargetDomain}`) ||
		normalizedAllowedHosts.includes(hostname);
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		!allowedHost
	) {
		throw new NavigationPolicyError();
	}
}

export function normalizeAllowedHosts(values: readonly string[]): string[] {
	if (!Array.isArray(values) || values.length > 8) {
		throw new NavigationPolicyError();
	}

	const normalized = values.map(normalizeAllowedHost);
	return [...new Set(normalized)].sort();
}

function normalizeAllowedHost(value: string): string {
	if (typeof value !== "string" || value.length > 253) {
		throw new NavigationPolicyError();
	}
	const normalized = value.toLowerCase().replace(/\.$/, "");
	const parsed = parse(normalized, {
		allowPrivateDomains: true,
		detectSpecialUse: true,
		extractHostname: false,
	});
	if (
		!normalized ||
		normalized.includes(":") ||
		normalized.includes("/") ||
		parsed.hostname !== normalized ||
		parsed.isIp ||
		parsed.isSpecialUse ||
		(!parsed.isIcann && !parsed.isPrivate)
	) {
		throw new NavigationPolicyError();
	}
	return normalized;
}

export function normalizeTargetDomain(value: string): string {
	const normalized = value.toLowerCase().replace(/\.$/, "");
	const parsed = parse(normalized, {
		allowPrivateDomains: true,
		detectSpecialUse: true,
		extractHostname: false,
	});
	if (
		!normalized ||
		normalized.includes(":") ||
		normalized.includes("/") ||
		parsed.domain !== normalized ||
		parsed.isIp ||
		parsed.isSpecialUse ||
		(!parsed.isIcann && !parsed.isPrivate)
	) {
		throw new NavigationPolicyError();
	}
	return normalized;
}

function hasSameStringArray(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}
