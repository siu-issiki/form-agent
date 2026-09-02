import { assertAllowedBrowserRequest } from "./browser-network-policy";
import { hasNewSubmissionConfirmation } from "./browser-submit-confirmation";
import { BrowserUseCdpConnection } from "./browser-use-cdp";
import {
	type CdpDomNode,
	type CdpFormDiscovery,
	discoverCdpForms,
} from "./browser-use-cdp-dom";
import type { Job } from "./job";
import {
	BrowserElementError,
	BrowserFormInvalidError,
	type BrowserObservation,
	type BrowserSubmitResult,
	createBrowserSubmitDiagnosticError,
	normalizeAllowedHosts,
	type RestrictedBrowserDriver,
	type SubmitActivationStrategy,
} from "./restricted-browser";

const MAX_PAGE_TEXT = 20_000;
const MAX_OBSERVED_FORMS = 10;
const MAX_OBSERVED_FIELDS = 100;
const MAX_DOM_DISCOVERY_ATTEMPTS = 5;
const DOM_DISCOVERY_RETRY_DELAY_MS = 500;
const CONFIRMATION_WAIT_MS = 5_000;
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
}

interface PausedRequest {
	requestId: string;
	resourceType?: string;
	request: { url: string; method: string };
}

interface ExpectedSubmissionRequest {
	url: string;
	method: string;
}

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

export class BrowserUseCdpDriver implements RestrictedBrowserDriver {
	#targetDomain: string | undefined;
	#allowedHosts: string[] = [];
	#submissionRequestAllowed = false;
	#submissionRequestCount = 0;
	#submissionRequestObserved: (() => void) | undefined;
	#expectedSubmissionRequest: ExpectedSubmissionRequest | undefined;
	#targetPolicyError: Error | undefined;
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

	async navigate(url: string): Promise<void> {
		assertDryRunNavigationAllowed(this.dryRun, this.#navigationCount);
		this.#navigationCount += 1;
		this.#clearElements();
		const result = await this.#send<{ errorText?: string }>("Page.navigate", {
			url,
		});
		if (result.errorText) throw new Error("Browser navigation failed");
		await this.#waitForReadyState();
	}

	async observe(): Promise<BrowserObservation> {
		const startedAt = Date.now();
		const url = await this.currentUrl();
		const { discovery, attempts: discoveryAttempts } =
			await this.#discoverForms(url);

		const generation = ++this.#elementGeneration;
		const elements = new Map<string, ElementReference>();
		const forms: Array<{
			action: string;
			method: string;
			fields: unknown[];
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
					options: state.options,
				});
			}
			if (fields.length > 0) {
				forms.push({
					action: candidateForm.action,
					method: candidateForm.method,
					fields,
				});
			}
		}

		this.#elements = elements;
		const pageText = await this.#bodyText();
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
		return { url, forms, pageText };
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
			if (state.checked !== desiredChecked) {
				await this.#clickElement(reference.backendNodeId);
			}
			this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
			return;
		}
		if (state.type === "radio" && value === state.value) {
			if (!state.checked) await this.#clickElement(reference.backendNodeId);
			this.#successfulInputBackendNodeIds.add(reference.backendNodeId);
			return;
		}
		throw new BrowserElementError();
	}

	async validateSubmit(elementId: string): Promise<void> {
		this.#expectedSubmissionRequest = undefined;
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
			if (
				await this.#callFunctionOnElementWithElementArgument<boolean>(
					reference.backendNodeId,
					inputBackendNodeId,
					HAS_SAME_FORM_OWNER_FUNCTION,
				)
			) {
				hasInputInSubmitForm = true;
				break;
			}
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
		this.#interactionStarted = true;
		let beforeText: string;
		try {
			beforeText = await this.#bodyText();
		} catch (error) {
			throw createBrowserSubmitDiagnosticError(
				"SUBMIT_READ_BEFORE_TEXT",
				error,
			);
		}
		try {
			try {
				await this.#activateSubmitElement(
					this.#element(elementId).backendNodeId,
					activationStrategy,
				);
			} catch (error) {
				throw createBrowserSubmitDiagnosticError("SUBMIT_ACTIVATE", error);
			}
			const deadline = Date.now() + CONFIRMATION_WAIT_MS;
			while (Date.now() < deadline) {
				const confirmation = await readSubmissionConfirmation(
					beforeText,
					() => this.#bodyText(),
					() => this.currentUrl(),
				);
				if (confirmation) return confirmation;
				await delay(250);
			}
		} finally {
			this.#submissionRequestAllowed = false;
		}
		return {
			outcome: "uncertain",
			reasonCode: "SUBMIT_RESULT_UNKNOWN",
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
			if (sessionId === this.sessionId) this.#clearElements();
		});
		await this.#send("Page.enable");
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
		try {
			if (!this.#targetDomain) {
				throw new Error("Browser domain scope is not configured");
			}
			const unsafeRequest = !["GET", "HEAD", "OPTIONS"].includes(
				paused.request.method.toUpperCase(),
			);
			if (unsafeRequest && this.#submissionRequestAllowed) {
				assertExpectedSubmissionRequest(
					paused.request,
					this.#expectedSubmissionRequest,
				);
			}
			assertAllowedBrowserRequest(
				paused.request.url,
				this.#targetDomain,
				paused.request.method,
				this.#submissionRequestAllowed && this.#submissionRequestCount === 0,
				!this.#formDataEntered && paused.resourceType !== "Document",
				this.dryRun && this.#interactionStarted,
				this.#allowedHosts,
			);
			if (unsafeRequest) {
				this.#submissionRequestCount += 1;
				this.#submissionRequestObserved?.();
			}
			await this.#send("Fetch.continueRequest", {
				requestId: paused.requestId,
			});
		} catch {
			await this.#send("Fetch.failRequest", {
				requestId: paused.requestId,
				errorReason: "BlockedByClient",
			}).catch(() => undefined);
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

	#bodyText(): Promise<string> {
		return this.#evaluate<string>(
			`(document.body?.innerText ?? "").slice(0, ${MAX_PAGE_TEXT})`,
		);
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
	}

	async #discoverForms(
		url: string,
	): Promise<{ discovery: CdpFormDiscovery; attempts: number }> {
		for (let attempt = 1; attempt <= MAX_DOM_DISCOVERY_ATTEMPTS; attempt += 1) {
			const discovery = discoverCdpForms(
				(
					await this.#send<{ root: CdpDomNode }>("DOM.getDocument", {
						depth: -1,
						pierce: true,
					})
				).root,
				url,
			);
			if (
				discovery.candidateFieldCount > 0 ||
				attempt === MAX_DOM_DISCOVERY_ATTEMPTS
			) {
				return { discovery, attempts: attempt };
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
	): Promise<TResult> {
		const resolved = await this.#send<ResolvedNode>("DOM.resolveNode", {
			backendNodeId,
			objectGroup: "form-agent-elements",
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

	async #callFunctionOnElementWithElementArgument<TResult>(
		backendNodeId: number,
		argumentBackendNodeId: number,
		functionDeclaration: string,
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
					arguments: [{ objectId: argumentObjectId }],
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

export async function readSubmissionConfirmation(
	beforeText: string,
	readAfterText: () => Promise<string>,
	readCurrentUrl: () => Promise<string>,
): Promise<BrowserSubmitResult | null> {
	let afterText: string;
	try {
		afterText = await readAfterText();
	} catch (error) {
		throw createBrowserSubmitDiagnosticError("SUBMIT_READ_AFTER_TEXT", error);
	}
	if (!hasNewSubmissionConfirmation(beforeText, afterText)) return null;
	try {
		return { outcome: "sent", formUrl: await readCurrentUrl() };
	} catch (error) {
		throw createBrowserSubmitDiagnosticError("POST_SUBMIT_URL_CHECK", error);
	}
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

export function assertExpectedSubmissionRequest(
	request: { url: string; method: string },
	expected: ExpectedSubmissionRequest | undefined,
): void {
	const url = new URL(request.url);
	url.hash = "";
	if (
		!expected ||
		request.method.toUpperCase() !== expected.method ||
		url.toString() !== expected.url
	) {
		throw new BrowserElementError();
	}
}

const SET_SELECT_VALUE_FUNCTION = `function(value) {
  if (this.tagName !== "SELECT" || !Array.from(this.options).some((option) => option.value === value)) return false;
  this.value = value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
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
