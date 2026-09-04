import { BROWSER_ERROR } from "./browser-error-messages";
import {
	assertAllowedBrowserRequest,
	isVerificationProviderRequest,
} from "./browser-network-policy";
import {
	SUBMISSION_CONFIRMATION_PATTERN,
	SUBMISSION_PENDING_PATTERN,
} from "./browser-submit-confirmation";
import {
	BrowserUseCdpClosedError,
	BrowserUseCdpCommandError,
	BrowserUseCdpConnection,
	BrowserUseCdpUpgradeRejectedError,
	type CdpCommandErrorKind,
} from "./browser-use-cdp";
import {
	type CdpDomNode,
	type CdpFormCandidate,
	type CdpFormDiscovery,
	discoverCdpBodyBackendNodeIds,
	discoverCdpForms,
	discoverCdpNavigationLinks,
	findCdpFrameOwnerBackendNodeId,
} from "./browser-use-cdp-dom";
import {
	ACTIVATE_SUBMIT_FUNCTION,
	BLOCK_BROWSER_ESCAPE_EXPRESSION,
	CHECK_FORM_VALIDITY_FUNCTION,
	HAS_CONFIRMATION_TEXT_FUNCTION,
	HAS_SAME_FORM_OWNER_FUNCTION,
	INSPECT_ELEMENT_FUNCTION,
	IS_COMPOSED_DESCENDANT_FUNCTION,
	IS_ELEMENT_FOCUSED_FUNCTION,
	IS_SUBMIT_UNOBSCURED_FUNCTION,
	MATCHES_CHOICE_CANDIDATE_FUNCTION,
	READ_FORM_PROHIBITION_REASON_CODES_FUNCTION,
	SELECT_OPTION_BY_CANDIDATE_FUNCTION,
	SELECT_RADIO_BY_CANDIDATE_FUNCTION,
	SET_CHECKED_VALUE_FUNCTION,
} from "./browser-use-cdp-page-scripts";
import {
	denyRelatedBrowserTargets,
	type TargetInfo,
} from "./browser-use-cdp-related-targets";
import {
	type CdpLayoutMetricsResult,
	type CdpScreenshotResult,
	captureCdpFullPageScreenshot,
	captureCdpScreenshot,
} from "./browser-use-cdp-screenshot";
import {
	type BrowserSession,
	BrowserUseApiError,
	BrowserUseClient,
	type BrowserUseFetch,
	BrowserUseRequestError,
	BrowserUseResponseError,
	resolveCdpWebSocketUrl,
} from "./browser-use-client";
import {
	type BrowserSessionHandle,
	reclaimJobSessions,
	SESSION_SOURCE_TAG,
	sampleActiveSessions,
	stopBrowserSession,
} from "./browser-use-session";
import type { Job } from "./job";
import {
	assertAllowedTargetUrl,
	BrowserElementError,
	type BrowserElementOperation,
	BrowserElementOperationError,
	BrowserFormInvalidError,
	type BrowserObservation,
	type BrowserSubmitResult,
	createBrowserSubmitDiagnosticError,
	isReviewComparableField,
	normalizeAllowedHosts,
	normalizeTargetDomain,
	type ObservedFieldState,
	type RestrictedBrowserDriver,
	type ScreenshotMode,
	type SubmitActivationStrategy,
} from "./restricted-browser";

const MAX_PAGE_TEXT = 20_000;
const MAX_OBSERVED_FORMS = 10;
const MAX_OBSERVED_FIELDS = 100;
const MAX_DOM_DISCOVERY_ATTEMPTS = 5;
const DOM_DISCOVERY_RETRY_DELAY_MS = 500;
const CONFIRMATION_POLL_INTERVAL_MS = 1_000;
const SUBMISSION_CONFIRMATION_TIMEOUT_MS = 15_000;
const SUBMISSION_PERMISSION_WINDOW_MS = 2_000;
/**
 * How many unsafe requests one run may send while a submission is authorized.
 * The form action is no longer compared, so this cap -- together with the
 * domain check -- is what bounds a page that keeps posting during the
 * activation window.
 */
export const MAX_SUBMISSION_REQUESTS = 5;
const MAX_MOUSE_PREPARATION_ATTEMPTS = 3;
const READY_STATE_TIMEOUT_MS = 10_000;
/**
 * The first navigation of a run pays for the cold start of the page and its
 * render-blocking subresources, so it waits longer and is retried once. Later
 * navigations keep the short wait: by then the site is warm and a stalled load
 * is a signal the model should act on instead of waiting out.
 */
const BOOTSTRAP_READY_STATE_TIMEOUT_MS = 25_000;
const CONNECT_RETRY_DELAYS_MS = [10_000, 20_000, 30_000];
/**
 * The run deadline is 10 minutes and the termination grace is 30 seconds, so a
 * 12 minute provider timeout only acts as a backstop when the explicit stop
 * never reaches the provider.
 */
const SESSION_TIMEOUT_MINUTES = 12;

const RETRYABLE_CONNECT_ERROR_MESSAGES = new Set<string>([
	BROWSER_ERROR.CDP_CONNECTION_FAILED,
	BROWSER_ERROR.CDP_CONNECTION_CLOSED,
	BROWSER_ERROR.CDP_CONNECTION_IS_CLOSED,
	BROWSER_ERROR.CDP_COMMAND_TIMED_OUT,
]);

export interface BrowserUseConnectOptions {
	retryDelaysMs?: readonly number[];
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
	client?: BrowserUseClient;
	fetcher?: BrowserUseFetch;
	connectConnection?: (
		webSocketUrl: string,
		signal?: AbortSignal,
	) => Promise<BrowserUseCdpConnection>;
	/**
	 * How long a submission waits for the page to confirm it. Only a test
	 * overrides it, so that the uncertain path can be watched without waiting
	 * out the real window.
	 */
	submissionConfirmationTimeoutMs?: number;
}

function isRetryableConnectError(error: unknown): boolean {
	if (error instanceof BrowserUseCdpUpgradeRejectedError) {
		return error.retryable;
	}
	if (error instanceof BrowserUseCdpClosedError) {
		return error.retryable;
	}
	if (error instanceof BrowserUseApiError) {
		return error.retryable;
	}
	if (
		error instanceof BrowserUseRequestError ||
		error instanceof BrowserUseResponseError
	) {
		return true;
	}
	return (
		error instanceof Error &&
		RETRYABLE_CONNECT_ERROR_MESSAGES.has(error.message)
	);
}

function connectAbortedError(): Error {
	return new Error(BROWSER_ERROR.CDP_CONNECTION_ABORTED);
}

function assertConnectNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw connectAbortedError();
}

export function connectFailureDetail(error: unknown): {
	reason: string;
	status?: number;
} {
	if (error instanceof BrowserUseCdpUpgradeRejectedError) {
		return { reason: "CDP_UPGRADE_REJECTED", status: error.status };
	}
	if (error instanceof BrowserUseApiError) {
		return {
			reason: error.status === 429 ? "SESSION_LIMIT" : "SESSION_CREATE_FAILED",
			status: error.status,
		};
	}
	if (
		error instanceof BrowserUseRequestError ||
		error instanceof BrowserUseResponseError
	) {
		return { reason: "SESSION_CREATE_FAILED" };
	}
	if (!(error instanceof Error)) return { reason: "UNKNOWN" };
	switch (error.message) {
		case BROWSER_ERROR.CDP_CONNECTION_FAILED:
			return { reason: "CDP_CONNECTION_FAILED" };
		case BROWSER_ERROR.CDP_CONNECTION_IS_CLOSED:
		case BROWSER_ERROR.CDP_CONNECTION_CLOSED:
			return { reason: "CDP_CONNECTION_CLOSED" };
		case BROWSER_ERROR.CDP_COMMAND_TIMED_OUT:
			return { reason: "CDP_COMMAND_TIMEOUT" };
		default:
			return { reason: "UNKNOWN" };
	}
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(connectAbortedError());
			return;
		}
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(connectAbortedError());
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export const ENTER_KEY_DOWN_EVENT = {
	type: "keyDown",
	key: "Enter",
	code: "Enter",
	text: "\r",
	unmodifiedText: "\r",
	windowsVirtualKeyCode: 13,
	nativeVirtualKeyCode: 13,
} as const;

interface EvaluateResult {
	result: { objectId?: string; value?: unknown };
	exceptionDetails?: unknown;
}

interface ResolvedNode {
	object: { objectId?: string };
}

export interface CdpFrameTree {
	frame: { id: string; parentId?: string; url?: string };
	childFrames?: CdpFrameTree[];
}

interface AxNode {
	backendDOMNodeId?: number;
	name?: { value?: unknown };
	role?: { value?: unknown };
}

interface ElementState {
	ok: boolean;
	visible: boolean;
	tag: string;
	type: string;
	name: string | null;
	label: string;
	placeholder: string | null;
	required: boolean;
	value: string;
	options: Array<{ value: string; label: string }>;
	submitLike: boolean;
	target: string;
	formAction: string;
	formMethod: string;
	disabled: boolean;
	readOnly: boolean;
	checked: boolean;
}

interface ElementReference {
	backendNodeId: number;
	frameId?: string;
}

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

type SubmissionRequestBlockStage =
	| "expected_request"
	| "network_policy"
	| "request_limit";
type ObservedFrameTrust = "trusted" | "third_party" | "unknown";
type GetSubmissionRequestDisposition = "claim" | "block" | "ignore";

export type SubmitActivationStage =
	| "scroll"
	| "render_before_check"
	| "box_model"
	| "pointer_move"
	| "hit_test"
	| "retry_wait"
	| "unobscured_before_focus"
	| "focus"
	| "render_after_focus"
	| "post_focus_checks"
	| "unobscured_after_focus"
	| "focus_retained"
	| "dispatch";

export function collectCdpFrameParentIds(
	frameTree: CdpFrameTree,
): Map<string, string | undefined> {
	const parents = new Map<string, string | undefined>();
	const visit = (tree: CdpFrameTree, inheritedParentId?: string) => {
		const parentId = tree.frame.parentId ?? inheritedParentId;
		parents.set(tree.frame.id, parentId);
		for (const child of tree.childFrames ?? []) {
			visit(child, tree.frame.id);
		}
	};
	visit(frameTree);
	return parents;
}

/**
 * Reads the URL of every frame the tree names, so the caller can tell a frame
 * belonging to the target site from a third-party frame such as a
 * verification widget.
 */
export function collectCdpFrameUrls(
	frameTree: CdpFrameTree,
): Map<string, string> {
	const urls = new Map<string, string>();
	const visit = (tree: CdpFrameTree) => {
		if (typeof tree.frame.url === "string") {
			urls.set(tree.frame.id, tree.frame.url);
		}
		for (const child of tree.childFrames ?? []) visit(child);
	};
	visit(frameTree);
	return urls;
}

export class BrowserUseCdpDriver implements RestrictedBrowserDriver {
	#topFrameId: string | undefined;
	#targetDomain: string | undefined;
	#allowedHosts: string[] = [];
	#submissionRequestAllowed = false;
	#blockNonSubmitRequests = false;
	#expectedNavigationRequest:
		| { url: string; frameId?: string; claimed: boolean }
		| undefined;
	#submissionRequestInFlight = false;
	/**
	 * Requests already continued as part of the current submission. A redirect
	 * names the request it came from, so the set is what lets the follow-up of
	 * any claimed request through.
	 */
	readonly #submissionRedirectRequestIds = new Set<string>();
	#submissionRequestCount = 0;
	/** Submission requests continued across the whole run, capped by {@link MAX_SUBMISSION_REQUESTS}. */
	#submissionRequestTotal = 0;
	#verificationProviderRequestCount = 0;
	#verificationProviderFrameCount = 0;
	#submissionRequestObserved: (() => void) | undefined;
	#expectedSubmissionRequest: ExpectedSubmissionRequest | undefined;
	#submissionAttemptInProgress = false;
	#expectedSubmissionFrameId: string | undefined;
	#getSubmissionGuard:
		| { request: ExpectedSubmissionRequest; frameId?: string }
		| undefined;
	#submissionRequestBlockStage: SubmissionRequestBlockStage | undefined;
	#validatedSubmitInputBackendNodeId: number | undefined;
	#targetPolicyError: Error | undefined;
	readonly #frameNavigationRevisions = new Map<string, number>();
	readonly #frameParentIds = new Map<string, string | undefined>();
	readonly #frameUrls = new Map<string, string>();
	readonly #isolatedWorldContexts = new Map<string, number>();
	readonly #pageChangeWaiters = new Set<() => void>();
	#elementGeneration = 0;
	#elements = new Map<string, ElementReference>();
	#formDataEntered = false;
	#interactionStarted = false;
	#navigationCount = 0;
	#closePromise: Promise<void> | undefined;
	readonly #successfulInputBackendNodeIds = new Set<number>();

	private constructor(
		private readonly connection: BrowserUseCdpConnection,
		private readonly sessionId: string,
		private readonly dryRun: boolean,
		private readonly browserSession: BrowserSessionHandle | undefined,
		private readonly submissionConfirmationTimeoutMs = SUBMISSION_CONFIRMATION_TIMEOUT_MS,
	) {}

	/**
	 * The provider keeps a managed browser running after the CDP socket is gone,
	 * so every session is created through the REST API and stopped again on the
	 * way out. Leaving that stop undone consumes a concurrency slot until the
	 * provider timeout expires.
	 */
	static async connect(
		apiKey: string,
		job: Job,
		dryRun = false,
		options: BrowserUseConnectOptions = {},
	): Promise<BrowserUseCdpDriver> {
		if (!apiKey) throw new Error(BROWSER_ERROR.API_KEY_REQUIRED);
		const client = options.client ?? new BrowserUseClient(apiKey, fetch);
		const fetcher = options.fetcher ?? fetch;
		const retryDelaysMs = options.retryDelaysMs ?? CONNECT_RETRY_DELAYS_MS;
		const signal = options.signal;
		const sleep = options.sleep ?? ((ms: number) => sleepMs(ms, signal));
		const openConnection =
			options.connectConnection ??
			((target: string, connectSignal?: AbortSignal) =>
				BrowserUseCdpConnection.connect(
					target,
					fetch,
					undefined,
					connectSignal,
				));

		assertConnectNotAborted(signal);
		if (job.attemptCount > 1) {
			await reclaimJobSessions(client, job.id, signal);
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
			if (attempt > 0) {
				const delayMs = retryDelaysMs[attempt - 1] ?? 0;
				console.warn(
					JSON.stringify({
						event: "browser_use_connect_retry",
						attempt,
						delayMs,
						...connectFailureDetail(lastError),
					}),
				);
				if (
					lastError instanceof BrowserUseApiError &&
					lastError.status === 429
				) {
					// Sampled before the backoff so the counts describe the sessions
					// that were active when the provider rejected the request.
					await sampleActiveSessions(client, signal);
				}
				await sleep(delayMs);
			}
			assertConnectNotAborted(signal);
			// A previous attempt may have created a session the provider kept but
			// never handed back, so the leftovers are collected before retrying.
			if (attempt > 0) {
				await reclaimJobSessions(client, job.id, signal);
			}
			try {
				return await BrowserUseCdpDriver.#connectOnce(
					client,
					fetcher,
					apiKey,
					job,
					dryRun,
					attempt,
					openConnection,
					signal,
					options.submissionConfirmationTimeoutMs,
				);
			} catch (error) {
				// An abort ends the run, so it is never reported as a retry.
				assertConnectNotAborted(signal);
				if (!isRetryableConnectError(error)) throw error;
				lastError = error;
			}
		}
		throw lastError;
	}

	static async #connectOnce(
		client: BrowserUseClient,
		fetcher: BrowserUseFetch,
		apiKey: string,
		job: Job,
		dryRun: boolean,
		attempt: number,
		openConnection: (
			webSocketUrl: string,
			signal?: AbortSignal,
		) => Promise<BrowserUseCdpConnection>,
		signal: AbortSignal | undefined,
		submissionConfirmationTimeoutMs: number | undefined,
	): Promise<BrowserUseCdpDriver> {
		let session: BrowserSession;
		try {
			session = await client.createBrowser({
				timeoutMinutes: SESSION_TIMEOUT_MINUTES,
				proxyCountryCode: "jp",
				metadata: {
					source: SESSION_SOURCE_TAG,
					jobId: job.id,
					dryRun: String(dryRun),
				},
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			// The provider may have started a session even though the response was
			// unusable, so the identifier it reported is released here.
			if (error instanceof BrowserUseResponseError && error.sessionId) {
				await stopBrowserSession({ client, id: error.sessionId });
			}
			throw error;
		}
		const handle: BrowserSessionHandle = { client, id: session.id };
		try {
			assertConnectNotAborted(signal);
			const cdpUrl = session.cdpUrl;
			if (!cdpUrl) {
				throw new BrowserUseResponseError(
					BROWSER_ERROR.SESSION_WITHOUT_CDP_URL,
				);
			}
			const cdpScheme = cdpUrl.startsWith("wss:") ? "wss" : "https";
			const webSocketUrl = await resolveCdpWebSocketUrl(
				cdpUrl,
				fetcher,
				apiKey,
				signal,
			);
			const driver = await BrowserUseCdpDriver.#establish(
				webSocketUrl,
				dryRun,
				openConnection,
				signal,
				handle,
				submissionConfirmationTimeoutMs,
			);
			console.log(
				JSON.stringify({
					event: "browser_use_session_created",
					cdpScheme,
					attempt,
				}),
			);
			return driver;
		} catch (error) {
			await stopBrowserSession(handle);
			throw error;
		}
	}

	static async #establish(
		webSocketUrl: string,
		dryRun: boolean,
		openConnection: (
			webSocketUrl: string,
			signal?: AbortSignal,
		) => Promise<BrowserUseCdpConnection>,
		signal: AbortSignal | undefined,
		browserSession: BrowserSessionHandle | undefined,
		submissionConfirmationTimeoutMs: number | undefined,
	): Promise<BrowserUseCdpDriver> {
		const connection = await openConnection(webSocketUrl, signal);
		// Closing the connection rejects every in-flight command, so an abort
		// during setup fails fast instead of waiting out the CDP command timeout.
		const onAbort = () => connection.close();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			assertConnectNotAborted(signal);
			const { targetInfos } = await connection.send<{
				targetInfos: TargetInfo[];
			}>("Target.getTargets");
			let targetId = targetInfos.find(
				(target) => target.type === "page",
			)?.targetId;
			if (!targetId) {
				targetId = (
					await connection.send<{ targetId: string }>("Target.createTarget", {
						url: "about:blank",
					})
				).targetId;
			}
			const { sessionId } = await connection.send<{ sessionId: string }>(
				"Target.attachToTarget",
				{ targetId, flatten: true },
			);
			const driver = new BrowserUseCdpDriver(
				connection,
				sessionId,
				dryRun,
				browserSession,
				submissionConfirmationTimeoutMs,
			);
			await driver.#initialize();
			return driver;
		} catch (error) {
			connection.close();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#verificationProviderRequestCount > 0) {
			console.log(
				JSON.stringify({
					event: "browser_verification_requests",
					count: this.#verificationProviderRequestCount,
				}),
			);
		}
		if (this.#verificationProviderFrameCount > 0) {
			console.log(
				JSON.stringify({
					event: "browser_verification_frames",
					count: this.#verificationProviderFrameCount,
				}),
			);
		}
		this.#notifyPageChanged();
		this.connection.close();
		if (this.browserSession) {
			await stopBrowserSession(this.browserSession);
		}
	}

	async restrictToDomain(
		targetDomain: string,
		allowedHosts: readonly string[],
	): Promise<void> {
		if (this.#targetDomain && this.#targetDomain !== targetDomain) {
			throw new Error(BROWSER_ERROR.DOMAIN_SCOPE_CANNOT_CHANGE);
		}
		const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
		if (
			this.#targetDomain &&
			JSON.stringify(this.#allowedHosts) !==
				JSON.stringify(normalizedAllowedHosts)
		) {
			throw new Error(BROWSER_ERROR.HOST_SCOPE_CANNOT_CHANGE);
		}
		this.#targetDomain ??= targetDomain;
		this.#allowedHosts = normalizedAllowedHosts;
	}

	currentUrl(): Promise<string> {
		return this.#evaluate<string>("location.href");
	}

	captureScreenshot(mode: ScreenshotMode): Promise<Uint8Array> {
		return mode === "full_page"
			? this.#captureFullPageScreenshot()
			: this.#captureViewportScreenshot();
	}

	#captureViewportScreenshot(): Promise<Uint8Array> {
		return captureCdpScreenshot((params) =>
			this.#send<CdpScreenshotResult>("Page.captureScreenshot", params),
		);
	}

	async #captureFullPageScreenshot(): Promise<Uint8Array> {
		try {
			return await captureCdpFullPageScreenshot(
				() => this.#send<CdpLayoutMetricsResult>("Page.getLayoutMetrics", {}),
				(params) =>
					this.#send<CdpScreenshotResult>("Page.captureScreenshot", params),
			);
		} catch (error) {
			// A payload over the CDP message limit closes the connection, so a
			// second capture has nothing left to run against.
			if (this.connection.closed) throw error;
			console.log(
				JSON.stringify({ event: "browser_full_page_screenshot_fallback" }),
			);
			return this.#captureViewportScreenshot();
		}
	}

	async navigate(url: string): Promise<void> {
		assertDryRunNavigationAllowed(this.dryRun, this.#navigationCount);
		// The bootstrap navigation is the one the coordinator issues before the
		// model runs. It is counted once for the whole bootstrap, so the retry
		// below stays inside the single navigation the dry-run guard allows.
		const bootstrap = this.#navigationCount === 0;
		this.#navigationCount += 1;
		const readyStateTimeoutMs = bootstrap
			? BOOTSTRAP_READY_STATE_TIMEOUT_MS
			: READY_STATE_TIMEOUT_MS;
		try {
			await this.#navigateOnce(url, readyStateTimeoutMs);
			return;
		} catch (error) {
			if (!bootstrap || !isPageNotReadyError(error) || this.connection.closed) {
				throw error;
			}
			console.log(
				JSON.stringify({ event: "browser_bootstrap_navigate_retried" }),
			);
		}
		await this.#navigateOnce(url, readyStateTimeoutMs);
	}

	async #navigateOnce(url: string, readyStateTimeoutMs: number): Promise<void> {
		this.#expectedNavigationRequest = this.#blockNonSubmitRequests
			? {
					url: canonicalHttpRequestUrl(url),
					...(this.#topFrameId ? { frameId: this.#topFrameId } : {}),
					claimed: false,
				}
			: undefined;
		this.#clearElements();
		try {
			const result = await this.#send<{ errorText?: string }>("Page.navigate", {
				url,
			});
			if (result.errorText) throw new Error(BROWSER_ERROR.NAVIGATION_FAILED);
			await this.#waitForReadyState(readyStateTimeoutMs);
		} finally {
			this.#expectedNavigationRequest = undefined;
		}
	}

	async observe(): Promise<BrowserObservation> {
		const startedAt = Date.now();
		const url = await this.currentUrl();
		const {
			discovery,
			root,
			attempts: discoveryAttempts,
		} = await this.#discoverForms(url);

		const generation = ++this.#elementGeneration;
		const elements = new Map<string, ElementReference>();
		const forms: Array<{
			action: string;
			method: string;
			fields: unknown[];
			prohibitedReasonCodes: string[];
		}> = [];
		let fieldIndex = 0;
		let skippedThirdPartyForms = 0;

		for (const candidateForm of discovery.forms) {
			if (
				forms.length >= MAX_OBSERVED_FORMS ||
				fieldIndex >= MAX_OBSERVED_FIELDS
			) {
				break;
			}
			const frameTrust = this.#observedFrameTrust(candidateForm.frameId);
			if (frameTrust === "third_party") {
				skippedThirdPartyForms += 1;
				continue;
			}
			const fields: unknown[] = [];
			const formElements: Array<[string, ElementReference]> = [];
			for (const candidate of candidateForm.fields) {
				if (fieldIndex >= MAX_OBSERVED_FIELDS) break;
				const state = await this.#inspectElement(candidate.backendNodeId).catch(
					() => null,
				);
				if (!state?.ok || !state.visible) continue;
				const accessible = await this.#accessibleElement(
					candidate.backendNodeId,
				).catch(() => null);
				const elementId = `fa-${generation.toString(36)}-${fieldIndex.toString(36)}`;
				fieldIndex += 1;
				formElements.push([
					elementId,
					{
						backendNodeId: candidate.backendNodeId,
						...(candidateForm.frameId
							? { frameId: candidateForm.frameId }
							: {}),
					},
				]);
				fields.push({
					elementId,
					tag: state.tag,
					type: state.type || null,
					name: state.name,
					role: accessible?.role ?? null,
					label: accessible?.name || state.label,
					placeholder: state.placeholder,
					required: state.required,
					value: state.type === "password" ? "" : state.value,
					...(state.type === "checkbox" || state.type === "radio"
						? { checked: state.checked }
						: {}),
					options: state.options,
				});
			}
			if (fields.length > 0) {
				const formFrameId = candidateForm.frameId ?? this.#topFrameId;
				if (!formFrameId) throw new BrowserElementError();
				let prohibitedReasonCodes: string[];
				try {
					prohibitedReasonCodes = await this.#formProhibitionReasonCodes(
						candidateForm,
						formFrameId,
						root,
					);
				} catch (error) {
					if (
						frameTrust !== "unknown" ||
						!(error instanceof BrowserUseCdpCommandError)
					) {
						throw error;
					}
					console.log(
						JSON.stringify({
							event: "browser_form_skipped",
							reason: "FRAME_CONTEXT_UNAVAILABLE",
						}),
					);
					continue;
				}
				for (const [elementId, reference] of formElements) {
					elements.set(elementId, reference);
				}
				forms.push({
					action: candidateForm.action,
					method: candidateForm.method,
					fields,
					prohibitedReasonCodes,
				});
			}
		}

		this.#elements = elements;
		const pageText = await this.#bodyText();
		const navigationLinks = discoverCdpNavigationLinks(root, url, (linkUrl) => {
			if (!this.#targetDomain) return false;
			try {
				assertAllowedTargetUrl(linkUrl, this.#targetDomain, this.#allowedHosts);
				return true;
			} catch {
				return false;
			}
		});
		console.log(
			JSON.stringify({
				event: "browser_dom_observation",
				cdpResponseCharacters:
					this.connection.lastResponseCharacters("DOM.getDocument") ?? null,
				nodeCount: discovery.nodeCount,
				shadowRootCount: discovery.shadowRootCount,
				closedShadowRootCount: discovery.closedShadowRootCount,
				candidateFieldCount: discovery.candidateFieldCount,
				observedFieldCount: elements.size,
				skippedThirdPartyForms,
				discoveryAttempts,
				durationMs: Date.now() - startedAt,
			}),
		);
		return {
			url,
			forms,
			pageText: pageText.text,
			...(pageText.truncated ? { pageTextTruncated: true } : {}),
			navigationLinks,
		};
	}

	/**
	 * Re-reads every element the latest observation named, so the caller can
	 * confirm the page still holds the reviewed content. Elements that no
	 * longer resolve are omitted, which the caller sees as a set mismatch.
	 */
	async readObservedFieldStates(): Promise<ObservedFieldState[]> {
		const states: ObservedFieldState[] = [];
		for (const [elementId, reference] of this.#elements) {
			const state = await this.#inspectElement(reference.backendNodeId).catch(
				() => null,
			);
			const comparable = state && toObservedFieldState(elementId, state);
			if (comparable) states.push(comparable);
		}
		return states;
	}

	/**
	 * Reads the visible body text of the current document, truncated at the
	 * page text limit, so a caller can tell a confirmation screen that repeats
	 * the entered values from a page that no longer shows them.
	 */
	async readPageText(): Promise<string> {
		return (await this.#bodyText()).text;
	}

	/**
	 * Rediscovers the form that owns the submit control and describes every
	 * control it holds. Unlike `observe`, nothing is dropped for being hidden
	 * or disabled, so a control the page adds during the review is visible in
	 * the comparison.
	 */
	async readFormSnapshot(elementId: string): Promise<string> {
		const reference = this.#element(elementId);
		const { discovery } = await this.#discoverForms(await this.currentUrl());
		const owner = discovery.forms.find(
			(form) =>
				(form.frameId ?? this.#topFrameId) ===
					(reference.frameId ?? this.#topFrameId) &&
				form.fields.some(
					(field) => field.backendNodeId === reference.backendNodeId,
				),
		);
		if (!owner) throw new BrowserElementError();
		const states: Array<FormSnapshotElement | null> = [];
		for (const field of owner.fields) {
			states.push(
				await this.#inspectElement(field.backendNodeId).catch(() => null),
			);
		}
		return toFormSnapshot(states);
	}

	async clickNonSubmit(elementId: string): Promise<void> {
		const reference = this.#element(elementId);
		// The press is the last step a CDP failure may be reported as an element
		// error for. Once it is sent the click may already have reached the page,
		// so a failed release stays a run error rather than inviting a re-click.
		const point = await this.#asElementOperation("click", async () => {
			const state = await this.#inspectElement(reference.backendNodeId);
			if (
				!state.ok ||
				!state.visible ||
				state.disabled ||
				state.submitLike ||
				!isPayloadIndependentClickTarget(state.tag, state.type)
			) {
				throw new BrowserElementError();
			}
			this.#interactionStarted = true;
			this.#blockNonSubmitRequests = true;
			const preparedPoint = await this.#prepareMouseClick(
				reference.backendNodeId,
			);
			await this.#dispatchMousePress(preparedPoint);
			return preparedPoint;
		});
		await this.#dispatchMouseRelease(point);
	}

	async fill(elementId: string, value: string): Promise<void> {
		const reference = this.#element(elementId);
		await this.#asElementOperation("fill", async () => {
			const state = await this.#inspectElement(reference.backendNodeId);
			if (
				!state.ok ||
				!state.visible ||
				state.disabled ||
				state.readOnly ||
				!isFillable(state.tag, state.type)
			) {
				throw new BrowserElementError();
			}
			this.#interactionStarted = true;
			this.#formDataEntered = true;
			this.#blockNonSubmitRequests = true;
			await this.#send("DOM.scrollIntoViewIfNeeded", {
				backendNodeId: reference.backendNodeId,
			});
			await this.#send("DOM.focus", {
				backendNodeId: reference.backendNodeId,
			});
			await this.#replaceFocusedText(value);
			this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
		});
	}

	/**
	 * Applies the first of `candidates` that the control actually offers. The
	 * candidates are payload values the registrant allowed, so the page decides
	 * only which one fits; it never contributes a value of its own. Page
	 * functions therefore return fixed tokens, never page text.
	 */
	async select(
		elementId: string,
		candidates: readonly string[],
	): Promise<void> {
		const reference = this.#element(elementId);
		const candidateList = [...candidates];
		await this.#asElementOperation("select", async () => {
			const state = await this.#inspectElement(reference.backendNodeId);
			if (
				!state.ok ||
				!state.visible ||
				state.disabled ||
				candidateList.length === 0
			) {
				throw new BrowserElementError();
			}
			this.#interactionStarted = true;
			this.#formDataEntered = true;
			this.#blockNonSubmitRequests = true;
			if (state.tag === "select") {
				const selected = await this.#callFunctionOnElement<unknown>(
					reference.backendNodeId,
					SELECT_OPTION_BY_CANDIDATE_FUNCTION,
					[candidateList],
				);
				if (selected !== true) throw new BrowserElementError();
				this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
				return;
			}
			if (state.type === "checkbox") {
				const desiredChecked =
					desiredCheckboxState(candidateList) ??
					((await this.#callFunctionOnElement<unknown>(
						reference.backendNodeId,
						MATCHES_CHOICE_CANDIDATE_FUNCTION,
						[candidateList],
					)) === true
						? true
						: undefined);
				if (desiredChecked === undefined) throw new BrowserElementError();
				const changed = await this.#callFunctionOnElement<unknown>(
					reference.backendNodeId,
					SET_CHECKED_VALUE_FUNCTION,
					[desiredChecked],
				);
				if (changed !== true) throw new BrowserElementError();
				this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
				return;
			}
			if (state.type === "radio") {
				const outcome = readRadioSelectionOutcome(
					await this.#callFunctionOnElement<unknown>(
						reference.backendNodeId,
						SELECT_RADIO_BY_CANDIDATE_FUNCTION,
						[candidateList],
					),
				);
				if (outcome !== "selected") throw new BrowserElementError();
				this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
				return;
			}
			throw new BrowserElementError();
		});
	}

	/**
	 * Reports a CDP command rejection during an element operation as an element
	 * error, so the model re-observes and continues instead of the run ending.
	 * Connection loss, timeouts, and unsent commands stay run errors because a
	 * later tool call cannot recover from them either.
	 */
	async #asElementOperation<TResult>(
		operation: BrowserElementOperation,
		run: () => Promise<TResult>,
	): Promise<TResult> {
		try {
			return await run();
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.message !== BROWSER_ERROR.CDP_COMMAND_FAILED
			) {
				throw error;
			}
			console.warn(
				JSON.stringify({
					event: "browser_element_operation_failed",
					operation,
					...(error instanceof BrowserUseCdpCommandError
						? {
								method: error.method,
								kind: error.kind,
								code: error.code,
							}
						: {}),
				}),
			);
			throw new BrowserElementOperationError(operation);
		}
	}

	/**
	 * `requireEnteredInput` is false only for a later stage of the same
	 * submission. A confirmation screen is a new document, so the fields this
	 * run filled no longer exist and the "the submit control owns a field I
	 * filled" tie cannot be made there. The handler checks that the page still
	 * carries the reviewed values instead.
	 */
	async validateSubmit(
		elementId: string,
		requireEnteredInput = true,
	): Promise<void> {
		this.#expectedSubmissionRequest = undefined;
		this.#validatedSubmitInputBackendNodeId = undefined;
		const reference = this.#element(elementId);
		const state = await this.#inspectElement(reference.backendNodeId);
		if (
			!state.ok ||
			!state.visible ||
			state.disabled ||
			!state.submitLike ||
			(state.target !== "" && state.target !== "_self")
		) {
			throw new BrowserElementError();
		}
		let hasInputInSubmitForm = false;
		for (const inputBackendNodeId of this.#successfulInputBackendNodeIds) {
			const hasSameFormOwner =
				await this.#callFunctionOnElementWithElementArgument<boolean>(
					reference.backendNodeId,
					inputBackendNodeId,
					HAS_SAME_FORM_OWNER_FUNCTION,
				);
			if (!hasSameFormOwner) throw new BrowserElementError();
			hasInputInSubmitForm = true;
			this.#validatedSubmitInputBackendNodeId ??= inputBackendNodeId;
		}
		if (requireEnteredInput && !hasInputInSubmitForm) {
			throw new BrowserElementError();
		}
		const formValid = await this.#callFunctionOnElement<boolean>(
			reference.backendNodeId,
			CHECK_FORM_VALIDITY_FUNCTION,
		);
		if (!formValid) throw new BrowserFormInvalidError();
		this.#expectedSubmissionRequest = createExpectedSubmissionRequest(
			state.formAction,
			state.formMethod,
		);
		this.#expectedSubmissionFrameId = reference.frameId;
	}

	async submit(
		elementId: string,
		activationStrategy: SubmitActivationStrategy,
		requireEnteredInput = true,
	): Promise<BrowserSubmitResult> {
		try {
			await this.validateSubmit(elementId, requireEnteredInput);
		} catch (error) {
			throw createBrowserSubmitDiagnosticError("SUBMIT_VALIDATE", error);
		}
		this.#blockNonSubmitRequests = true;
		this.#submissionRedirectRequestIds.clear();
		this.#interactionStarted = true;
		if (this.#expectedSubmissionRequest?.method === "GET") {
			this.#getSubmissionGuard ??= {
				request: this.#expectedSubmissionRequest,
				...(this.#expectedSubmissionFrameId
					? { frameId: this.#expectedSubmissionFrameId }
					: {}),
			};
		}
		const expectedDocumentGetFrameId =
			this.#expectedSubmissionRequest?.method === "GET"
				? this.#expectedSubmissionFrameId
				: undefined;
		let beforeConfirmationCount: number;
		try {
			beforeConfirmationCount = await this.#confirmationBodyCount(
				expectedDocumentGetFrameId,
			);
		} catch (error) {
			throw createBrowserSubmitDiagnosticError(
				"SUBMIT_READ_BEFORE_TEXT",
				error,
			);
		}
		const frameNavigationRevisionBeforeActivation = expectedDocumentGetFrameId
			? (this.#frameNavigationRevisions.get(expectedDocumentGetFrameId) ?? 0)
			: 0;
		try {
			this.#submissionAttemptInProgress = true;
			this.#submissionRequestBlockStage = undefined;
			try {
				await this.#activateSubmitElement(
					this.#element(elementId).backendNodeId,
					activationStrategy,
				);
			} catch (error) {
				throw createBrowserSubmitDiagnosticError("SUBMIT_ACTIVATE", error);
			}
			const confirmation = await waitForSubmissionConfirmation(
				() =>
					readSubmissionConfirmation(
						beforeConfirmationCount,
						this.#submissionRequestCount > 0,
						() => this.#confirmationBodyCount(expectedDocumentGetFrameId),
						() => this.currentUrl(),
						hasExpectedFrameNavigated(
							expectedDocumentGetFrameId,
							frameNavigationRevisionBeforeActivation,
							this.#frameNavigationRevisions,
						),
					),
				(milliseconds) => this.#waitForPageChange(milliseconds),
				this.submissionConfirmationTimeoutMs,
			);
			if (confirmation) return confirmation;
		} finally {
			this.#submissionRequestAllowed = false;
			this.#submissionAttemptInProgress = false;
		}
		const reasonCode = submitUncertainReasonCode(
			activationStrategy,
			this.#submissionRequestCount > 0,
			this.#submissionRequestBlockStage,
		);
		return {
			outcome: "uncertain",
			reasonCode,
			reason: "The page did not provide a reliable submission confirmation.",
		};
	}

	async #initialize(): Promise<void> {
		await denyRelatedBrowserTargets(
			this.connection,
			this.sessionId,
			(error) => {
				this.#targetPolicyError ??= error;
			},
			{
				onVerificationFrame: () => {
					this.#verificationProviderFrameCount += 1;
				},
				onVerificationRequest: () => {
					this.#verificationProviderRequestCount += 1;
				},
			},
		);
		this.connection.on("Fetch.requestPaused", (params, sessionId) => {
			if (sessionId === this.sessionId) {
				void this.#handlePausedRequest(params as PausedRequest);
			}
		});
		this.connection.on("DOM.documentUpdated", (_params, sessionId) => {
			if (sessionId !== this.sessionId) return;
			this.#clearElements();
			this.#isolatedWorldContexts.clear();
			this.#notifyPageChanged();
		});
		this.connection.on("Page.loadEventFired", (_params, sessionId) => {
			if (sessionId === this.sessionId) this.#notifyPageChanged();
		});
		this.connection.on("Page.frameAttached", (params, sessionId) => {
			if (sessionId !== this.sessionId) return;
			const { frameId, parentFrameId } = params as {
				frameId?: unknown;
				parentFrameId?: unknown;
			};
			if (typeof frameId === "string" && typeof parentFrameId === "string") {
				this.#frameParentIds.set(frameId, parentFrameId);
			}
		});
		this.connection.on("Page.frameNavigated", (params, sessionId) => {
			if (sessionId !== this.sessionId) return;
			const frame = (
				params as {
					frame?: { id?: unknown; parentId?: unknown; url?: unknown };
				}
			).frame;
			const frameId = frame?.id;
			if (typeof frameId !== "string") return;
			this.#frameParentIds.set(
				frameId,
				typeof frame?.parentId === "string" ? frame.parentId : undefined,
			);
			if (typeof frame?.url === "string") {
				this.#frameUrls.set(frameId, frame.url);
			} else {
				this.#frameUrls.delete(frameId);
			}
			this.#isolatedWorldContexts.delete(frameId);
			this.#frameNavigationRevisions.set(
				frameId,
				(this.#frameNavigationRevisions.get(frameId) ?? 0) + 1,
			);
			this.#notifyPageChanged();
		});
		this.connection.on("Page.frameDetached", (params, sessionId) => {
			if (sessionId !== this.sessionId) return;
			const { frameId } = params as { frameId?: unknown };
			if (typeof frameId === "string") this.#frameUrls.delete(frameId);
		});
		await this.#send("Page.enable");
		const frameTree = (
			await this.#send<{ frameTree: CdpFrameTree }>("Page.getFrameTree")
		).frameTree;
		this.#topFrameId = frameTree.frame.id;
		for (const [frameId, parentFrameId] of collectCdpFrameParentIds(
			frameTree,
		)) {
			this.#frameParentIds.set(frameId, parentFrameId);
		}
		for (const [frameId, frameUrl] of collectCdpFrameUrls(frameTree)) {
			this.#frameUrls.set(frameId, frameUrl);
		}
		await this.#send("Runtime.enable");
		await this.#send("DOM.enable", { includeWhitespace: "none" });
		await this.#send("Accessibility.enable");
		await this.#send("Network.enable");
		await this.#send("Network.setBypassServiceWorker", { bypass: true });
		await this.#send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
		await this.#send("Page.addScriptToEvaluateOnNewDocument", {
			source: BLOCK_BROWSER_ESCAPE_EXPRESSION,
		});
		await this.#evaluate(BLOCK_BROWSER_ESCAPE_EXPRESSION);
	}

	async #handlePausedRequest(paused: PausedRequest): Promise<void> {
		const unsafeRequest = !["GET", "HEAD", "OPTIONS"].includes(
			paused.request.method.toUpperCase(),
		);
		// The widget's own iframe loads as a `Document` request below the top
		// frame. Only a request known to come from a subframe may take that path,
		// so an unknown `frameId` keeps counting as the top frame.
		const subframeRequest =
			paused.frameId !== undefined && paused.frameId !== this.#topFrameId;
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
		let claimedSubmissionRequest = false;
		let submissionRelatedRequest =
			unsafeRequest && !verificationProviderRequest;
		try {
			if (!this.#targetDomain) {
				throw new Error(BROWSER_ERROR.DOMAIN_SCOPE_NOT_CONFIGURED);
			}
			const canContinueSubmissionRedirect =
				this.#submissionAttemptInProgress &&
				isAuthorizedSubmissionRedirect(
					paused,
					this.#submissionRedirectRequestIds,
					this.#expectedSubmissionFrameId,
				);
			const getSubmissionGuard = this.#getSubmissionGuard;
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
							this.#submissionRequestAllowed,
							this.#submissionRequestCount,
							this.#submissionRequestInFlight,
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
				this.#submissionRequestAllowed &&
				unsafeRequest &&
				!verificationProviderRequest;
			if (
				submissionWindowRequest &&
				this.#submissionRequestTotal >= MAX_SUBMISSION_REQUESTS
			) {
				blockStage = "request_limit";
				throw new BrowserElementError();
			}
			const canClaimSubmissionRequest =
				getSubmissionDisposition === "claim" || submissionWindowRequest;
			submissionRelatedRequest ||= canContinueSubmissionRedirect;
			const expectedNavigationRequest = this.#expectedNavigationRequest;
			const canClaimNavigationRequest =
				expectedNavigationRequest !== undefined &&
				!expectedNavigationRequest.claimed &&
				isExpectedNavigationDocumentRequest(
					paused.request,
					paused.resourceType,
					paused.frameId,
					expectedNavigationRequest,
				);
			if (canClaimNavigationRequest && expectedNavigationRequest) {
				expectedNavigationRequest.claimed = true;
			}
			blockStage = "network_policy";
			const allowedByVerificationProvider = assertAllowedBrowserRequest(
				paused.request.url,
				this.#targetDomain,
				paused.request.method,
				canClaimSubmissionRequest,
				!this.#formDataEntered && paused.resourceType !== "Document",
				(this.dryRun && this.#interactionStarted) ||
					shouldBlockNonSubmitRequest(
						this.#blockNonSubmitRequests,
						canClaimSubmissionRequest,
						canClaimNavigationRequest,
						canContinueSubmissionRedirect,
					),
				this.#allowedHosts,
				paused.resourceType,
				subframeRequest,
			);
			// Nothing above this point awaits, so the cap is read and spent in one
			// synchronous step even when several requests pause at once.
			if (canClaimSubmissionRequest) {
				this.#submissionRequestInFlight = true;
				this.#submissionRequestTotal += 1;
				this.#submissionRedirectRequestIds.add(paused.requestId);
				claimedSubmissionRequest = true;
			} else if (canContinueSubmissionRedirect) {
				this.#submissionRedirectRequestIds.add(paused.requestId);
			}
			await continueSubmissionRequest(
				() =>
					this.#send("Fetch.continueRequest", {
						requestId: paused.requestId,
					}),
				() => {
					if (allowedByVerificationProvider) {
						this.#verificationProviderRequestCount += 1;
					}
					if (!claimedSubmissionRequest) return;
					this.#submissionRequestCount += 1;
					this.#submissionRequestObserved?.();
				},
			);
		} catch {
			if (submissionRelatedRequest && this.#submissionAttemptInProgress) {
				this.#submissionRequestBlockStage ??= blockStage;
			}
			await this.#send("Fetch.failRequest", {
				requestId: paused.requestId,
				errorReason: "BlockedByClient",
			}).catch(() => undefined);
		} finally {
			if (claimedSubmissionRequest) this.#submissionRequestInFlight = false;
		}
	}

	async #waitForReadyState(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			let readyState: string;
			try {
				readyState = await this.#evaluate<string>("document.readyState");
			} catch (error) {
				// A closed connection never recovers, so waiting out the deadline
				// would only delay the run's own termination.
				if (isCdpConnectionUnusableError(error)) throw error;
				readyState = "loading";
			}
			if (readyState === "interactive" || readyState === "complete") return;
			await delay(100);
		}
		throw new Error(BROWSER_ERROR.PAGE_NOT_READY);
	}

	async #bodyText(): Promise<{ text: string; truncated: boolean }> {
		// One extra character makes the truncation detectable in the Worker
		// instead of trusting a value computed inside the page.
		return readPageText(
			await this.#evaluate<string>(
				`(document.body?.innerText ?? "").slice(0, ${MAX_PAGE_TEXT + 1})`,
			),
		);
	}

	async #confirmationBodyCount(frameId?: string): Promise<number> {
		const { root } = await this.#send<{ root: CdpDomNode }>("DOM.getDocument", {
			depth: -1,
			pierce: true,
		});
		let staleBodyCount = 0;
		const matches = await Promise.all(
			discoverCdpBodyBackendNodeIds(root, 20, frameId, this.#topFrameId).map(
				async (backendNodeId) => {
					try {
						return await this.#callFunctionOnElement<boolean>(
							backendNodeId,
							HAS_CONFIRMATION_TEXT_FUNCTION,
							[SUBMISSION_CONFIRMATION_PATTERN, SUBMISSION_PENDING_PATTERN],
						);
					} catch (error) {
						// A body discovered a moment ago can already be gone while the
						// page navigates. Counting it as non-matching keeps the bodies
						// that are still readable from failing the whole snapshot.
						if (!isTransientConfirmationReadError(error)) throw error;
						staleBodyCount += 1;
						return false;
					}
				},
			),
		);
		const matchingBodyCount = matches.filter(Boolean).length;
		console.log(
			JSON.stringify({
				event: "browser_confirmation_snapshot",
				bodyCount: matches.length,
				matchingBodyCount,
				staleBodyCount,
				frameScoped: frameId !== undefined,
			}),
		);
		return matchingBodyCount;
	}

	#notifyPageChanged(): void {
		for (const resolve of this.#pageChangeWaiters) resolve();
		this.#pageChangeWaiters.clear();
	}

	async #waitForPageChange(milliseconds: number): Promise<void> {
		let resolvePageChange: (() => void) | undefined;
		const pageChanged = new Promise<void>((resolve) => {
			resolvePageChange = resolve;
			this.#pageChangeWaiters.add(resolve);
		});
		try {
			await Promise.race([pageChanged, delay(milliseconds)]);
		} finally {
			if (resolvePageChange) this.#pageChangeWaiters.delete(resolvePageChange);
		}
	}

	#element(elementId: string): ElementReference {
		const reference = this.#elements.get(elementId);
		if (!reference) throw new BrowserElementError();
		return reference;
	}

	#clearElements(): void {
		this.#elements.clear();
		this.#successfulInputBackendNodeIds.clear();
		this.#expectedSubmissionRequest = undefined;
		this.#validatedSubmitInputBackendNodeId = undefined;
		this.#expectedSubmissionFrameId = undefined;
	}

	async #discoverForms(url: string): Promise<{
		discovery: CdpFormDiscovery;
		root: CdpDomNode;
		attempts: number;
	}> {
		for (let attempt = 1; attempt <= MAX_DOM_DISCOVERY_ATTEMPTS; attempt += 1) {
			const { root } = await this.#send<{ root: CdpDomNode }>(
				"DOM.getDocument",
				{ depth: -1, pierce: true },
			);
			const discovery = discoverCdpForms(root, url, this.#topFrameId);
			if (
				discovery.candidateFieldCount > 0 ||
				attempt === MAX_DOM_DISCOVERY_ATTEMPTS
			) {
				return { discovery, root, attempts: attempt };
			}
			await delay(DOM_DISCOVERY_RETRY_DELAY_MS);
		}
		throw new Error(BROWSER_ERROR.DOM_DISCOVERY_FAILED);
	}

	async #inspectElement(backendNodeId: number): Promise<ElementState> {
		return this.#callFunctionOnElement<ElementState>(
			backendNodeId,
			INSPECT_ELEMENT_FUNCTION,
		);
	}

	async #accessibleElement(
		backendNodeId: number,
	): Promise<{ name: string; role: string | null } | null> {
		const result = await this.#send<{ nodes: AxNode[] }>(
			"Accessibility.getPartialAXTree",
			{ backendNodeId, fetchRelatives: false },
		);
		const node = result.nodes.find(
			(candidate) => candidate.backendDOMNodeId === backendNodeId,
		);
		if (!node) return null;
		return {
			name:
				typeof node.name?.value === "string"
					? node.name.value.slice(0, 500)
					: "",
			role:
				typeof node.role?.value === "string"
					? node.role.value.slice(0, 100)
					: null,
		};
	}

	async #callFunctionOnElement<TResult>(
		backendNodeId: number,
		functionDeclaration: string,
		args: unknown[] = [],
		executionContextId?: number,
	): Promise<TResult> {
		const resolved = await this.#send<ResolvedNode>("DOM.resolveNode", {
			backendNodeId,
			objectGroup: "form-agent-elements",
			...(executionContextId === undefined ? {} : { executionContextId }),
		});
		const objectId = resolved.object.objectId;
		if (!objectId) throw new BrowserElementError();
		try {
			const result = await this.#send<EvaluateResult>(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration,
					arguments: args.map((value) => ({ value })),
					returnByValue: true,
				},
			);
			if (result.exceptionDetails) throw new BrowserElementError();
			return result.result.value as TResult;
		} finally {
			await this.#send("Runtime.releaseObject", { objectId }).catch(
				() => undefined,
			);
		}
	}

	/**
	 * Reads the prohibition reason codes of one candidate form, from the form
	 * itself and from the elements next to its frame owner on the embedding
	 * page. Both reads need an isolated world in the frame that holds the
	 * node, so they fail for a frame the driver cannot reach.
	 */
	async #formProhibitionReasonCodes(
		candidateForm: CdpFormCandidate,
		formFrameId: string,
		root: CdpDomNode,
	): Promise<string[]> {
		const formExecutionContextId =
			await this.#prohibitionExecutionContext(formFrameId);
		const formProhibitedReasonCodes = await this.#callFunctionOnElement<
			string[]
		>(
			candidateForm.backendNodeId,
			READ_FORM_PROHIBITION_REASON_CODES_FUNCTION,
			[],
			formExecutionContextId,
		);
		const frameOwnerBackendNodeId = candidateForm.frameId
			? findCdpFrameOwnerBackendNodeId(root, candidateForm.frameId)
			: undefined;
		const parentFrameId = candidateForm.frameId
			? this.#frameParentIds.get(candidateForm.frameId)
			: undefined;
		const parentExecutionContextId = parentFrameId
			? await this.#prohibitionExecutionContext(parentFrameId)
			: undefined;
		const parentProhibitedReasonCodes =
			frameOwnerBackendNodeId && parentExecutionContextId !== undefined
				? await this.#callFunctionOnElement<string[]>(
						frameOwnerBackendNodeId,
						READ_FORM_PROHIBITION_REASON_CODES_FUNCTION,
						[],
						parentExecutionContextId,
					)
				: [];
		return [
			...new Set([
				...formProhibitedReasonCodes,
				...parentProhibitedReasonCodes,
			]),
		];
	}

	/**
	 * Classifies the frame a candidate form sits in. `third_party` frames are
	 * verification widgets and other embeds outside the target domain and the
	 * job's allowed hosts: their forms are never submission targets, and CDP
	 * calls against their execution context fail, so the observation skips
	 * them. `unknown` covers frames whose URL the driver has not seen and
	 * frames that inherit the embedder's origin (`about:blank`, `srcdoc`);
	 * those are still observed.
	 */
	#observedFrameTrust(frameId: string | undefined): ObservedFrameTrust {
		if (frameId === undefined || frameId === this.#topFrameId) {
			return "trusted";
		}
		const targetDomain = this.#targetDomain;
		const frameUrl = this.#frameUrls.get(frameId);
		if (!targetDomain || frameUrl === undefined) return "unknown";
		try {
			// A target domain the policy cannot normalize would make every frame
			// look third party, so leave the judgement to the caller instead.
			normalizeTargetDomain(targetDomain);
		} catch {
			return "unknown";
		}
		try {
			assertAllowedTargetUrl(frameUrl, targetDomain, this.#allowedHosts);
			return "trusted";
		} catch {
			return /^https?:\/\//i.test(frameUrl) ? "third_party" : "unknown";
		}
	}

	async #prohibitionExecutionContext(frameId: string): Promise<number> {
		const existing = this.#isolatedWorldContexts.get(frameId);
		if (existing !== undefined) return existing;
		const { executionContextId } = await this.#send<{
			executionContextId: number;
		}>("Page.createIsolatedWorld", {
			frameId,
			worldName: "form-agent-prohibition",
			grantUniveralAccess: false,
		});
		this.#isolatedWorldContexts.set(frameId, executionContextId);
		return executionContextId;
	}

	async #callFunctionOnElementWithElementArgument<TResult>(
		backendNodeId: number,
		argumentBackendNodeId: number,
		functionDeclaration: string,
		args: unknown[] = [],
	): Promise<TResult> {
		const [resolved, argumentResolved] = await Promise.all([
			this.#send<ResolvedNode>("DOM.resolveNode", { backendNodeId }),
			this.#send<ResolvedNode>("DOM.resolveNode", {
				backendNodeId: argumentBackendNodeId,
			}),
		]);
		const objectId = resolved.object.objectId;
		const argumentObjectId = argumentResolved.object.objectId;
		if (!objectId || !argumentObjectId) {
			await Promise.all([
				objectId
					? this.#send("Runtime.releaseObject", { objectId }).catch(
							() => undefined,
						)
					: Promise.resolve(),
				argumentObjectId
					? this.#send("Runtime.releaseObject", {
							objectId: argumentObjectId,
						}).catch(() => undefined)
					: Promise.resolve(),
			]);
			throw new BrowserElementError();
		}
		try {
			const result = await this.#send<EvaluateResult>(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration,
					arguments: [
						{ objectId: argumentObjectId },
						...args.map((value) => ({ value })),
					],
					returnByValue: true,
				},
			);
			if (result.exceptionDetails) throw new BrowserElementError();
			return result.result.value as TResult;
		} finally {
			await Promise.all([
				this.#send("Runtime.releaseObject", { objectId }).catch(
					() => undefined,
				),
				this.#send("Runtime.releaseObject", {
					objectId: argumentObjectId,
				}).catch(() => undefined),
			]);
		}
	}

	async #replaceFocusedText(value: string): Promise<void> {
		await this.#send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Control",
			code: "ControlLeft",
			windowsVirtualKeyCode: 17,
			modifiers: 2,
		});
		await this.#send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			modifiers: 2,
		});
		await this.#send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			modifiers: 2,
		});
		await this.#send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Control",
			code: "ControlLeft",
			windowsVirtualKeyCode: 17,
		});
		await this.#send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Backspace",
			code: "Backspace",
			windowsVirtualKeyCode: 8,
		});
		await this.#send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Backspace",
			code: "Backspace",
			windowsVirtualKeyCode: 8,
		});
		await this.#send("Input.insertText", { text: value });
	}

	async #prepareMouseClick(
		backendNodeId: number,
		activationStrategy?: SubmitActivationStrategy,
		onAttempt?: (attempt: number) => void,
	): Promise<{ x: number; y: number }> {
		let stage: SubmitActivationStage = "scroll";
		const scrollIntoView = async () => {
			stage = "scroll";
			await this.#send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
		};
		const waitForNextFrame = async () => {
			stage = "retry_wait";
			await this.#nextAnimationFrame();
		};
		try {
			const prepare = async () => {
				stage = "box_model";
				const { model } = await this.#send<{
					model: { border: number[] };
				}>("DOM.getBoxModel", { backendNodeId });
				const point = centerOfQuad(model.border);
				if (!point) throw new BrowserElementError();
				stage = "pointer_move";
				await this.#send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: point.x,
					y: point.y,
				});
				stage = "hit_test";
				const hit = await this.#send<{ backendNodeId?: number }>(
					"DOM.getNodeForLocation",
					{
						x: point.x,
						y: point.y,
						includeUserAgentShadowDOM: true,
					},
				);
				if (
					!hit.backendNodeId ||
					!(await this.#isComposedDescendant(backendNodeId, hit.backendNodeId))
				) {
					throw new BrowserElementError();
				}
				return point;
			};
			if (!activationStrategy) {
				// A click target that is still settling reports no box model, a
				// missing or detached node, or a hit test that lands elsewhere, so
				// the whole preparation is repeated on the next frame instead of
				// ending the operation on the first refusal.
				return await retryMousePreparation(
					async () => {
						await scrollIntoView();
						return await prepare();
					},
					waitForNextFrame,
					{
						shouldRetry: isRetryableClickPreparationError,
						onRetry: (attempt, error) => {
							console.log(createClickPreparationRetryLog(attempt, error));
						},
					},
				);
			}
			await scrollIntoView();
			return await retrySubmitMousePreparation(
				prepare,
				waitForNextFrame,
				onAttempt,
			);
		} catch (error) {
			if (activationStrategy) {
				console.log(
					createSubmitActivationFailureLog(activationStrategy, stage),
				);
			}
			throw error;
		}
	}

	async #dispatchMouseClick(point: { x: number; y: number }): Promise<void> {
		await this.#dispatchMousePress(point);
		await this.#dispatchMouseRelease(point);
	}

	async #dispatchMousePress(point: { x: number; y: number }): Promise<void> {
		await this.#send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: point.x,
			y: point.y,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
	}

	async #dispatchMouseRelease(point: { x: number; y: number }): Promise<void> {
		await this.#send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: point.x,
			y: point.y,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
	}

	async #prepareEnterSubmitActivation(backendNodeId: number): Promise<void> {
		let stage: SubmitActivationStage = "scroll";
		try {
			await this.#send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
			stage = "render_before_check";
			await this.#nextAnimationFrame();
			stage = "unobscured_before_focus";
			if (
				!(await this.#callFunctionOnElement<boolean>(
					backendNodeId,
					IS_SUBMIT_UNOBSCURED_FUNCTION,
				))
			) {
				throw new BrowserElementError();
			}
			stage = "focus";
			await this.#send("DOM.focus", { backendNodeId });
			stage = "render_after_focus";
			await this.#nextAnimationFrame();
			stage = "post_focus_checks";
			const [unobscured, focused] = await Promise.all([
				this.#callFunctionOnElement<boolean>(
					backendNodeId,
					IS_SUBMIT_UNOBSCURED_FUNCTION,
				),
				this.#callFunctionOnElement<boolean>(
					backendNodeId,
					IS_ELEMENT_FOCUSED_FUNCTION,
				),
			]);
			if (!unobscured) {
				stage = "unobscured_after_focus";
				throw new BrowserElementError();
			}
			if (!focused) {
				stage = "focus_retained";
				throw new BrowserElementError();
			}
		} catch (error) {
			console.log(createSubmitActivationFailureLog("enter", stage));
			throw error;
		}
	}

	async #activateSubmitElement(
		backendNodeId: number,
		activationStrategy: SubmitActivationStrategy,
	): Promise<void> {
		console.log(
			JSON.stringify({
				event: "browser_submit_activation_prepare",
				activationStrategy,
			}),
		);
		if (activationStrategy === "dom") {
			const inputBackendNodeId = this.#validatedSubmitInputBackendNodeId;
			const expectedRequest = this.#expectedSubmissionRequest;
			if (!expectedRequest) {
				throw new BrowserElementError();
			}
			await this.#activatePreparedSubmit(async () => {
				// A later stage of the same submission runs on a confirmation
				// screen, where no field of this run survives. The control is then
				// activated on its own; the action and method are still compared
				// against what `validateSubmit` inspected.
				const activated = inputBackendNodeId
					? await this.#callFunctionOnElementWithElementArgument<boolean>(
							backendNodeId,
							inputBackendNodeId,
							ACTIVATE_SUBMIT_FUNCTION,
							[expectedRequest.url, expectedRequest.method],
						)
					: await this.#callFunctionOnElement<boolean>(
							backendNodeId,
							ACTIVATE_SUBMIT_FUNCTION,
							[null, expectedRequest.url, expectedRequest.method],
						);
				if (!activated) throw new BrowserElementError();
			}, "dom");
			return;
		}
		if (activationStrategy === "mouse") {
			let hitTestAttempts = 0;
			const point = await this.#prepareMouseClick(
				backendNodeId,
				"mouse",
				(attempt) => {
					hitTestAttempts = attempt;
				},
			);
			await this.#activatePreparedSubmit(
				() => this.#dispatchMouseClick(point),
				"mouse",
				hitTestAttempts,
			);
			return;
		}
		await this.#prepareEnterSubmitActivation(backendNodeId);
		await this.#activatePreparedSubmit(
			() =>
				this.#send("Input.dispatchKeyEvent", ENTER_KEY_DOWN_EVENT).then(() =>
					this.#nextAnimationFrame().catch(() => undefined),
				),
			"enter",
		);
	}

	async #activatePreparedSubmit(
		activate: () => Promise<unknown>,
		activationStrategy: SubmitActivationStrategy,
		hitTestAttempts?: number,
	): Promise<void> {
		const startedAt = Date.now();
		let resolveSubmissionRequestObserved: () => void = () => undefined;
		const submissionRequestObserved = new Promise<void>((resolve) => {
			resolveSubmissionRequestObserved = resolve;
		});
		this.#submissionRequestCount = 0;
		this.#submissionRequestInFlight = false;
		this.#submissionRequestObserved = resolveSubmissionRequestObserved;
		this.#submissionRequestAllowed = true;
		try {
			await runSubmissionActivationWithinPermissionWindow(
				activate,
				submissionRequestObserved,
			);
		} catch (error) {
			console.log(
				createSubmitActivationFailureLog(activationStrategy, "dispatch"),
			);
			throw error;
		} finally {
			this.#submissionRequestAllowed = false;
			this.#submissionRequestObserved = undefined;
			resolveSubmissionRequestObserved();
			console.log(
				JSON.stringify({
					event: "browser_submit_activation",
					activationStrategy,
					requestObserved: this.#submissionRequestCount > 0,
					durationMs: Date.now() - startedAt,
					...(hitTestAttempts === undefined ? {} : { hitTestAttempts }),
				}),
			);
		}
		if (activationStrategy === "enter") {
			await this.#send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
			}).catch(() => undefined);
		}
	}

	#nextAnimationFrame(): Promise<unknown> {
		return this.#evaluate(
			"new Promise((resolve) => requestAnimationFrame(() => resolve()))",
		);
	}

	async #isComposedDescendant(
		ancestorBackendNodeId: number,
		candidateBackendNodeId: number,
	): Promise<boolean> {
		if (ancestorBackendNodeId === candidateBackendNodeId) return true;
		const [ancestor, candidate] = await Promise.all([
			this.#send<ResolvedNode>("DOM.resolveNode", {
				backendNodeId: ancestorBackendNodeId,
				objectGroup: "form-agent-hit-test",
			}),
			this.#send<ResolvedNode>("DOM.resolveNode", {
				backendNodeId: candidateBackendNodeId,
				objectGroup: "form-agent-hit-test",
			}),
		]);
		const ancestorObjectId = ancestor.object.objectId;
		const candidateObjectId = candidate.object.objectId;
		if (!ancestorObjectId || !candidateObjectId)
			throw new BrowserElementError();
		try {
			const result = await this.#send<EvaluateResult>(
				"Runtime.callFunctionOn",
				{
					objectId: ancestorObjectId,
					functionDeclaration: IS_COMPOSED_DESCENDANT_FUNCTION,
					arguments: [{ objectId: candidateObjectId }],
					returnByValue: true,
				},
			);
			if (result.exceptionDetails) throw new BrowserElementError();
			return result.result.value === true;
		} finally {
			await Promise.all([
				this.#send("Runtime.releaseObject", {
					objectId: ancestorObjectId,
				}).catch(() => undefined),
				this.#send("Runtime.releaseObject", {
					objectId: candidateObjectId,
				}).catch(() => undefined),
			]);
		}
	}

	async #evaluate<TResult>(expression: string): Promise<TResult> {
		const result = await this.#send<EvaluateResult>("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			throw new Error(BROWSER_ERROR.PAGE_EVALUATION_FAILED);
		}
		return result.result.value as TResult;
	}

	#send<TResult = unknown>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<TResult> {
		if (this.#targetPolicyError) {
			return Promise.reject(this.#targetPolicyError);
		}
		return this.connection.send<TResult>(method, params, this.sessionId);
	}
}

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

function canonicalHttpRequestUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.hash = "";
	return url.toString();
}

export function createSubmitActivationFailureLog(
	activationStrategy: SubmitActivationStrategy,
	stage: SubmitActivationStage,
): string {
	return JSON.stringify({
		event: "browser_submit_activation_failure",
		activationStrategy,
		stage,
	});
}

export interface MousePreparationRetryOptions {
	/** Decides whether a preparation failure is worth another frame. */
	shouldRetry(error: unknown): boolean;
	onAttempt?(attempt: number): void;
	onRetry?(attempt: number, error: unknown): void;
}

export async function retryMousePreparation<TResult>(
	prepare: () => Promise<TResult>,
	waitForNextFrame: () => Promise<unknown>,
	options: MousePreparationRetryOptions,
): Promise<TResult> {
	for (
		let attempt = 1;
		attempt <= MAX_MOUSE_PREPARATION_ATTEMPTS;
		attempt += 1
	) {
		options.onAttempt?.(attempt);
		try {
			return await prepare();
		} catch (error) {
			if (
				attempt === MAX_MOUSE_PREPARATION_ATTEMPTS ||
				!options.shouldRetry(error)
			) {
				throw error;
			}
			options.onRetry?.(attempt, error);
			await waitForNextFrame();
		}
	}
	throw new BrowserElementError();
}

export function retrySubmitMousePreparation<TResult>(
	prepare: () => Promise<TResult>,
	waitForNextFrame: () => Promise<unknown>,
	onAttempt: (attempt: number) => void = () => undefined,
): Promise<TResult> {
	return retryMousePreparation(prepare, waitForNextFrame, {
		shouldRetry: (error) => error instanceof BrowserElementError,
		onAttempt,
	});
}

const RETRYABLE_CLICK_PREPARATION_KINDS: ReadonlySet<CdpCommandErrorKind> =
	new Set<CdpCommandErrorKind>([
		"NO_BOX_MODEL",
		"NODE_NOT_FOUND",
		"NODE_DETACHED",
		"NO_EXECUTION_CONTEXT",
		// The exact provider messages that NO_EXECUTION_CONTEXT used to catch as
		// a broad match are now classified into these two specific kinds; keep
		// them retryable so the settling-layout behavior is unchanged.
		"CONTEXT_NOT_FOUND",
		"CONTEXT_DESTROYED",
		"NO_NODE_AT_LOCATION",
	]);

export type ClickPreparationRetryKind = CdpCommandErrorKind | "HIT_TEST";

/**
 * A layout that has not settled reports the click target as missing, detached,
 * without a box model or without an execution context, and its hit test lands
 * on a node that is about to move. Those clear on the next frame. Every other
 * refusal describes the element itself and is reported straight away.
 */
export function isRetryableClickPreparationError(error: unknown): boolean {
	if (error instanceof BrowserUseCdpCommandError) {
		return RETRYABLE_CLICK_PREPARATION_KINDS.has(error.kind);
	}
	return error instanceof BrowserElementError;
}

export function clickPreparationRetryKind(
	error: unknown,
): ClickPreparationRetryKind {
	return error instanceof BrowserUseCdpCommandError ? error.kind : "HIT_TEST";
}

export function createClickPreparationRetryLog(
	attempt: number,
	error: unknown,
): string {
	return JSON.stringify({
		event: "browser_click_preparation_retry",
		attempt,
		kind: clickPreparationRetryKind(error),
	});
}

export async function runSubmissionActivationWithinPermissionWindow(
	activate: () => Promise<unknown>,
	submissionRequestObserved: Promise<unknown>,
	wait: (milliseconds: number) => Promise<void> = delay,
): Promise<void> {
	const permissionDeadline = wait(SUBMISSION_PERMISSION_WINDOW_MS);
	const activation = activate();
	void activation.catch(() => undefined);
	await Promise.race([
		activation.then(() => submissionRequestObserved),
		permissionDeadline,
	]);
}

export async function continueSubmissionRequest(
	continueRequest: () => Promise<unknown>,
	recordObserved: () => void,
): Promise<void> {
	await continueRequest();
	recordObserved();
}

/**
 * The CDP failures a document or a frame answers with while it is navigating,
 * which is exactly the moment the confirmation is read in. A fresh
 * `DOM.getDocument` on the next poll rediscovers the bodies, so a read that
 * fails this way is not yet an answer about the submission.
 */
const TRANSIENT_CONFIRMATION_READ_KINDS: ReadonlySet<CdpCommandErrorKind> =
	new Set([
		"NODE_NOT_FOUND",
		"NODE_DETACHED",
		"CONTEXT_NOT_FOUND",
		"CONTEXT_DESTROYED",
		"NO_EXECUTION_CONTEXT",
		"FRAME_NOT_FOUND",
		"TARGET_NAVIGATED",
	]);

export function isTransientConfirmationReadError(
	error: unknown,
): error is BrowserUseCdpCommandError {
	return (
		error instanceof BrowserUseCdpCommandError &&
		TRANSIENT_CONFIRMATION_READ_KINDS.has(error.kind)
	);
}

/**
 * The confirmation could not be read yet. It carries only the failing CDP
 * method and its fixed kind, never page text, and never means the submission
 * itself failed or succeeded.
 */
export class ConfirmationReadPendingError extends Error {
	readonly cdpMethod: string;
	readonly cdpKind: CdpCommandErrorKind;

	constructor(readonly cause: BrowserUseCdpCommandError) {
		super("The submission confirmation could not be read yet");
		this.name = "ConfirmationReadPendingError";
		this.cdpMethod = cause.method;
		this.cdpKind = cause.kind;
	}
}

/**
 * Reads one confirmation snapshot. A read that failed only because the page
 * was mid-navigation raises `ConfirmationReadPendingError`, which asks the
 * caller to poll again; every other failure stays the diagnostic error the
 * submission ends on.
 */
export async function readSubmissionConfirmation(
	beforeCount: number,
	requestObserved: boolean,
	readAfterCount: () => Promise<number>,
	readCurrentUrl: () => Promise<string>,
	documentUpdatedSinceSubmit = false,
): Promise<BrowserSubmitResult | null> {
	let afterCount: number;
	try {
		afterCount = await readAfterCount();
	} catch (error) {
		if (isTransientConfirmationReadError(error))
			throw new ConfirmationReadPendingError(error);
		throw createBrowserSubmitDiagnosticError("SUBMIT_READ_AFTER_TEXT", error);
	}
	if (
		!requestObserved ||
		(afterCount <= beforeCount &&
			!(documentUpdatedSinceSubmit && afterCount > 0))
	)
		return null;
	try {
		return { outcome: "sent", formUrl: await readCurrentUrl() };
	} catch (error) {
		throw createBrowserSubmitDiagnosticError("POST_SUBMIT_URL_CHECK", error);
	}
}

/**
 * Polls for the confirmation until the deadline. A read the page was too busy
 * navigating to answer is retried on the next poll instead of ending the
 * submission, because one second later the completion page is usually there.
 * Only a read still failing that way after the deadline becomes the
 * `SUBMIT_READ_AFTER_TEXT` diagnostic an operator sees, so the outcome is
 * unchanged when the page never became readable at all.
 */
export async function waitForSubmissionConfirmation(
	readConfirmation: () => Promise<BrowserSubmitResult | null>,
	waitForChange: (milliseconds: number) => Promise<void>,
	timeoutMs = SUBMISSION_CONFIRMATION_TIMEOUT_MS,
	now: () => number = Date.now,
): Promise<BrowserSubmitResult | null> {
	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		await waitForChange(
			Math.min(CONFIRMATION_POLL_INTERVAL_MS, deadline - now()),
		);
		let confirmation: BrowserSubmitResult | null;
		try {
			confirmation = await readConfirmation();
		} catch (error) {
			if (!(error instanceof ConfirmationReadPendingError)) throw error;
			console.log(
				JSON.stringify({
					event: "browser_confirmation_read_retry",
					method: error.cdpMethod,
					kind: error.cdpKind,
				}),
			);
			continue;
		}
		if (confirmation) return confirmation;
	}
	try {
		return await readConfirmation();
	} catch (error) {
		if (error instanceof ConfirmationReadPendingError)
			throw createBrowserSubmitDiagnosticError(
				"SUBMIT_READ_AFTER_TEXT",
				error.cause,
			);
		throw error;
	}
}

export function hasExpectedFrameNavigated(
	expectedFrameId: string | undefined,
	revisionBeforeSubmit: number,
	frameNavigationRevisions: ReadonlyMap<string, number>,
): boolean {
	return (
		expectedFrameId !== undefined &&
		(frameNavigationRevisions.get(expectedFrameId) ?? 0) > revisionBeforeSubmit
	);
}

export type RadioSelectionOutcome =
	| "selected"
	| "not_candidate"
	| "higher_priority_exists";

/**
 * The radio page function may only answer with one of three fixed tokens. Any
 * other value means the page answered for itself, which is never trusted.
 */
export function readRadioSelectionOutcome(
	value: unknown,
): RadioSelectionOutcome {
	if (
		value === "selected" ||
		value === "not_candidate" ||
		value === "higher_priority_exists"
	) {
		return value;
	}
	throw new BrowserElementError();
}

/**
 * Reads the intended checkbox state from the candidate list. The first
 * candidate that names a state wins, which keeps the candidate order the only
 * rule for every choice control. `undefined` means the list names no state and
 * the control's own value or label has to decide.
 */
export function desiredCheckboxState(
	candidates: readonly string[],
): boolean | undefined {
	for (const candidate of candidates) {
		if (candidate === "checked" || candidate === "true") return true;
		if (candidate === "unchecked" || candidate === "false") return false;
	}
	return undefined;
}

/** A CDP connection in this state cannot carry another command. */
export function isCdpConnectionUnusableError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === BROWSER_ERROR.CDP_CONNECTION_IS_CLOSED ||
			error.message === BROWSER_ERROR.CDP_CONNECTION_CLOSED ||
			error.message === BROWSER_ERROR.CDP_COMMAND_NOT_SENT)
	);
}

export function isPageNotReadyError(error: unknown): boolean {
	return (
		error instanceof Error && error.message === BROWSER_ERROR.PAGE_NOT_READY
	);
}

export function assertDryRunNavigationAllowed(
	dryRun: boolean,
	navigationCount: number,
): void {
	if (dryRun && navigationCount > 0) throw new BrowserElementError();
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
 * Splits the raw body text into the value the model may see and a flag saying
 * whether the page held more. Truncation is decided in the Worker so that an
 * untrusted page cannot claim its text was complete.
 */
export interface FormSnapshotElement {
	ok: boolean;
	tag: string;
	type: string;
	name: string | null;
	value: string;
	checked: boolean;
	disabled: boolean;
}

/**
 * Canonical string for one form's controls, in DOM order. Password values are
 * masked, and an element that no longer resolves becomes null so that its
 * disappearance still changes the snapshot.
 */
export function toFormSnapshot(
	states: ReadonlyArray<FormSnapshotElement | null>,
): string {
	return JSON.stringify(
		states.map((state) =>
			state?.ok
				? [
						state.tag,
						state.type || "",
						state.name ?? "",
						state.type === "password" ? "" : state.value,
						state.checked,
						state.disabled,
					]
				: null,
		),
	);
}

/**
 * Narrows one inspected element to the state the pre-submit comparison uses,
 * or null when the element is not comparable (unusable, or a submit control
 * whose activation is what `submit` does).
 */
export function toObservedFieldState(
	elementId: string,
	state: {
		ok: boolean;
		tag: string;
		type: string;
		value: string;
		checked: boolean;
		submitLike: boolean;
	},
): ObservedFieldState | null {
	if (!state.ok || state.submitLike) return null;
	if (!isReviewComparableField(state.tag, state.type || null)) return null;
	return {
		elementId,
		value: state.type === "password" ? "" : state.value,
		checked: state.checked,
	};
}

export function readPageText(raw: string): {
	text: string;
	truncated: boolean;
} {
	return raw.length > MAX_PAGE_TEXT
		? { text: raw.slice(0, MAX_PAGE_TEXT), truncated: true }
		: { text: raw, truncated: false };
}

export function submitUncertainReasonCode(
	activationStrategy: SubmitActivationStrategy,
	requestObserved: boolean,
	blockStage?: SubmissionRequestBlockStage,
): string {
	// Reported ahead of everything else: a request of this submission was
	// refused because the run had spent its budget, so an earlier observed
	// request does not make the submission complete.
	if (blockStage === "request_limit") {
		return "SUBMIT_REQUEST_LIMIT_REACHED";
	}
	if (requestObserved) {
		return "SUBMIT_CONFIRMATION_NOT_OBSERVED";
	}
	if (blockStage === "expected_request") {
		return "SUBMIT_EXPECTED_REQUEST_BLOCKED";
	}
	if (blockStage === "network_policy") {
		return "SUBMIT_NETWORK_POLICY_BLOCKED";
	}
	if (activationStrategy === "dom") return "SUBMIT_DOM_REQUEST_NOT_OBSERVED";
	if (activationStrategy === "mouse")
		return "SUBMIT_MOUSE_REQUEST_NOT_OBSERVED";
	return "SUBMIT_ENTER_REQUEST_NOT_OBSERVED";
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

export function centerOfQuad(quad: number[]): { x: number; y: number } | null {
	if (quad.length !== 8 || !quad.every(Number.isFinite)) return null;
	const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
	if (
		x1 === undefined ||
		y1 === undefined ||
		x2 === undefined ||
		y2 === undefined ||
		x3 === undefined ||
		y3 === undefined ||
		x4 === undefined ||
		y4 === undefined
	) {
		return null;
	}
	return {
		x: Math.round((x1 + x2 + x3 + x4) / 4),
		y: Math.round((y1 + y2 + y3 + y4) / 4),
	};
}

function isFillable(tag: string, type: string): boolean {
	if (tag === "textarea") return true;
	return (
		tag === "input" &&
		![
			"button",
			"checkbox",
			"file",
			"hidden",
			"image",
			"radio",
			"reset",
			"submit",
		].includes(type)
	);
}

export function isPayloadIndependentClickTarget(
	tag: string,
	type: string,
): boolean {
	return tag === "button" && type === "button";
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
