import { assertAllowedBrowserRequest } from "./browser-network-policy";
import { SUBMISSION_CONFIRMATION_PATTERN } from "./browser-submit-confirmation";
import { BrowserUseCdpConnection } from "./browser-use-cdp";
import {
	type CdpDomNode,
	type CdpFormDiscovery,
	discoverCdpBodyBackendNodeIds,
	discoverCdpForms,
	discoverCdpNavigationLinks,
	findCdpFrameOwnerBackendNodeId,
} from "./browser-use-cdp-dom";
import type { Job } from "./job";
import {
	assertAllowedTargetUrl,
	BrowserElementError,
	BrowserFormInvalidError,
	type BrowserObservation,
	type BrowserSubmitResult,
	createBrowserSubmitDiagnosticError,
	isReviewComparableField,
	normalizeAllowedHosts,
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
const MAX_CONFIRMATION_SNAPSHOTS = 5;
const CONFIRMATION_POLL_INTERVAL_MS = 1_000;
const SUBMISSION_PERMISSION_WINDOW_MS = 2_000;
const MAX_SUBMIT_MOUSE_PREPARATION_ATTEMPTS = 3;

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
	frame: { id: string; parentId?: string };
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
	readonly #isolatedWorldContexts = new Map<string, number>();
	#elementGeneration = 0;
	#elements = new Map<string, ElementReference>();
	#formDataEntered = false;
	#interactionStarted = false;
	#navigationCount = 0;
	readonly #successfulInputBackendNodeIds = new Set<number>();

	private constructor(
		private readonly connection: BrowserUseCdpConnection,
		private readonly sessionId: string,
		private readonly dryRun: boolean,
	) {}

	static async connect(
		apiKey: string,
		_job: Job,
		dryRun = false,
		endpoint = "wss://connect.browser-use.com",
	): Promise<BrowserUseCdpDriver> {
		if (!apiKey) throw new Error("Browser Use API key is required");
		const url = new URL(endpoint);
		if (url.protocol !== "wss:" || url.hostname !== "connect.browser-use.com") {
			throw new Error("Invalid Browser Use CDP endpoint");
		}
		url.searchParams.set("apiKey", apiKey);
		url.searchParams.set("proxyCountryCode", "jp");
		url.searchParams.set("timeout", "15");

		const connection = await BrowserUseCdpConnection.connect(url.toString());
		try {
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
			const driver = new BrowserUseCdpDriver(connection, sessionId, dryRun);
			await driver.#initialize();
			return driver;
		} catch (error) {
			connection.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		this.connection.close();
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
		this.#expectedNavigationRequest = this.#blockNonSubmitRequests
			? {
					url: canonicalHttpRequestUrl(url),
					...(this.#topFrameId ? { frameId: this.#topFrameId } : {}),
					claimed: false,
				}
			: undefined;
		this.#navigationCount += 1;
		this.#clearElements();
		try {
			const result = await this.#send<{ errorText?: string }>("Page.navigate", {
				url,
			});
			if (result.errorText) throw new Error("Browser navigation failed");
			await this.#waitForReadyState();
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

		for (const candidateForm of discovery.forms) {
			if (
				forms.length >= MAX_OBSERVED_FORMS ||
				fieldIndex >= MAX_OBSERVED_FIELDS
			) {
				break;
			}
			const fields: unknown[] = [];
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
				elements.set(elementId, {
					backendNodeId: candidate.backendNodeId,
					...(candidateForm.frameId ? { frameId: candidateForm.frameId } : {}),
				});
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
				forms.push({
					action: candidateForm.action,
					method: candidateForm.method,
					fields,
					prohibitedReasonCodes: [
						...new Set([
							...formProhibitedReasonCodes,
							...parentProhibitedReasonCodes,
						]),
					],
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
				observedFieldCount: fieldIndex,
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
		await this.#clickElement(reference.backendNodeId);
	}

	async fill(elementId: string, value: string): Promise<void> {
		const reference = this.#element(elementId);
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
	}

	async select(elementId: string, value: string): Promise<void> {
		const reference = this.#element(elementId);
		const state = await this.#inspectElement(reference.backendNodeId);
		if (!state.ok || !state.visible || state.disabled) {
			throw new BrowserElementError();
		}
		this.#interactionStarted = true;
		this.#formDataEntered = true;
		this.#blockNonSubmitRequests = true;
		if (state.tag === "select") {
			const changed = await this.#callFunctionOnElement<boolean>(
				reference.backendNodeId,
				SET_SELECT_VALUE_FUNCTION,
				[value],
			);
			if (!changed) throw new BrowserElementError();
			this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
			return;
		}
		const desiredChecked =
			value === "true" || value === "checked" || value === state.value;
		if (state.type === "checkbox") {
			const changed = await this.#callFunctionOnElement<boolean>(
				reference.backendNodeId,
				SET_CHECKED_VALUE_FUNCTION,
				[desiredChecked],
			);
			if (!changed) throw new BrowserElementError();
			this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
			return;
		}
		if (state.type === "radio" && value === state.value) {
			const changed = await this.#callFunctionOnElement<boolean>(
				reference.backendNodeId,
				SET_CHECKED_VALUE_FUNCTION,
				[true],
			);
			if (!changed) throw new BrowserElementError();
			this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
			return;
		}
		throw new BrowserElementError();
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
			for (
				let snapshot = 0;
				snapshot < MAX_CONFIRMATION_SNAPSHOTS;
				snapshot += 1
			) {
				await delay(CONFIRMATION_POLL_INTERVAL_MS);
				const confirmation = await readSubmissionConfirmation(
					beforeConfirmationCount,
					this.#submissionRequestCount > 0,
					() => this.#confirmationBodyCount(expectedDocumentGetFrameId),
					() => this.currentUrl(),
					hasExpectedFrameNavigated(
						expectedDocumentGetFrameId,
						frameNavigationRevisionBeforeActivation,
						this.#frameNavigationRevisions,
					),
				);
				if (confirmation) return confirmation;
			}
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
			const frame = (params as { frame?: { id?: unknown; parentId?: unknown } })
				.frame;
			const frameId = frame?.id;
			if (typeof frameId !== "string") return;
			this.#frameParentIds.set(
				frameId,
				typeof frame?.parentId === "string" ? frame.parentId : undefined,
			);
			this.#isolatedWorldContexts.delete(frameId);
			this.#frameNavigationRevisions.set(
				frameId,
				(this.#frameNavigationRevisions.get(frameId) ?? 0) + 1,
			);
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
		let blockStage: SubmissionRequestBlockStage = "network_policy";
		let claimedSubmissionRequest = false;
		let submissionRelatedRequest = unsafeRequest;
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
			const getSubmissionDisposition = canContinueSubmissionRedirect
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
			if (this.#submissionRequestAllowed) {
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
			assertAllowedBrowserRequest(
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

	async #waitForReadyState(): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const readyState = await this.#evaluate<string>(
				"document.readyState",
			).catch(() => "loading");
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
			discoverCdpBodyBackendNodeIds(root, 20, frameId).map((backendNodeId) =>
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

	async #clickElement(backendNodeId: number): Promise<void> {
		const point = await this.#prepareMouseClick(backendNodeId);
		await this.#dispatchMouseClick(point);
	}

	async #prepareMouseClick(
		backendNodeId: number,
		activationStrategy?: SubmitActivationStrategy,
		onAttempt?: (attempt: number) => void,
	): Promise<{ x: number; y: number }> {
		let stage: SubmitActivationStage = "scroll";
		try {
			await this.#send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
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
			if (!activationStrategy) return await prepare();
			return await retrySubmitMousePreparation(
				prepare,
				async () => {
					stage = "retry_wait";
					await this.#nextAnimationFrame();
				},
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
		await this.#send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: point.x,
			y: point.y,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
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

export async function retrySubmitMousePreparation<TResult>(
	prepare: () => Promise<TResult>,
	waitForNextFrame: () => Promise<unknown>,
	onAttempt: (attempt: number) => void = () => undefined,
): Promise<TResult> {
	for (
		let attempt = 1;
		attempt <= MAX_SUBMIT_MOUSE_PREPARATION_ATTEMPTS;
		attempt += 1
	) {
		onAttempt(attempt);
		try {
			return await prepare();
		} catch (error) {
			if (
				!(error instanceof BrowserElementError) ||
				attempt === MAX_SUBMIT_MOUSE_PREPARATION_ATTEMPTS
			) {
				throw error;
			}
			await waitForNextFrame();
		}
	}
	throw new BrowserElementError();
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

export function assertDryRunNavigationAllowed(
	dryRun: boolean,
	navigationCount: number,
): void {
	if (dryRun && navigationCount > 0) throw new BrowserElementError();
}

export async function denyRelatedBrowserTargets(
	connection: Pick<BrowserUseCdpConnection, "on" | "send">,
	parentSessionId: string,
	onPolicyFailure: (error: Error) => void,
): Promise<void> {
	connection.on("Target.attachedToTarget", (params, sessionId) => {
		if (sessionId !== parentSessionId) return;
		const attached = params as AttachedTarget;
		if (!attached.waitingForDebugger) {
			onPolicyFailure(new Error("A related browser target was not paused"));
		}
		void connection
			.send<{ success: boolean }>("Target.closeTarget", {
				targetId: attached.targetInfo.targetId,
			})
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
	});
	await connection.send(
		"Target.setAutoAttach",
		{
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
		},
		parentSessionId,
	);
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

const SET_SELECT_VALUE_FUNCTION = `function(value) {
  if (this.tagName !== "SELECT" || !Array.from(this.options).some((option) => option.value === value)) return false;
  this.value = value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
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
	const appendPrevious = (element, limit) => {
		let sibling = element?.previousElementSibling;
		for (let count = 0; count < limit && sibling; count += 1) {
			if (sibling.matches?.("form") || sibling.querySelector?.("form")) break;
			if (!["HEADER", "NAV", "FOOTER"].includes(sibling.tagName)) {
				appendText(sibling.innerText);
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
