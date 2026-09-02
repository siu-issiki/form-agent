import { parse } from "tldts";
import type { Job, JobStore } from "./job";
import {
	type EvidenceCaptureResult,
	type EvidenceObjectStore,
	SubmissionEvidenceRecorder,
} from "./submission-evidence";

export interface BrowserObservation {
	url: string;
	forms: unknown[];
	pageText?: string;
	navigationLinks?: Array<{ url: string; text: string }>;
	prohibitedReasonCodes?: ProhibitedReasonCode[];
}

export type ProhibitedReasonCode =
	| "NO_FORM_PRESENT"
	| "SALES_PROHIBITED"
	| "FORM_PURPOSE_INCOMPATIBLE";

export type BrowserSubmitResult =
	| { outcome: "sent"; formUrl: string }
	| {
			outcome: "uncertain";
			reasonCode: string;
			reason: string;
	  };

export type SubmitActivationStrategy = "dom" | "mouse" | "enter";

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
	select(elementId: string, value: string): Promise<void>;
	validateSubmit(elementId: string): Promise<void>;
	captureScreenshot(): Promise<Uint8Array>;
	submit(
		elementId: string,
		activationStrategy: SubmitActivationStrategy,
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

export class RestrictedBrowserTools {
	readonly #targetDomain: string;
	readonly #allowedHosts: string[];
	readonly #successfulInputElementIds = new Set<string>();
	readonly #allowedNavigationUrls = new Set<string>();
	#latestObservation: BrowserObservation | undefined;
	#inputRevision = 0;
	#observationRevision = -1;
	#submitAttempted = false;

	private constructor(
		private readonly driver: RestrictedBrowserDriver,
		private readonly jobs: JobStore,
		private readonly jobId: string,
		private readonly runToken: string,
		private readonly recorder: SubmissionEvidenceRecorder,
		targetDomain: string,
		allowedHosts: readonly string[],
		targetUrl: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.#targetDomain = normalizeTargetDomain(targetDomain);
		this.#allowedHosts = normalizeAllowedHosts(allowedHosts);
		this.#allowedNavigationUrls.add(canonicalNavigationUrl(targetUrl));
	}

	static async create(
		driver: RestrictedBrowserDriver,
		jobs: JobStore,
		jobId: string,
		runToken: string,
		evidenceStore: EvidenceObjectStore,
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
			targetDomain,
			allowedHosts,
			job.targetUrl,
			now,
		);
	}

	captureEvidence(stage: "prohibited"): Promise<EvidenceCaptureResult> {
		return this.recorder.capture(stage);
	}

	async navigate(url: string): Promise<void> {
		this.#assertAllowedUrl(url);
		if (!this.#allowedNavigationUrls.has(canonicalNavigationUrl(url))) {
			throw new NavigationPolicyError();
		}
		await this.driver.navigate(url);
		await this.#assertCurrentUrlAllowed();
		this.#successfulInputElementIds.clear();
		this.#latestObservation = undefined;
		this.#allowedNavigationUrls.clear();
		this.#inputRevision += 1;
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
		const trustedObservation: BrowserObservation = {
			...observation,
			...(navigationLinks ? { navigationLinks } : {}),
			prohibitedReasonCodes: detectProhibitedReasonCodes(observation),
		};
		this.#latestObservation = trustedObservation;
		this.#observationRevision = this.#inputRevision;
		this.#allowedNavigationUrls.clear();
		this.#allowedNavigationUrls.add(
			canonicalNavigationUrl(trustedObservation.url),
		);
		for (const link of trustedObservation.navigationLinks ?? []) {
			this.#allowedNavigationUrls.add(canonicalNavigationUrl(link.url));
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
		this.#successfulInputElementIds.add(elementId);
		this.#inputRevision += 1;
	}

	async select(elementId: string, value: string): Promise<void> {
		await this.driver.select(elementId, value);
		await this.#assertCurrentUrlAllowed();
		this.#successfulInputElementIds.add(elementId);
		this.#inputRevision += 1;
	}

	async validateSubmit(elementId: string): Promise<void> {
		if (this.#successfulInputElementIds.size < 1) {
			throw new BrowserElementError();
		}
		if (this.#observationRevision !== this.#inputRevision) {
			throw new BrowserElementError();
		}
		if ((this.#latestObservation?.prohibitedReasonCodes?.length ?? 0) > 0) {
			throw new BrowserElementError();
		}
		await this.#assertCurrentUrlAllowed();
		await this.driver.validateSubmit(elementId);
		await this.#assertCurrentUrlAllowed();
	}

	validateProhibited(reasonCode: ProhibitedReasonCode, formUrl: string | null) {
		const observation = this.#latestObservation;
		if (
			!observation?.prohibitedReasonCodes?.includes(reasonCode) ||
			(formUrl !== null &&
				canonicalNavigationUrl(formUrl) !==
					canonicalNavigationUrl(observation.url))
		) {
			throw new BrowserElementError();
		}
	}

	async submit(
		elementId: string,
		activationStrategy: SubmitActivationStrategy = "mouse",
	): Promise<Job> {
		if (this.#submitAttempted) {
			throw new SubmissionNotAuthorizedError();
		}
		await this.validateSubmit(elementId);
		this.#submitAttempted = true;

		// Nothing is submitted until the pre-submission evidence exists.
		const before = await this.recorder.capture("before_submit");
		if (!before.captured) {
			throw new SubmissionEvidenceError();
		}

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

		let result: BrowserSubmitResult | undefined;
		let submitError: unknown;
		try {
			result = await this.driver.submit(elementId, activationStrategy);
		} catch (error) {
			submitError = error;
		}
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

		if (result.outcome === "uncertain") {
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

	async #assertCurrentUrlAllowed(): Promise<void> {
		this.#assertAllowedUrl(await this.driver.currentUrl());
	}

	#assertAllowedUrl(rawUrl: string): void {
		assertAllowedTargetUrl(rawUrl, this.#targetDomain, this.#allowedHosts);
	}

	async #recordUncertain(reasonCode: string, reason: string): Promise<void> {
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

export function detectProhibitedReasonCodes(
	observation: Pick<BrowserObservation, "forms" | "pageText">,
): ProhibitedReasonCode[] {
	const codes: ProhibitedReasonCode[] = [];
	if (observation.forms.length === 0) codes.push("NO_FORM_PRESENT");
	const text = (observation.pageText ?? "").replace(/\s+/g, " ").toLowerCase();
	if (
		/(営業|勧誘|セールス).{0,40}(禁止|お断り|受け付け|ご遠慮)/.test(text) ||
		/(禁止|お断り|受け付け|ご遠慮).{0,40}(営業|勧誘|セールス)/.test(text) ||
		/(sales|solicitation).{0,40}(prohibited|not accepted|do not use)/.test(text)
	) {
		codes.push("SALES_PROHIBITED");
	}
	if (
		/(採用|サポート|報道|サンプル|資料請求).{0,30}(専用|のみ)/.test(text) ||
		/(専用|のみ).{0,30}(採用|サポート|報道|サンプル|資料請求)/.test(text)
	) {
		codes.push("FORM_PURPOSE_INCOMPATIBLE");
	}
	return codes;
}

function canonicalNavigationUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.hash = "";
	return url.toString();
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
		case "Browser Use CDP connection is closed":
		case "Browser Use CDP connection closed":
			return "CDP_CONNECTION_CLOSED";
		case "Browser Use CDP command timed out":
			return "CDP_COMMAND_TIMEOUT";
		case "Browser Use CDP command could not be sent":
			return "CDP_COMMAND_SEND_FAILED";
		case "Browser Use CDP command failed":
			return "CDP_COMMAND_FAILED";
		case "Browser page evaluation failed":
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
