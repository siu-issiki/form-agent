import type { Job, JobStore } from "./job";

export interface BrowserObservation {
	url: string;
	forms: unknown[];
}

export type BrowserSubmitResult =
	| { outcome: "sent"; formUrl: string }
	| {
			outcome: "uncertain";
			reasonCode: string;
			reason: string;
	  };

export interface RestrictedBrowserDriver {
	currentUrl(): Promise<string>;
	navigate(url: string): Promise<void>;
	observe(): Promise<BrowserObservation>;
	clickNonSubmit(elementId: string): Promise<void>;
	fill(elementId: string, value: string): Promise<void>;
	select(elementId: string, value: string): Promise<void>;
	submit(): Promise<BrowserSubmitResult>;
}

export class NavigationPolicyError extends Error {
	constructor() {
		super("Browser navigation is outside the allowed target domain");
		this.name = "NavigationPolicyError";
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

export class RestrictedBrowserTools {
	readonly #targetDomain: string;
	#submitAttempted = false;

	constructor(
		private readonly driver: RestrictedBrowserDriver,
		private readonly jobs: JobStore,
		private readonly jobId: string,
		private readonly runToken: string,
		targetDomain: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.#targetDomain = normalizeTargetDomain(targetDomain);
	}

	async navigate(url: string): Promise<void> {
		this.#assertAllowedUrl(url);
		await this.driver.navigate(url);
		await this.#assertCurrentUrlAllowed();
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
	}

	async select(elementId: string, value: string): Promise<void> {
		await this.driver.select(elementId, value);
		await this.#assertCurrentUrlAllowed();
	}

	async submit(): Promise<Job> {
		if (this.#submitAttempted) {
			throw new SubmissionNotAuthorizedError();
		}
		this.#submitAttempted = true;
		await this.#assertCurrentUrlAllowed();

		const authorized = await this.jobs.claimSubmission(
			this.jobId,
			this.runToken,
			this.now(),
		);
		if (!authorized) {
			throw new SubmissionNotAuthorizedError();
		}

		let result: BrowserSubmitResult;
		try {
			result = await this.driver.submit();
			await this.#assertCurrentUrlAllowed();
		} catch {
			await this.#recordUncertain(
				"SUBMIT_RESULT_UNKNOWN",
				"The browser operation failed after submission permission was granted.",
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
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new NavigationPolicyError();
		}

		const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
		const allowedHost =
			hostname === this.#targetDomain ||
			hostname.endsWith(`.${this.#targetDomain}`);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			!allowedHost
		) {
			throw new NavigationPolicyError();
		}
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

function normalizeTargetDomain(value: string): string {
	const normalized = value.toLowerCase().replace(/\.$/, "");
	if (!normalized || normalized.includes(":") || normalized.includes("/")) {
		throw new NavigationPolicyError();
	}
	return normalized;
}
