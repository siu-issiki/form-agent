import {
	assertAllowedBrowserRequest,
	isVerificationProviderRequest,
	isVerificationProviderUrl,
} from "./browser-network-policy";
import { SUBMISSION_CONFIRMATION_PATTERN } from "./browser-submit-confirmation";
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
	PROHIBITION_TEXT_PATTERN_SOURCES,
	type RestrictedBrowserDriver,
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
const MAX_MOUSE_PREPARATION_ATTEMPTS = 3;
const READY_STATE_TIMEOUT_MS = 10_000;
/**
 * The first navigation of a run pays for the cold start of the page and its
 * render-blocking subresources, so it waits longer and is retried once. Later
 * navigations keep the short wait: by then the site is warm and a stalled load
 * is a signal the model should act on instead of waiting out.
 */
const BOOTSTRAP_READY_STATE_TIMEOUT_MS = 25_000;
/** The CDP connection reports a per-command error response with this message. */
const CDP_COMMAND_FAILED_MESSAGE = "Browser Use CDP command failed";
const CONNECT_RETRY_DELAYS_MS = [10_000, 20_000, 30_000];
/**
 * The run deadline is 10 minutes and the termination grace is 30 seconds, so a
 * 12 minute provider timeout only acts as a backstop when the explicit stop
 * never reaches the provider.
 */
const SESSION_TIMEOUT_MINUTES = 12;

const RETRYABLE_CONNECT_ERROR_MESSAGES = new Set([
	"Browser Use CDP connection failed",
	"Browser Use CDP connection closed",
	"Browser Use CDP connection is closed",
	"Browser Use CDP command timed out",
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
	return new Error("Browser Use CDP connection aborted");
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
		case "Browser Use CDP connection failed":
			return { reason: "CDP_CONNECTION_FAILED" };
		case "Browser Use CDP connection is closed":
		case "Browser Use CDP connection closed":
			return { reason: "CDP_CONNECTION_CLOSED" };
		case "Browser Use CDP command timed out":
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

interface TargetInfo {
	targetId: string;
	type: string;
	url?: string;
}

interface AttachedTarget {
	sessionId: string;
	targetInfo: TargetInfo;
	waitingForDebugger: boolean;
}

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

type SubmissionRequestBlockStage = "expected_request" | "network_policy";
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
	#submissionRedirectRequestId: string | undefined;
	#submissionRequestCount = 0;
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
		if (!apiKey) throw new Error("Browser Use API key is required");
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
					"Browser Use did not return an active session with a CDP URL",
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
			throw new Error("Browser domain scope cannot be changed");
		}
		const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
		if (
			this.#targetDomain &&
			JSON.stringify(this.#allowedHosts) !==
				JSON.stringify(normalizedAllowedHosts)
		) {
			throw new Error("Browser host scope cannot be changed");
		}
		this.#targetDomain ??= targetDomain;
		this.#allowedHosts = normalizedAllowedHosts;
	}

	currentUrl(): Promise<string> {
		return this.#evaluate<string>("location.href");
	}

	captureScreenshot(): Promise<Uint8Array> {
		return captureCdpScreenshot((params) =>
			this.#send<CdpScreenshotResult>("Page.captureScreenshot", params),
		);
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
			if (result.errorText) throw new Error("Browser navigation failed");
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
				error.message !== CDP_COMMAND_FAILED_MESSAGE
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

	async validateSubmit(elementId: string): Promise<void> {
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
		if (!hasInputInSubmitForm) throw new BrowserElementError();
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
	): Promise<BrowserSubmitResult> {
		try {
			await this.validateSubmit(elementId);
		} catch (error) {
			throw createBrowserSubmitDiagnosticError("SUBMIT_VALIDATE", error);
		}
		this.#blockNonSubmitRequests = true;
		this.#submissionRedirectRequestId = undefined;
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
				throw new Error("Browser domain scope is not configured");
			}
			let expectedSubmissionRequest = false;
			const canContinueSubmissionRedirect =
				this.#submissionAttemptInProgress &&
				isAuthorizedSubmissionRedirect(
					paused,
					this.#submissionRedirectRequestId,
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
			if (getSubmissionDisposition === "claim") {
				expectedSubmissionRequest = true;
			}
			if (this.#submissionRequestAllowed && !verificationProviderRequest) {
				if (unsafeRequest) {
					blockStage = "expected_request";
					assertExpectedSubmissionRequest(
						paused.request,
						this.#expectedSubmissionRequest,
					);
					expectedSubmissionRequest = true;
				}
			}
			const canClaimSubmissionRequest =
				expectedSubmissionRequest &&
				this.#submissionRequestCount === 0 &&
				!this.#submissionRequestInFlight;
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
			if (canClaimSubmissionRequest) {
				this.#submissionRequestInFlight = true;
				this.#submissionRedirectRequestId = paused.requestId;
				claimedSubmissionRequest = true;
			} else if (canContinueSubmissionRedirect) {
				this.#submissionRedirectRequestId = paused.requestId;
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
		throw new Error("Browser page did not become ready");
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
		const matches = await Promise.all(
			discoverCdpBodyBackendNodeIds(root, 20, frameId, this.#topFrameId).map(
				(backendNodeId) =>
					this.#callFunctionOnElement<boolean>(
						backendNodeId,
						HAS_CONFIRMATION_TEXT_FUNCTION,
						[SUBMISSION_CONFIRMATION_PATTERN],
					),
			),
		);
		const matchingBodyCount = matches.filter(Boolean).length;
		console.log(
			JSON.stringify({
				event: "browser_confirmation_snapshot",
				bodyCount: matches.length,
				matchingBodyCount,
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
		throw new Error("Browser DOM discovery failed");
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
			if (!inputBackendNodeId || !expectedRequest) {
				throw new BrowserElementError();
			}
			await this.#activatePreparedSubmit(async () => {
				const activated =
					await this.#callFunctionOnElementWithElementArgument<boolean>(
						backendNodeId,
						inputBackendNodeId,
						ACTIVATE_SUBMIT_FUNCTION,
						[expectedRequest.url, expectedRequest.method],
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
			throw new Error("Browser page evaluation failed");
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
	previousRequestId: string | undefined,
	expectedFrameId: string | undefined,
): boolean {
	return (
		previousRequestId !== undefined &&
		paused.redirectedRequestId === previousRequestId &&
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

export interface CdpScreenshotResult {
	data?: string;
}

export const SCREENSHOT_PARAMS = {
	format: "jpeg",
	quality: 80,
	captureBeyondViewport: false,
	fromSurface: true,
} as const;

/**
 * Captures only the currently visible viewport as JPEG. A payload that
 * exceeds the CDP message limit closes the underlying connection, so there is
 * no connection left to retry against; every failure is reported as the same
 * opaque error so that no page content leaks through the message.
 */
export async function captureCdpScreenshot(
	send: (params: Record<string, unknown>) => Promise<CdpScreenshotResult>,
): Promise<Uint8Array> {
	let result: CdpScreenshotResult;
	try {
		result = await send({ ...SCREENSHOT_PARAMS });
	} catch {
		throw new Error("Browser screenshot failed");
	}

	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(result.data ?? "");
	} catch {
		throw new Error("Browser screenshot failed");
	}
	if (bytes.byteLength === 0) {
		throw new Error("Browser screenshot failed");
	}
	return bytes;
}

export function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
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
		const confirmation = await readConfirmation();
		if (confirmation) return confirmation;
	}
	return readConfirmation();
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
		(error.message === "Browser Use CDP connection is closed" ||
			error.message === "Browser Use CDP connection closed" ||
			error.message === "Browser Use CDP command could not be sent")
	);
}

export function isPageNotReadyError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message === "Browser page did not become ready"
	);
}

export function assertDryRunNavigationAllowed(
	dryRun: boolean,
	navigationCount: number,
): void {
	if (dryRun && navigationCount > 0) throw new BrowserElementError();
}

/** Counters the driver keeps for the targets this policy let through. */
export interface RelatedBrowserTargetHooks {
	/** A verification widget iframe target was kept open. */
	readonly onVerificationFrame?: () => void;
	/** A request inside such an iframe was continued. */
	readonly onVerificationRequest?: () => void;
}

const AUTO_ATTACH_PARAMS = {
	autoAttach: true,
	waitForDebuggerOnStart: true,
	flatten: true,
};

/**
 * Closes every browser target the run does not need, and keeps the one kind it
 * does: the out-of-process iframe Chrome creates for a verification widget.
 * Site isolation puts `https://www.google.com/recaptcha/api2/anchor` and the
 * hCaptcha / Turnstile equivalents in their own target, so closing them made
 * the widget report "cannot connect" even with the host allowlist in place.
 *
 * A kept target is policed the same way the page is: `Fetch` intercepts every
 * request in it and only the allowlist passes, nested targets auto-attach into
 * this same handler, and the escape blocker runs before the widget's own
 * scripts so `WebSocket` / `Worker` cannot route around `Fetch`. The iframe is
 * cross-origin, so it can neither read the page's DOM nor read back what it
 * posts to its own origin; a `window.top.location` navigation from inside it is
 * still a top-frame `Document` request and stays blocked by the request policy.
 *
 * An iframe target is never closed. `Target.closeTarget` on an out-of-process
 * iframe closes the page that owns it, which took the run's own session with
 * it: every following command answered "Session with given id not found". Only
 * a target of another type (a popup page, a worker) is closed, since it owns no
 * page the run needs.
 *
 * The rule for an iframe is instead: run it only under the whole restriction
 * set, and stop its content when the set does not land. Detaching alone is not
 * a stop. The `waitForDebuggerOnStart` pause is a browser-side hold on the
 * frame's navigation, and Chrome releases such a hold when the session that
 * owns it goes away, so a detached frame would go on to run unrestricted. See
 * `stopVerificationProviderFrame` for what a stop actually does.
 */
export async function denyRelatedBrowserTargets(
	connection: Pick<BrowserUseCdpConnection, "on" | "send">,
	parentSessionId: string,
	onPolicyFailure: (error: Error) => void,
	hooks: RelatedBrowserTargetHooks = {},
): Promise<void> {
	// Sessions of the verification iframes kept open, so their paused requests
	// are told apart from the page's own and judged by the allowlist alone.
	const verificationSessions = new Set<string>();
	// Sessions whose frame is on its way out. Nothing is continued for them, so
	// a frame being stopped makes no further request even while the stop is in
	// flight and even when the URL is on the allowlist.
	const stoppedSessions = new Set<string>();
	const stopFrame = (
		sessionId: string,
		reason: VerificationFrameStopReason,
		paused: boolean,
	) => {
		stoppedSessions.add(sessionId);
		void stopVerificationProviderFrame(connection, sessionId, reason, paused);
	};
	const closeTarget = (targetId: string) => {
		void connection
			.send<{ success: boolean }>("Target.closeTarget", { targetId })
			.then((result) => {
				if (!result.success) {
					onPolicyFailure(
						new Error("A related browser target could not be closed"),
					);
				}
			})
			.catch(() => {
				onPolicyFailure(
					new Error("A related browser target could not be closed"),
				);
			});
	};

	connection.on("Fetch.requestPaused", (params, sessionId) => {
		if (
			sessionId === undefined ||
			!(verificationSessions.has(sessionId) || stoppedSessions.has(sessionId))
		) {
			return;
		}
		const paused = params as PausedRequest;
		// Inside the widget's own frame a `Document` request is the widget, not a
		// page navigation, so subframe `Document` requests may pass the allowlist.
		const allowed =
			!stoppedSessions.has(sessionId) &&
			isVerificationProviderRequest(
				paused.request.url,
				paused.request.method,
				paused.resourceType,
				true,
			);
		if (!allowed) {
			void connection
				.send(
					"Fetch.failRequest",
					{ requestId: paused.requestId, errorReason: "BlockedByClient" },
					sessionId,
				)
				.catch(() => undefined);
			return;
		}
		void connection
			.send("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
			.then(() => {
				hooks.onVerificationRequest?.();
			})
			.catch(() => undefined);
	});

	connection.on("Target.attachedToTarget", (params, sessionId) => {
		if (
			sessionId !== parentSessionId &&
			(sessionId === undefined || !verificationSessions.has(sessionId))
		) {
			return;
		}
		const attached = params as AttachedTarget;
		const paused = attached.waitingForDebugger;
		if (attached.targetInfo.type !== "iframe") {
			// A popup page or a worker owns no page the run needs, so closing it is
			// both the stop and the denial.
			if (!paused) {
				onPolicyFailure(new Error("A related browser target was not paused"));
			}
			closeTarget(attached.targetInfo.targetId);
			return;
		}
		if (!paused) {
			// Interception could not be installed before this frame started, so the
			// run is failed either way. The restrictions are still attempted, since
			// a frame under them is better than one running loose until the run ends.
			onPolicyFailure(new Error("A related browser target was not paused"));
		}
		// The allowlist decides on its own, whether or not the frame was paused:
		// a frame that started early is no more trusted than one that did not.
		if (!isVerificationProviderUrl(attached.targetInfo.url ?? "")) {
			// The page's own request policy blocks a subframe `Document` outside the
			// allowlist, so no such target should appear. Stopped, not trusted.
			stopFrame(attached.sessionId, "NOT_ALLOWLISTED", paused);
			return;
		}
		// Registered before the first command so that any request this session
		// pauses is judged by the allowlist, including during a stop.
		verificationSessions.add(attached.sessionId);
		void runVerificationProviderFrame(connection, attached.sessionId, paused)
			// Every command is judged on its own, so a rejection here is not
			// expected; it is read as "not running" rather than left unhandled.
			.catch(() => false)
			.then((running) => {
				if (!running) {
					stopFrame(
						attached.sessionId,
						paused ? "RESTRICTION_FAILED" : "NOT_PAUSED",
						paused,
					);
					return;
				}
				// Counted only for a frame that was released under the full
				// restriction set, so the log matches what the widget got.
				if (paused) hooks.onVerificationFrame?.();
			});
	});
	await connection.send(
		"Target.setAutoAttach",
		AUTO_ATTACH_PARAMS,
		parentSessionId,
	);
}

/**
 * The reason a verification frame's content was stopped. Fixed values only.
 */
export type VerificationFrameStopReason =
	/** One of the restrictions the frame may only run under did not land. */
	| "RESTRICTION_FAILED"
	/** The frame was already running when it attached. */
	| "NOT_PAUSED"
	/** The frame's URL is not on the verification provider allowlist. */
	| "NOT_ALLOWLISTED";

/**
 * The restrictions applied to a verification widget frame, in the order they
 * are sent. The three required ones are what the frame may only run under:
 * `Fetch` holds it to the allowlist, the auto-attach setting puts the targets
 * it spawns (a nested out-of-process iframe, a worker, a popup) under this same
 * handler, and the escape blocker closes the `WebSocket` / `Worker` /
 * `window.open` routes `Fetch` cannot see. Missing any one of them leaves a way
 * around the request policy, so a frame that cannot take all three is stopped.
 * `Page.enable` only turns on events and no restriction rides on it.
 */
function verificationFrameRestrictions(): ReadonlyArray<{
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly required: boolean;
}> {
	return [
		{
			method: "Fetch.enable",
			params: { patterns: [{ urlPattern: "*" }] },
			required: true,
		},
		{
			method: "Target.setAutoAttach",
			params: AUTO_ATTACH_PARAMS,
			required: true,
		},
		{ method: "Page.enable", params: {}, required: false },
		{
			method: "Page.addScriptToEvaluateOnNewDocument",
			params: { source: BLOCK_BROWSER_ESCAPE_EXPRESSION },
			required: true,
		},
	];
}

/**
 * Applies the page's own restrictions to a verification widget frame and, when
 * the frame is still paused, releases it. Answers whether the frame ended up
 * running under the whole restriction set; the caller stops it when not.
 *
 * Each command is sent on its own so a failure is attributable, and a required
 * one that fails ends the sequence: there is nothing to gain from the rest once
 * the frame is going to be stopped. `Runtime.runIfWaitingForDebugger` is always
 * the last command sent, so nothing runs before the set is complete. A frame
 * that was already running takes the restrictions without being released.
 */
async function runVerificationProviderFrame(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	paused: boolean,
): Promise<boolean> {
	for (const { method, params, required } of verificationFrameRestrictions()) {
		const applied = await sendVerificationFrameRestriction(
			connection,
			sessionId,
			method,
			params,
		);
		if (!applied && required) return false;
	}
	if (!paused) return true;
	return await sendVerificationFrameRestriction(
		connection,
		sessionId,
		"Runtime.runIfWaitingForDebugger",
		{},
	);
}

/**
 * Stops what a verification frame would run and drops its session, without
 * closing the target: closing an out-of-process iframe closes the page that
 * owns it and takes the run's own session with it.
 *
 * The stop is a navigation to `about:blank`. `Page.navigate` on a frame target
 * is carried out by the browser process, so it does not wait on the frame's own
 * paused renderer, and it supersedes the navigation the frame is held on, which
 * is why the widget document never gets to commit. Only then is the debugger
 * pause released, and only if the navigation was accepted: releasing first
 * would let the widget run, and releasing after a refused navigation would let
 * it run too. A refusal arrives as `errorText` on a resolved answer as often as
 * it does as a rejection, so both count as refused. The pause is a browser-side
 * hold that Chrome frees when the session owning it goes away, so detaching is
 * the last step and never the stop by itself. A frame whose `about:blank`
 * navigation is refused is the one case left where detaching may let the
 * original document run.
 */
async function stopVerificationProviderFrame(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	reason: VerificationFrameStopReason,
	paused: boolean,
): Promise<void> {
	console.log(
		JSON.stringify({ event: "browser_verification_frame_stopped", reason }),
	);
	const navigated = await navigateVerificationFrameToBlank(
		connection,
		sessionId,
	);
	if (navigated && paused) {
		await sendVerificationFrameStopCommand(
			connection,
			sessionId,
			"Runtime.runIfWaitingForDebugger",
			{},
		);
	}
	// Sent without a session: the browser session owns the detach.
	await connection
		.send("Target.detachFromTarget", { sessionId })
		.catch(() => undefined);
}

/**
 * Sends the emptying navigation, reporting whether the frame took it.
 * `Page.navigate` reports a refusal in `errorText` rather than by rejecting, so
 * a resolved answer is not on its own proof that the widget document is gone.
 */
async function navigateVerificationFrameToBlank(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
): Promise<boolean> {
	try {
		const result = await connection.send<{ errorText?: string }>(
			"Page.navigate",
			{ url: "about:blank" },
			sessionId,
		);
		return !result?.errorText;
	} catch {
		return false;
	}
}

/** Sends one stop command, reporting whether it landed and never throwing. */
async function sendVerificationFrameStopCommand(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	method: string,
	params: Record<string, unknown>,
): Promise<boolean> {
	try {
		await connection.send(method, params, sessionId);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sends one restriction command to a verification widget session and reports
 * whether it landed. A failure is logged with the fixed method name and the
 * fixed error kind only, so no page-derived text reaches the log.
 */
async function sendVerificationFrameRestriction(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	method: string,
	params: Record<string, unknown>,
): Promise<boolean> {
	try {
		await connection.send(method, params, sessionId);
		return true;
	} catch (error) {
		console.log(
			JSON.stringify({
				event: "browser_verification_frame_restrict_failed",
				method,
				kind: error instanceof BrowserUseCdpCommandError ? error.kind : "OTHER",
			}),
		);
		return false;
	}
}

export const BLOCK_BROWSER_ESCAPE_EXPRESSION = `(() => {
  class BlockedNetworkConstructor { constructor() { throw new Error("Browser network escape is disabled"); } }
  for (const name of [
    "WebSocket",
    "WebSocketStream",
    "WebTransport",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "Worker",
    "SharedWorker"
  ]) {
    Object.defineProperty(globalThis, name, { value: BlockedNetworkConstructor, configurable: false, writable: false });
  }
  Object.defineProperty(globalThis, "open", { value: () => null, configurable: false, writable: false });
  try {
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        value: () => Promise.reject(new Error("Service workers are disabled")),
        configurable: false,
        writable: false
      });
    }
  } catch {}
})()`;

const INSPECT_ELEMENT_FUNCTION = String.raw`function() {
  const element = this;
  if (!element || typeof element.tagName !== "string") return { ok: false };
  const tag = element.tagName.toLowerCase();
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  const labels = Array.from(element.labels ?? []).map((label) => label.textContent?.trim() ?? "").filter(Boolean).join(" ");
  const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => element.getRootNode().getElementById?.(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
  const label = (element.getAttribute("aria-label") || labelledBy || labels || element.closest("label")?.textContent?.trim() || "").slice(0, 500);
  const submitLike = (tag === "button" && (!type || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type));
  const target = (element.getAttribute("formtarget") ?? element.form?.getAttribute("target") ?? "").trim().toLowerCase();
  const formAction = element.hasAttribute("formaction") ? element.formAction : element.form?.action;
  const formMethod = element.hasAttribute("formmethod") ? element.formMethod : element.form?.method;
  return {
    ok: true,
    visible,
    tag,
    type,
    name: typeof element.name === "string" && element.name ? element.name.slice(0, 500) : null,
    label,
    placeholder: typeof element.placeholder === "string" && element.placeholder ? element.placeholder.slice(0, 500) : null,
    required: Boolean(element.required),
    value: typeof element.value === "string" ? element.value.slice(0, 8192) : "",
    options: tag === "select" ? Array.from(element.options).slice(0, 100).map((option) => ({ value: option.value.slice(0, 2048), label: option.text.slice(0, 500) })) : [],
    submitLike,
    target,
    formAction: typeof formAction === "string" ? formAction.slice(0, 2048) : "",
    formMethod: typeof formMethod === "string" ? formMethod.slice(0, 20) : "",
    disabled: Boolean(element.disabled),
    readOnly: Boolean(element.readOnly),
    checked: Boolean(element.checked)
  };
}`;

const HAS_CONFIRMATION_TEXT_FUNCTION = `function(pattern) {
  return new RegExp(pattern, "i").test(String(this.innerText || ""));
}`;

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

export function assertExpectedSubmissionRequest(
	request: { url: string; method: string },
	expected: ExpectedSubmissionRequest | undefined,
): void {
	if (!isExpectedSubmissionRequest(request, expected)) {
		throw new BrowserElementError();
	}
}

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

/**
 * In-page helpers shared by the radio group scan and the checkbox match, so
 * that a candidate means the same thing for every choice control. Matching is
 * an exact comparison against the control value or the trimmed, case-folded
 * label; no partial or fuzzy match is ever made.
 */
const CHOICE_CANDIDATE_HELPERS = `
  const normalizeText = (text) => String(text ?? "").trim().toLowerCase();
  const labelTexts = (element) => {
    const root = element.getRootNode();
    // observe reports several labels, and several aria-labelledby targets, as
    // one joined string each. Only those joined forms are compared, so a
    // candidate can never match a fragment the model was never shown; a
    // question label shared by a whole radio group is one such fragment.
    const labels = Array.from(element.labels ?? []).map((label) => normalizeText(label.textContent)).filter(Boolean).join(" ");
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\\s+/).filter(Boolean)
      .map((id) => normalizeText(root.getElementById?.(id)?.textContent)).filter(Boolean).join(" ");
    return [
      labels,
      labelledBy,
      normalizeText(element.getAttribute("aria-label")),
      normalizeText(element.closest("label")?.textContent),
    ].filter(Boolean);
  };
  const candidateRank = (element, candidates) => {
    const texts = labelTexts(element);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (typeof candidate !== "string" || !candidate) continue;
      if (element.value === candidate || texts.includes(normalizeText(candidate))) return index;
    }
    return -1;
  };
`;

/**
 * Selects the option matching the earliest candidate, by option value or by
 * the same option text `observe` reports. A placeholder option with an empty
 * value is never chosen, because submitting it is the same as choosing nothing.
 * A disabled option, and an option under a disabled optgroup, is skipped so
 * that a candidate the user could never pick does not block a later one.
 */
export const SELECT_OPTION_BY_CANDIDATE_FUNCTION = `function(candidates) {
  if (this.tagName !== "SELECT" || !Array.isArray(candidates)) return false;
  const normalizeText = (text) => String(text ?? "").trim().toLowerCase();
  const isSelectable = (option) => {
    if (option.value === "" || option.disabled) return false;
    const group = option.parentElement;
    return !(group && group.tagName === "OPTGROUP" && group.disabled);
  };
  const options = Array.from(this.options).filter(isSelectable);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const wanted = normalizeText(candidate);
    const match = options.find((option) => option.value === candidate || normalizeText(option.text) === wanted);
    if (!match) continue;
    // Deselecting first keeps a multi-select from carrying an earlier choice.
    for (const option of this.options) option.selected = false;
    match.selected = true;
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}`;

/**
 * Checks the radio only when no other enabled radio of the same group matches
 * an earlier candidate, so the registrant's order decides which one is used
 * even when the DOM order differs. Answers with one of three fixed tokens.
 */
export const SELECT_RADIO_BY_CANDIDATE_FUNCTION = `function(candidates) {
  if (this.tagName !== "INPUT" || this.type !== "radio" || !Array.isArray(candidates)) return "not_candidate";
  ${CHOICE_CANDIDATE_HELPERS}
  const own = candidateRank(this, candidates);
  if (own < 0) return "not_candidate";
  const root = this.getRootNode();
  for (const radio of Array.from(root.querySelectorAll?.('input[type="radio"]') ?? [])) {
    if (radio === this || radio.disabled || radio.name !== this.name || radio.form !== this.form) continue;
    const rank = candidateRank(radio, candidates);
    if (rank >= 0 && rank < own) return "higher_priority_exists";
  }
  if (!this.checked) this.click();
  return this.checked ? "selected" : "not_candidate";
}`;

/** Whether the control's own value or label equals one of the candidates. */
export const MATCHES_CHOICE_CANDIDATE_FUNCTION = `function(candidates) {
  if (!Array.isArray(candidates)) return false;
  ${CHOICE_CANDIDATE_HELPERS}
  return candidateRank(this, candidates) >= 0;
}`;

export const ACTIVATE_SUBMIT_FUNCTION = `function(input, expectedAction, expectedMethod) {
  if (!this.isConnected || this.disabled || !this.form || !input?.isConnected || input.form !== this.form) return false;
  const tag = typeof this.tagName === "string" ? this.tagName.toLowerCase() : "";
  const type = typeof this.type === "string" ? this.type.toLowerCase() : "";
  const submitLike = (tag === "button" && (!type || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type));
  if (!submitLike) return false;
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const target = (this.getAttribute("formtarget") ?? this.form.getAttribute("target") ?? "").trim().toLowerCase();
  if (target && target !== "_self") return false;
  const rawAction = this.hasAttribute("formaction") ? this.formAction : this.form.action;
  const action = new URL(rawAction);
  action.hash = "";
  const method = (this.hasAttribute("formmethod") ? this.formMethod : this.form.method).toUpperCase();
  if (action.toString() !== expectedAction || method !== expectedMethod) return false;
  const nativeClick = HTMLElement.prototype.click;
  if (typeof nativeClick !== "function") return false;
  nativeClick.call(this);
  return true;
}`;

export const SET_CHECKED_VALUE_FUNCTION = `function(checked) {
  if (this.tagName !== "INPUT" || !["checkbox", "radio"].includes(this.type) || typeof checked !== "boolean") return false;
  if (this.type === "radio" && !checked) return false;
  if (this.checked !== checked) this.click();
  return this.checked === checked;
}`;

export const IS_SUBMIT_UNOBSCURED_FUNCTION = `function() {
  if (!this.isConnected || typeof this.getBoundingClientRect !== "function") return false;
  const rect = this.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const root = this.getRootNode?.();
  const hitTestRoot = root && typeof root.elementFromPoint === "function" ? root : this.ownerDocument;
  const hit = hitTestRoot?.elementFromPoint?.(x, y);
  let current = hit;
  while (current) {
    if (current === this) return true;
    const currentRoot = current.getRootNode?.();
    current = current.parentElement ?? currentRoot?.host ?? null;
  }
  return false;
}`;

export const IS_ELEMENT_FOCUSED_FUNCTION = `function() {
  const root = this.getRootNode?.();
  return Boolean(this.isConnected && root && root.activeElement === this);
}`;

export const CHECK_FORM_VALIDITY_FUNCTION = `function() {
  return Boolean(this.form && typeof this.form.checkValidity === "function" && this.form.checkValidity());
}`;

export const READ_FORM_PROHIBITION_REASON_CODES_FUNCTION = `function() {
  const patternSources = ${JSON.stringify(PROHIBITION_TEXT_PATTERN_SOURCES)};
  const texts = [];
  const appendText = (value) => {
    texts.push(String(value ?? ""));
  };
  appendText(this.innerText);
	const headingTexts = [];
	const appendHeadings = (element) => {
		if (!element || headingTexts.length >= 20) return;
		if (element.matches?.("h1, h2, h3, legend")) {
			headingTexts.push(String(element.innerText ?? "").slice(0, 200));
		}
		const nodes = element.querySelectorAll?.("h1, h2, h3, legend");
		const length = Math.min(Number(nodes?.length) || 0, 20);
		for (let index = 0; index < length && headingTexts.length < 20; index += 1) {
			headingTexts.push(String(nodes[index]?.innerText ?? "").slice(0, 200));
		}
	};
	appendHeadings(this);
	headingTexts.push(String(this.ownerDocument?.title ?? "").slice(0, 200));
	const appendPrevious = (element, limit) => {
		let sibling = element?.previousElementSibling;
		for (let count = 0; count < limit && sibling; count += 1) {
			if (sibling.matches?.("form") || sibling.querySelector?.("form")) break;
			if (!["HEADER", "NAV", "FOOTER"].includes(sibling.tagName)) {
				appendText(sibling.innerText);
				appendHeadings(sibling);
			}
			sibling = sibling.previousElementSibling;
		}
	};
	appendPrevious(this, 3);
	let current = this.parentElement;
	for (let depth = 0; depth < 2 && current && current.tagName !== "BODY"; depth += 1) {
		appendPrevious(current, 1);
		current = current.parentElement;
	}
	const host = this.getRootNode?.()?.host ?? null;
	if (host) {
		appendPrevious(host, 1);
		current = host.parentElement;
		for (let depth = 0; depth < 2 && current && current.tagName !== "BODY"; depth += 1) {
			appendPrevious(current, 1);
			current = current.parentElement;
		}
	}
  const detectionTexts = [...texts];
  for (let index = 1; index < texts.length; index += 1) {
    detectionTexts.push(texts[index - 1].slice(-128) + " " + texts[index].slice(0, 128));
  }
  const codes = [];
  for (const rawText of detectionTexts) {
    const text = rawText.replace(/\\s+/g, " ").toLowerCase();
    const withoutExplicitAllowances = patternSources.explicitAllowances.reduce(
      (value, source) => value.replace(new RegExp(source, "g"), " "),
      text,
    );
    if (
      !codes.includes("SALES_PROHIBITED") &&
      patternSources.salesProhibited.some((source) => new RegExp(source).test(withoutExplicitAllowances))
    ) {
      codes.push("SALES_PROHIBITED");
    }
    if (
      !codes.includes("FORM_PURPOSE_INCOMPATIBLE") &&
      patternSources.formPurposeIncompatible.some((source) => new RegExp(source).test(text))
    ) {
      codes.push("FORM_PURPOSE_INCOMPATIBLE");
    }
  }
  for (const rawHeading of headingTexts) {
    if (codes.includes("FORM_PURPOSE_INCOMPATIBLE")) break;
    const heading = rawHeading.replace(/\\s+/g, " ").trim().toLowerCase();
    // A heading longer than this names something besides the form's purpose,
    // and the bound also keeps the filler pattern from backtracking.
    if (heading.length === 0 || heading.length > 32) continue;
    if (patternSources.formPurposeHeading.some((source) => new RegExp(source).test(heading))) {
      codes.push("FORM_PURPOSE_INCOMPATIBLE");
    }
  }
  return codes;
}`;

export const HAS_SAME_FORM_OWNER_FUNCTION = `function(input) {
  return Boolean(this.form && input && input.form === this.form);
}`;

export const IS_COMPOSED_DESCENDANT_FUNCTION = `function(candidate) {
  let current = candidate;
  while (current) {
    if (current === this) return true;
    const root = current.getRootNode?.();
    current = current.parentElement ?? root?.host ?? null;
  }
  return false;
}`;

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
