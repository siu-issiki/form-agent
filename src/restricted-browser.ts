import { parse } from "tldts";
import type { Job, JobStore } from "./job";

export interface BrowserObservation {
	url: string;
	forms: unknown[];
	pageText?: string;
}

export type BrowserSubmitResult =
	| { outcome: "sent"; formUrl: string }
	| {
			outcome: "uncertain";
			reasonCode: string;
			reason: string;
	  };

export type SubmitActivationStrategy = "mouse" | "enter";

export interface RestrictedBrowserDriver {
	close?(): Promise<void>;
	restrictToDomain(targetDomain: string): Promise<void>;
	currentUrl(): Promise<string>;
	navigate(url: string): Promise<void>;
	observe(): Promise<BrowserObservation>;
	clickNonSubmit(elementId: string): Promise<void>;
	fill(elementId: string, value: string): Promise<void>;
	select(elementId: string, value: string): Promise<void>;
	validateSubmit(elementId: string): Promise<void>;
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

export class SubmissionNotAuthorizedError extends Error {
	constructor() {
		super("The job did not grant submission permission");
		this.name = "SubmissionNotAuthorizedError";
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
	readonly #successfulInputElementIds = new Set<string>();
	#submitAttempted = false;

	private constructor(
		private readonly driver: RestrictedBrowserDriver,
		private readonly jobs: JobStore,
		private readonly jobId: string,
		private readonly runToken: string,
		targetDomain: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.#targetDomain = normalizeTargetDomain(targetDomain);
	}

	static async create(
		driver: RestrictedBrowserDriver,
		jobs: JobStore,
		jobId: string,
		runToken: string,
		now: () => string = () => new Date().toISOString(),
	): Promise<RestrictedBrowserTools> {
		const job = await jobs.find(jobId);
		if (job?.status !== "running" || job.runToken !== runToken) {
			throw new SubmissionNotAuthorizedError();
		}

		const targetDomain = normalizeTargetDomain(job.targetDomain);
		assertTargetUrlMatchesDomain(job.targetUrl, targetDomain);
		await driver.restrictToDomain(targetDomain);
		return new RestrictedBrowserTools(
			driver,
			jobs,
			jobId,
			runToken,
			targetDomain,
			now,
		);
	}

	async navigate(url: string): Promise<void> {
		this.#assertAllowedUrl(url);
		await this.driver.navigate(url);
		await this.#assertCurrentUrlAllowed();
		this.#successfulInputElementIds.clear();
	}

	async observe(): Promise<BrowserObservation> {
		await this.#assertCurrentUrlAllowed();
		const observation = await this.driver.observe();
		this.#assertAllowedUrl(observation.url);
		return observation;
	}

	async click(elementId: string): Promise<void> {
		await this.driver.clickNonSubmit(elementId);
		await this.#assertCurrentUrlAllowed();
	}

	async fill(elementId: string, value: string): Promise<void> {
		await this.driver.fill(elementId, value);
		await this.#assertCurrentUrlAllowed();
		this.#successfulInputElementIds.add(elementId);
	}

	async select(elementId: string, value: string): Promise<void> {
		await this.driver.select(elementId, value);
		await this.#assertCurrentUrlAllowed();
		this.#successfulInputElementIds.add(elementId);
	}

	async validateSubmit(elementId: string): Promise<void> {
		if (this.#successfulInputElementIds.size < 1) {
			throw new BrowserElementError();
		}
		await this.#assertCurrentUrlAllowed();
		await this.driver.validateSubmit(elementId);
		await this.#assertCurrentUrlAllowed();
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

		const authorized = await this.jobs.claimSubmission(
			this.jobId,
			this.runToken,
			this.now(),
		);
		if (
			!authorized ||
			normalizeTargetDomain(authorized.targetDomain) !== this.#targetDomain
		) {
			throw new SubmissionNotAuthorizedError();
		}

		let result: BrowserSubmitResult;
		try {
			result = await this.driver.submit(elementId, activationStrategy);
		} catch (error) {
			const diagnostic =
				error instanceof BrowserSubmitDiagnosticError
					? error
					: createBrowserSubmitDiagnosticError("SUBMIT_OPERATION", error);
			await this.#recordUncertain(
				"SUBMIT_RESULT_UNKNOWN",
				submitFailureReason(diagnostic),
			);
			throw new SubmissionResultUncertainError();
		}
		try {
			await this.#assertCurrentUrlAllowed();
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
		assertAllowedTargetUrl(rawUrl, this.#targetDomain);
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
): void {
	const normalizedTargetDomain = normalizeTargetDomain(targetDomain);
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new NavigationPolicyError();
	}

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	const allowedHost =
		hostname === normalizedTargetDomain ||
		hostname.endsWith(`.${normalizedTargetDomain}`);
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		!allowedHost
	) {
		throw new NavigationPolicyError();
	}
}

function normalizeTargetDomain(value: string): string {
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

function assertTargetUrlMatchesDomain(
	targetUrl: string,
	targetDomain: string,
): void {
	let url: URL;
	try {
		url = new URL(targetUrl);
	} catch {
		throw new NavigationPolicyError();
	}

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		(hostname !== targetDomain && !hostname.endsWith(`.${targetDomain}`))
	) {
		throw new NavigationPolicyError();
	}
}
