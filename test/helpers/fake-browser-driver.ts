import {
	BrowserElementError,
	type BrowserObservation,
	type BrowserSubmitResult,
	type ObservedFieldState,
	type RestrictedBrowserDriver,
	type SubmitActivationStrategy,
} from "../../src/restricted-browser";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export interface FakeBrowserDriverOptions {
	url: string;
	forms: unknown[];
	fieldStates: ObservedFieldState[];
}

/**
 * The single fake driver both the bun and the workers test suites drive. It is
 * deliberately free of any test-runner import so the same file can be loaded
 * under `bun:test` and under `vitest`.
 */
export class FakeBrowserDriver implements RestrictedBrowserDriver {
	url: string;
	restrictedDomain: string | undefined;
	redirectTo: string | null = null;
	closed = false;
	observed = false;
	requireObservationForSubmit = false;
	validateSubmitCount = 0;
	submitCount = 0;
	submitActivationStrategies: SubmitActivationStrategy[] = [];
	submitError: Error | null = null;
	validateSubmitError: Error | null = null;
	screenshotCount = 0;
	screenshotError: Error | null = null;
	failScreenshotAt: number | null = null;
	closeConnectionOnScreenshotFailure = false;
	connectionClosed = false;
	navigationCount = 0;
	navigationLinks: Array<{ url: string; text: string }> | undefined;
	observeCount = 0;
	clickCount = 0;
	/** Thrown by the first click only, so a retry can succeed. */
	firstClickError: Error | null = null;
	filledValues: string[] = [];
	observationForms: unknown[];
	/** Replayed per observe call when set; the last entry repeats. */
	observationFormsSequence: unknown[][] | null = null;
	fieldStates: ObservedFieldState[];
	fieldStatesError: Error | null = null;
	/** Values each choice control offers, by elementId. */
	selectOptions: Record<string, string[]> = {};
	selectedCandidates: string[] = [];
	/** Replayed in order; the last entry repeats. */
	formSnapshots: string[] = ['["form"]'];
	formSnapshotCount = 0;
	pageText: string | undefined;
	pageTextTruncated = false;
	/** Falls back to a `sent` result naming the current url when left null. */
	submitResult: BrowserSubmitResult | null = null;
	/** Replayed per submit call when set; the last entry repeats. */
	submitResults: BrowserSubmitResult[] | null = null;
	/** What each submit call was told about the fields this run filled. */
	submitRequiredEnteredInput: boolean[] = [];
	/**
	 * Submit call number after which the page stops showing what was entered,
	 * the way a site that resets its form after the POST does.
	 */
	resetPageAtSubmit: number | null = null;
	/** Runs after each submit, so a test can move the page on. */
	onSubmit: ((count: number) => void) | null = null;
	/** Runs before each observe, so a test can move the page on. */
	onObserve: ((count: number) => void) | null = null;
	/** Blocks the bootstrap navigate until close(), like a page that never loads. */
	blockNavigateUntilClose = false;
	#enteredNavigate: (() => void) | undefined;
	#releaseNavigate: (() => void) | undefined;
	readonly navigateEntered = new Promise<void>((resolve) => {
		this.#enteredNavigate = resolve;
	});

	constructor(options: FakeBrowserDriverOptions) {
		this.url = options.url;
		this.observationForms = options.forms;
		this.fieldStates = options.fieldStates;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.#releaseNavigate?.();
	}

	async restrictToDomain(targetDomain: string): Promise<void> {
		this.restrictedDomain = targetDomain;
	}

	async currentUrl(): Promise<string> {
		if (this.connectionClosed) {
			throw new Error("Browser Use CDP connection is closed");
		}
		return this.url;
	}

	async navigate(url: string): Promise<void> {
		this.navigationCount += 1;
		this.url = this.redirectTo ?? url;
		if (!this.blockNavigateUntilClose) return;
		this.#enteredNavigate?.();
		await new Promise<void>((resolve) => {
			this.#releaseNavigate = resolve;
		});
		throw new Error("Browser Use CDP connection is closed");
	}

	async observe(): Promise<BrowserObservation> {
		this.observed = true;
		this.observeCount += 1;
		this.onObserve?.(this.observeCount);
		const sequence = this.observationFormsSequence;
		const forms = sequence
			? (sequence[Math.min(this.observeCount - 1, sequence.length - 1)] ?? [])
			: this.observationForms;
		return {
			url: this.url,
			// A real observation is a snapshot, not a live view of the page.
			forms: structuredClone(forms),
			...(this.pageText ? { pageText: this.pageText } : {}),
			...(this.pageTextTruncated ? { pageTextTruncated: true } : {}),
			...(this.navigationLinks
				? { navigationLinks: this.navigationLinks }
				: {}),
		};
	}

	async clickNonSubmit(): Promise<void> {
		this.clickCount += 1;
		const error = this.firstClickError;
		this.firstClickError = null;
		if (error) throw error;
	}

	async fill(elementId: string, value: string): Promise<void> {
		this.filledValues.push(value);
		this.applyValue(elementId, value);
	}

	async select(
		elementId: string,
		candidates: readonly string[],
	): Promise<void> {
		const offered = this.selectOptions[elementId];
		const chosen = offered
			? candidates.find((candidate) => offered.includes(candidate))
			: candidates[0];
		if (chosen === undefined) throw new BrowserElementError();
		this.selectedCandidates.push(chosen);
		this.applyValue(elementId, chosen);
	}

	/** Mirrors what a real browser shows on the next observation. */
	applyValue(elementId: string, value: string): void {
		for (const form of this.observationForms) {
			if (!isRecord(form)) continue;
			const fields = form.fields;
			if (!Array.isArray(fields)) continue;
			for (const field of fields) {
				if (isRecord(field) && field.elementId === elementId) {
					field.value = value;
				}
			}
		}
		for (const state of this.fieldStates) {
			if (state.elementId === elementId) state.value = value;
		}
	}

	async validateSubmit(): Promise<void> {
		this.validateSubmitCount += 1;
		if (this.validateSubmitError) throw this.validateSubmitError;
		if (this.requireObservationForSubmit && !this.observed) {
			throw new BrowserElementError();
		}
	}

	async readObservedFieldStates(): Promise<ObservedFieldState[]> {
		if (this.fieldStatesError) throw this.fieldStatesError;
		return this.fieldStates;
	}

	async readPageText(): Promise<string> {
		return this.pageText ?? "";
	}

	async readFormSnapshot(): Promise<string> {
		this.formSnapshotCount += 1;
		return this.formSnapshots.length > 1
			? (this.formSnapshots.shift() as string)
			: (this.formSnapshots[0] as string);
	}

	async captureScreenshot(): Promise<Uint8Array> {
		this.screenshotCount += 1;
		if (this.failScreenshotAt === this.screenshotCount) {
			if (this.closeConnectionOnScreenshotFailure) {
				this.connectionClosed = true;
			}
			throw new Error("Browser screenshot failed");
		}
		if (this.screenshotError) throw this.screenshotError;
		return new Uint8Array([this.screenshotCount, 2, 3]);
	}

	async submit(
		_elementId: string,
		activationStrategy: SubmitActivationStrategy,
		requireEnteredInput = true,
	): Promise<BrowserSubmitResult> {
		this.submitCount += 1;
		this.submitActivationStrategies.push(activationStrategy);
		this.submitRequiredEnteredInput.push(requireEnteredInput);
		if (this.submitError) {
			throw this.submitError;
		}
		if (this.resetPageAtSubmit === this.submitCount) {
			this.pageText = "Contact";
			this.fieldStates = [];
		}
		const fallback: BrowserSubmitResult = this.submitResult ?? {
			outcome: "sent",
			formUrl: this.url,
		};
		const sequence = this.submitResults;
		const result = sequence
			? (sequence[Math.min(this.submitCount - 1, sequence.length - 1)] ??
				fallback)
			: fallback;
		this.onSubmit?.(this.submitCount);
		return result;
	}
}
