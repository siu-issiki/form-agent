import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { hasNewSubmissionConfirmation } from "../src/browser-submit-confirmation";
import {
	assertCdpMessageWithinLimit,
	BrowserUseCdpPayloadTooLargeError,
	MAX_CDP_MESSAGE_CHARACTERS,
} from "../src/browser-use-cdp";
import { discoverCdpForms } from "../src/browser-use-cdp-dom";
import {
	assertDryRunNavigationAllowed,
	assertExpectedSubmissionRequest,
	BLOCK_BROWSER_ESCAPE_EXPRESSION,
	CHECK_FORM_VALIDITY_FUNCTION,
	centerOfQuad,
	createExpectedSubmissionRequest,
	denyRelatedBrowserTargets,
	ENTER_KEY_DOWN_EVENT,
	HAS_SAME_FORM_OWNER_FUNCTION,
	IS_COMPOSED_DESCENDANT_FUNCTION,
	IS_ELEMENT_FOCUSED_FUNCTION,
	IS_SUBMIT_UNOBSCURED_FUNCTION,
	isPayloadIndependentClickTarget,
	readSubmissionConfirmation,
	runSubmissionActivationWithinPermissionWindow,
} from "../src/browser-use-cdp-driver";
import { BrowserSubmitDiagnosticError } from "../src/restricted-browser";

describe("BrowserUse CDP payload and DOM discovery", () => {
	test("discovers controls inside a closed shadow root", () => {
		const discovery = discoverCdpForms(
			{
				backendNodeId: 1,
				nodeName: "#document",
				children: [
					{
						backendNodeId: 2,
						nodeName: "FORM",
						attributes: ["id", "contact", "action", "/send", "method", "post"],
						children: [
							{ backendNodeId: 3, nodeName: "INPUT" },
							{
								backendNodeId: 4,
								nodeName: "CONTACT-FIELDS",
								shadowRoots: [
									{
										backendNodeId: 5,
										nodeName: "#document-fragment",
										shadowRootType: "closed",
										children: [
											{ backendNodeId: 6, nodeName: "TEXTAREA" },
											{ backendNodeId: 7, nodeName: "BUTTON" },
										],
									},
								],
							},
						],
					},
					{
						backendNodeId: 8,
						nodeName: "INPUT",
						attributes: ["form", "contact"],
					},
				],
			},
			"https://example.com/contact",
		);

		expect(discovery.closedShadowRootCount).toBe(1);
		expect(discovery.shadowRootCount).toBe(1);
		expect(discovery.forms).toEqual([
			{
				backendNodeId: 2,
				action: "https://example.com/send",
				method: "post",
				fields: [
					{ backendNodeId: 3, tag: "input" },
					{ backendNodeId: 6, tag: "textarea" },
					{ backendNodeId: 7, tag: "button" },
					{ backendNodeId: 8, tag: "input" },
				],
			},
		]);
	});

	test("rejects a CDP message before parsing beyond the Worker-safe cap", () => {
		expect(() =>
			assertCdpMessageWithinLimit("x".repeat(MAX_CDP_MESSAGE_CHARACTERS)),
		).not.toThrow();
		expect(() =>
			assertCdpMessageWithinLimit("x".repeat(MAX_CDP_MESSAGE_CHARACTERS + 1)),
		).toThrow(BrowserUseCdpPayloadTooLargeError);
	});
});

describe("BrowserUseCdpDriver child target policy", () => {
	test("allows only the validated form action and method during submission", () => {
		const expected = createExpectedSubmissionRequest(
			"https://example.com/submit?test=1#confirmation",
			"post",
		);

		expect(() =>
			assertExpectedSubmissionRequest(
				{ url: "https://example.com/submit?test=1", method: "POST" },
				expected,
			),
		).not.toThrow();
		expect(() =>
			assertExpectedSubmissionRequest(
				{ url: "https://example.com/analytics", method: "POST" },
				expected,
			),
		).toThrow();
		expect(() =>
			assertExpectedSubmissionRequest(
				{ url: "https://example.com/submit?test=1", method: "PUT" },
				expected,
			),
		).toThrow();
	});

	test("requires the resolved submit element to be unobscured", () => {
		const isUnobscured = runInNewContext(
			`(${IS_SUBMIT_UNOBSCURED_FUNCTION})`,
		) as (this: {
			isConnected: boolean;
			getBoundingClientRect(): {
				left: number;
				top: number;
				width: number;
				height: number;
			};
			getRootNode(): { elementFromPoint(): object };
		}) => boolean;
		const overlay = {};
		const button = {
			isConnected: true,
			getBoundingClientRect: () => ({
				left: 10,
				top: 20,
				width: 100,
				height: 40,
			}),
			getRootNode() {
				return { elementFromPoint: () => this };
			},
		};

		expect(isUnobscured.call(button)).toBe(true);
		expect(
			isUnobscured.call({
				...button,
				getRootNode: () => ({ elementFromPoint: () => overlay }),
			}),
		).toBe(false);
	});

	test("requires the resolved submit element to retain focus", () => {
		const isFocused = runInNewContext(
			`(${IS_ELEMENT_FOCUSED_FUNCTION})`,
		) as (this: {
			isConnected: boolean;
			getRootNode(): { activeElement: object };
		}) => boolean;
		const button = {
			isConnected: true,
			getRootNode() {
				return { activeElement: this };
			},
		};

		expect(isFocused.call(button)).toBe(true);
		expect(
			isFocused.call({
				...button,
				getRootNode: () => ({ activeElement: {} }),
			}),
		).toBe(false);
	});

	test("rounds hit-test coordinates to CDP integers", () => {
		expect(
			centerOfQuad([10.25, 20.75, 20.25, 20.75, 20.25, 30.75, 10.25, 30.75]),
		).toEqual({ x: 15, y: 26 });
	});

	test("requires the submit control's form to pass native validity", () => {
		const checkFormValidity = runInNewContext(
			`(${CHECK_FORM_VALIDITY_FUNCTION})`,
		) as (this: { form?: { checkValidity(): boolean } }) => boolean;

		expect(
			checkFormValidity.call({ form: { checkValidity: () => true } }),
		).toBe(true);
		expect(
			checkFormValidity.call({ form: { checkValidity: () => false } }),
		).toBe(false);
		expect(checkFormValidity.call({})).toBe(false);
	});

	test("requires a successful input owned by the submit control's form", () => {
		const hasSameFormOwner = runInNewContext(
			`(${HAS_SAME_FORM_OWNER_FUNCTION})`,
		) as (this: { form?: object }, input: { form?: object }) => boolean;
		const submitForm = {};

		expect(
			hasSameFormOwner.call({ form: submitForm }, { form: submitForm }),
		).toBe(true);
		expect(hasSameFormOwner.call({ form: submitForm }, { form: {} })).toBe(
			false,
		);
		expect(hasSameFormOwner.call({}, { form: submitForm })).toBe(false);
	});

	test("allows only the bootstrap navigation in dry-run", () => {
		expect(() => assertDryRunNavigationAllowed(true, 0)).not.toThrow();
		expect(() => assertDryRunNavigationAllowed(true, 1)).toThrow();
		expect(() => assertDryRunNavigationAllowed(false, 1)).not.toThrow();
	});

	test("accepts only the intended click target or its composed descendants", () => {
		const isComposedDescendant = runInNewContext(
			`(${IS_COMPOSED_DESCENDANT_FUNCTION})`,
		) as (this: object, candidate: object) => boolean;
		const target = { getRootNode: () => ({}) };
		const child = { parentElement: target, getRootNode: () => ({}) };
		const shadowChild = {
			parentElement: null,
			getRootNode: () => ({ host: target }),
		};
		const overlay = { parentElement: null, getRootNode: () => ({}) };

		expect(isComposedDescendant.call(target, target)).toBe(true);
		expect(isComposedDescendant.call(target, child)).toBe(true);
		expect(isComposedDescendant.call(target, shadowChild)).toBe(true);
		expect(isComposedDescendant.call(target, overlay)).toBe(false);
	});

	test("allows click only for a non-value button control", () => {
		expect(isPayloadIndependentClickTarget("button", "button")).toBe(true);
		for (const [tag, type] of [
			["input", "checkbox"],
			["input", "radio"],
			["input", "button"],
			["select", "select-one"],
			["textarea", "textarea"],
			["button", "reset"],
		] as const) {
			expect(isPayloadIndependentClickTarget(tag, type)).toBe(false);
		}
	});

	test("pauses and closes related worker and popup targets", async () => {
		const calls: Array<{
			method: string;
			params: Record<string, unknown>;
			sessionId?: string;
		}> = [];
		let attachedListener:
			| ((params: unknown, sessionId: string | undefined) => void)
			| undefined;
		const failures: Error[] = [];
		const connection = {
			on(method: string, listener: typeof attachedListener) {
				expect(method).toBe("Target.attachedToTarget");
				attachedListener = listener;
				return () => undefined;
			},
			async send<TResult>(
				method: string,
				params: Record<string, unknown> = {},
				sessionId?: string,
			): Promise<TResult> {
				calls.push({ method, params, sessionId });
				return { success: true } as TResult;
			},
		};

		await denyRelatedBrowserTargets(connection, "primary", (error) =>
			failures.push(error),
		);
		expect(calls[0]).toEqual({
			method: "Target.setAutoAttach",
			params: {
				autoAttach: true,
				waitForDebuggerOnStart: true,
				flatten: true,
			},
			sessionId: "primary",
		});

		for (const [targetId, type] of [
			["worker-1", "worker"],
			["popup-1", "page"],
		] as const) {
			attachedListener?.(
				{
					sessionId: `${targetId}-session`,
					targetInfo: { targetId, type },
					waitingForDebugger: true,
				},
				"primary",
			);
		}
		await Promise.resolve();

		expect(calls.slice(1)).toEqual([
			{
				method: "Target.closeTarget",
				params: { targetId: "worker-1" },
				sessionId: undefined,
			},
			{
				method: "Target.closeTarget",
				params: { targetId: "popup-1" },
				sessionId: undefined,
			},
		]);
		expect(failures).toEqual([]);
	});

	test("blocks page-realm socket, peer, worker, popup, and service worker escapes", async () => {
		const context = {
			WebSocket: class {},
			WebSocketStream: class {},
			WebTransport: class {},
			RTCPeerConnection: class {},
			webkitRTCPeerConnection: class {},
			Worker: class {},
			SharedWorker: class {},
			open: () => ({ opened: true }),
			navigator: { serviceWorker: { register: () => Promise.resolve() } },
		};
		runInNewContext(BLOCK_BROWSER_ESCAPE_EXPRESSION, context);

		for (const constructorName of [
			"WebSocket",
			"WebSocketStream",
			"WebTransport",
			"RTCPeerConnection",
			"webkitRTCPeerConnection",
			"Worker",
			"SharedWorker",
		]) {
			expect(() =>
				runInNewContext(
					`new ${constructorName}("https://example.com")`,
					context,
				),
			).toThrow("Browser network escape is disabled");
		}
		expect(runInNewContext('open("https://example.com")', context)).toBeNull();
		await expect(context.navigator.serviceWorker.register()).rejects.toThrow(
			"Service workers are disabled",
		);
	});

	test("fails the policy when a related target was not paused", async () => {
		let attachedListener:
			| ((params: unknown, sessionId: string | undefined) => void)
			| undefined;
		const failures: Error[] = [];
		const connection = {
			on(_method: string, listener: typeof attachedListener) {
				attachedListener = listener;
				return () => undefined;
			},
			async send<TResult>(): Promise<TResult> {
				return { success: true } as TResult;
			},
		};

		await denyRelatedBrowserTargets(connection, "primary", (error) =>
			failures.push(error),
		);
		attachedListener?.(
			{
				sessionId: "worker-session",
				targetInfo: { targetId: "worker-1", type: "worker" },
				waitingForDebugger: false,
			},
			"primary",
		);

		expect(failures.map((error) => error.message)).toEqual([
			"A related browser target was not paused",
		]);
	});
});

describe("BrowserUseCdpDriver submission confirmation", () => {
	test("includes the Enter text required for native button activation", () => {
		expect(ENTER_KEY_DOWN_EVENT).toMatchObject({
			type: "keyDown",
			key: "Enter",
			text: "\r",
			unmodifiedText: "\r",
		});
	});

	test("bounds the submission request permission window when activation does not resolve", async () => {
		let waitedMilliseconds: number | null = null;
		const neverResolvingKeyDown = new Promise<never>(() => undefined);
		const neverObservedRequest = new Promise<never>(() => undefined);

		await runSubmissionActivationWithinPermissionWindow(
			() => neverResolvingKeyDown,
			neverObservedRequest,
			async (milliseconds) => {
				waitedMilliseconds = milliseconds;
			},
		);

		expect(waitedMilliseconds).toBe(2_000);
	});

	test("keeps the permission window open until a request is observed", async () => {
		let resolveObservedRequest: () => void = () => undefined;
		const observedRequest = new Promise<void>((resolve) => {
			resolveObservedRequest = resolve;
		});
		const neverReachingDeadline = new Promise<never>(() => undefined);
		let completed = false;

		const permissionWindow = runSubmissionActivationWithinPermissionWindow(
			async () => undefined,
			observedRequest,
			() => neverReachingDeadline,
		).then(() => {
			completed = true;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(completed).toBe(false);
		resolveObservedRequest();
		await permissionWindow;
		expect(completed).toBe(true);
	});

	test("classifies a confirmation read failure without persisting its message", async () => {
		const failure = readSubmissionConfirmation(
			"Contact form",
			async () => {
				throw new Error("Browser Use CDP connection closed");
			},
			async () => "https://example.com/contact",
		);

		await expect(failure).rejects.toMatchObject({
			name: "BrowserSubmitDiagnosticError",
			stage: "SUBMIT_READ_AFTER_TEXT",
			diagnosticCode: "CDP_CONNECTION_CLOSED",
		});
		await expect(failure).rejects.not.toThrow("connection closed");
	});

	test("classifies a confirmation URL failure", async () => {
		const failure = readSubmissionConfirmation(
			"Contact form",
			async () => "送信が完了しました。ありがとうございました。",
			async () => {
				throw new Error("Browser Use CDP command timed out");
			},
		);

		await expect(failure).rejects.toBeInstanceOf(BrowserSubmitDiagnosticError);
		await expect(failure).rejects.toMatchObject({
			stage: "POST_SUBMIT_URL_CHECK",
			diagnosticCode: "CDP_COMMAND_TIMEOUT",
		});
	});

	test("accepts a confirmation that appears after submit", () => {
		expect(
			hasNewSubmissionConfirmation(
				"お問い合わせフォーム",
				"送信が完了しました。ありがとうございました。",
			),
		).toBe(true);
	});

	test("does not accept confirmation text that already existed", () => {
		expect(
			hasNewSubmissionConfirmation(
				"Thank you for visiting our website.",
				"Thank you for visiting our website.",
			),
		).toBe(false);
	});

	test("does not accept a negative submitted message", () => {
		expect(
			hasNewSubmissionConfirmation(
				"Contact form",
				"The form was not submitted. Please correct the errors.",
			),
		).toBe(false);
	});
});
