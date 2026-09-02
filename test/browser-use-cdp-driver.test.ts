import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { hasNewSubmissionConfirmation } from "../src/browser-submit-confirmation";
import {
	assertCdpMessageWithinLimit,
	BrowserUseCdpPayloadTooLargeError,
	MAX_CDP_MESSAGE_CHARACTERS,
} from "../src/browser-use-cdp";
import {
	discoverCdpBodyBackendNodeIds,
	discoverCdpForms,
	discoverCdpNavigationLinks,
	findCdpFrameOwnerBackendNodeId,
} from "../src/browser-use-cdp-dom";
import {
	ACTIVATE_SUBMIT_FUNCTION,
	assertDryRunNavigationAllowed,
	assertExpectedSubmissionRequest,
	BLOCK_BROWSER_ESCAPE_EXPRESSION,
	type CdpScreenshotResult,
	CHECK_FORM_VALIDITY_FUNCTION,
	captureCdpScreenshot,
	centerOfQuad,
	continueSubmissionRequest,
	createExpectedSubmissionRequest,
	createSubmitActivationFailureLog,
	denyRelatedBrowserTargets,
	ENTER_KEY_DOWN_EVENT,
	getSubmissionRequestDisposition,
	HAS_SAME_FORM_OWNER_FUNCTION,
	hasExpectedFrameNavigated,
	IS_COMPOSED_DESCENDANT_FUNCTION,
	IS_ELEMENT_FOCUSED_FUNCTION,
	IS_SUBMIT_UNOBSCURED_FUNCTION,
	isAuthorizedSubmissionRedirect,
	isExpectedNavigationDocumentRequest,
	isPayloadIndependentClickTarget,
	READ_FORM_PROHIBITION_CONTEXT_FUNCTION,
	readSubmissionConfirmation,
	retrySubmitMousePreparation,
	runSubmissionActivationWithinPermissionWindow,
	SET_CHECKED_VALUE_FUNCTION,
	shouldBlockNonSubmitRequest,
	submitUncertainReasonCode,
} from "../src/browser-use-cdp-driver";
import {
	BrowserElementError,
	BrowserSubmitDiagnosticError,
} from "../src/restricted-browser";

describe("BrowserUse CDP payload and DOM discovery", () => {
	test("reads preceding warnings and form text without including a footer", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_CONTEXT_FUNCTION})`,
		) as (this: object, maxLength: number) => string;

		expect(
			readContext.call(
				{
					previousElementSibling: {
						innerText: "営業利用は禁止です",
						previousElementSibling: null,
						matches: () => false,
						querySelector: () => null,
					},
					innerText: "一般お問い合わせフォーム",
					parentElement: { tagName: "BODY" },
				},
				100,
			),
		).toBe("一般お問い合わせフォーム 営業利用は禁止です");
	});

	test("crosses a shadow host but excludes unrelated header context", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_CONTEXT_FUNCTION})`,
		) as (this: object, maxLength: number) => string;
		const body = { tagName: "BODY" };
		const header = {
			tagName: "HEADER",
			innerText: "採用お問い合わせ専用サイト",
			previousElementSibling: null,
			matches: () => false,
			querySelector: () => null,
		};
		const warning = {
			tagName: "ASIDE",
			innerText: "営業利用は禁止です",
			previousElementSibling: header,
			matches: () => false,
			querySelector: () => null,
		};
		const host = {
			tagName: "CONTACT-FORM",
			innerText: "",
			previousElementSibling: warning,
			parentElement: body,
			matches: () => false,
			querySelector: () => null,
		};
		const form = {
			tagName: "FORM",
			innerText: "一般お問い合わせフォーム",
			previousElementSibling: null,
			parentElement: null,
			getRootNode: () => ({ host }),
		};

		const result = readContext.call(form, 200);
		expect(result).toContain("営業利用は禁止です");
		expect(result).not.toContain("採用お問い合わせ専用サイト");
	});

	test("keeps form text ahead of oversized preceding context", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_CONTEXT_FUNCTION})`,
		) as (this: object, maxLength: number) => string;
		const previous = {
			tagName: "DIV",
			innerText: "x".repeat(500),
			previousElementSibling: null,
			matches: () => false,
			querySelector: () => null,
		};
		const form = {
			tagName: "FORM",
			innerText: "営業目的の利用は禁止です",
			previousElementSibling: previous,
			parentElement: { tagName: "BODY" },
		};

		expect(readContext.call(form, 80)).toContain("営業目的の利用は禁止です");
	});

	test("finds the iframe element that owns a discovered form frame", () => {
		expect(
			findCdpFrameOwnerBackendNodeId(
				{
					backendNodeId: 1,
					nodeName: "#document",
					children: [
						{
							backendNodeId: 2,
							nodeName: "IFRAME",
							contentDocument: {
								backendNodeId: 3,
								nodeName: "#document",
								frameId: "child-frame",
							},
						},
					],
				},
				"child-frame",
			),
		).toBe(2);
	});

	test("discovers controls inside a closed shadow root", () => {
		const discovery = discoverCdpForms(
			{
				backendNodeId: 1,
				nodeName: "#document",
				frameId: "frame-main",
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
				frameId: "frame-main",
				fields: [
					{ backendNodeId: 3, tag: "input" },
					{ backendNodeId: 6, tag: "textarea" },
					{ backendNodeId: 7, tag: "button" },
					{ backendNodeId: 8, tag: "input" },
				],
			},
		]);
	});

	test("tracks the owning frame for top and iframe forms", () => {
		const discovery = discoverCdpForms(
			{
				backendNodeId: 1,
				nodeName: "#document",
				children: [
					{
						backendNodeId: 2,
						nodeName: "FORM",
						children: [{ backendNodeId: 3, nodeName: "INPUT" }],
					},
					{
						backendNodeId: 4,
						nodeName: "IFRAME",
						frameId: "frame-child",
						contentDocument: {
							backendNodeId: 5,
							nodeName: "#document",
							children: [
								{
									backendNodeId: 6,
									nodeName: "FORM",
									children: [{ backendNodeId: 7, nodeName: "INPUT" }],
								},
							],
						},
					},
				],
			},
			"https://example.com/",
			"frame-main",
		);

		expect(discovery.forms.map(({ frameId }) => frameId)).toEqual([
			"frame-main",
			"frame-child",
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

	test("filters links before applying the observation limit", () => {
		const rejected = Array.from({ length: 25 }, (_, index) => ({
			backendNodeId: index + 2,
			nodeName: "A",
			attributes: ["href", `https://external-${index}.test/form`],
		}));
		const links = discoverCdpNavigationLinks(
			{
				backendNodeId: 1,
				nodeName: "#document",
				children: [
					...rejected,
					{
						backendNodeId: 100,
						nodeName: "A",
						attributes: ["href", "/contact"],
						children: [
							{
								backendNodeId: 101,
								nodeName: "#text",
								nodeValue: "お問い合わせ",
							},
						],
					},
				],
			},
			"https://example.com/",
			(url) => new URL(url).hostname === "example.com",
		);

		expect(links).toEqual([
			{ url: "https://example.com/contact", text: "お問い合わせ" },
		]);
	});

	test("skips oversized links without consuming the observation limit", () => {
		const links = discoverCdpNavigationLinks(
			{
				backendNodeId: 1,
				nodeName: "#document",
				children: [
					{
						backendNodeId: 2,
						nodeName: "A",
						attributes: ["href", `/${"x".repeat(2_048)}`],
					},
					{
						backendNodeId: 3,
						nodeName: "A",
						attributes: ["href", "/contact"],
					},
				],
			},
			"https://example.com/",
			() => true,
			1,
		);

		expect(links).toEqual([{ url: "https://example.com/contact", text: "" }]);
	});

	test("resolves links against each document base URL", () => {
		const links = discoverCdpNavigationLinks(
			{
				backendNodeId: 1,
				nodeName: "#document",
				baseURL: "https://example.com/",
				children: [
					{
						backendNodeId: 2,
						nodeName: "A",
						attributes: ["href", "contact"],
					},
					{
						backendNodeId: 3,
						nodeName: "IFRAME",
						contentDocument: {
							backendNodeId: 4,
							nodeName: "#document",
							baseURL: "https://forms.example.com/directory/",
							children: [
								{
									backendNodeId: 5,
									nodeName: "A",
									attributes: ["href", "contact"],
								},
							],
						},
					},
				],
			},
			"https://example.com/landing/index.html",
			() => true,
		);

		expect(links).toEqual([
			{ url: "https://example.com/contact", text: "" },
			{ url: "https://forms.example.com/directory/contact", text: "" },
		]);
	});

	test("discovers body nodes in the top document and iframe documents", () => {
		expect(
			discoverCdpBodyBackendNodeIds({
				backendNodeId: 1,
				nodeName: "#document",
				children: [{ backendNodeId: 2, nodeName: "BODY" }],
				contentDocument: {
					backendNodeId: 3,
					nodeName: "#document",
					children: [{ backendNodeId: 4, nodeName: "BODY" }],
				},
			}),
		).toEqual([2, 4]);
	});

	test("limits confirmation body nodes to the submitted frame", () => {
		const root = {
			backendNodeId: 1,
			nodeName: "#document",
			frameId: "top-frame",
			children: [
				{ backendNodeId: 2, nodeName: "BODY" },
				{
					backendNodeId: 3,
					nodeName: "IFRAME",
					frameId: "form-frame",
					contentDocument: {
						backendNodeId: 4,
						nodeName: "#document",
						frameId: "form-frame",
						children: [{ backendNodeId: 5, nodeName: "BODY" }],
					},
				},
			],
		};

		expect(discoverCdpBodyBackendNodeIds(root, 20, "top-frame")).toEqual([2]);
		expect(discoverCdpBodyBackendNodeIds(root, 20, "form-frame")).toEqual([5]);
	});
});

describe("BrowserUseCdpDriver child target policy", () => {
	test("keeps delayed GETs blocked while allowing only the claimed operation", () => {
		expect(shouldBlockNonSubmitRequest(true, false, false)).toBe(true);
		expect(shouldBlockNonSubmitRequest(true, true, false)).toBe(false);
		expect(shouldBlockNonSubmitRequest(true, false, true)).toBe(false);
		expect(shouldBlockNonSubmitRequest(true, false, false, true)).toBe(false);
		expect(shouldBlockNonSubmitRequest(false, false, false)).toBe(false);
	});

	test("allows only a direct safe redirect from the claimed submit request", () => {
		const paused = {
			requestId: "redirect-1",
			redirectedRequestId: "submit-1",
			resourceType: "Document",
			frameId: "form-frame",
			request: { url: "https://example.com/complete", method: "GET" },
		};
		expect(
			isAuthorizedSubmissionRedirect(paused, "submit-1", "form-frame"),
		).toBe(true);
		expect(isAuthorizedSubmissionRedirect(paused, "other", "form-frame")).toBe(
			false,
		);
		expect(
			isAuthorizedSubmissionRedirect(
				{ ...paused, frameId: "other-frame" },
				"submit-1",
				"form-frame",
			),
		).toBe(false);
		expect(
			isAuthorizedSubmissionRedirect(
				{ ...paused, request: { ...paused.request, method: "POST" } },
				"submit-1",
				"form-frame",
			),
		).toBe(false);
	});

	test("allows only the exact trusted top-frame document navigation", () => {
		const expected = {
			url: "https://example.com/contact?step=2",
			frameId: "top-frame",
		};
		expect(
			isExpectedNavigationDocumentRequest(
				{
					url: "https://example.com/contact?step=2",
					method: "GET",
				},
				"Document",
				"top-frame",
				expected,
			),
		).toBe(true);
		for (const request of [
			{ url: "https://example.com/side-effect", method: "GET" },
			{ url: "https://example.com/contact?step=2", method: "POST" },
		]) {
			expect(
				isExpectedNavigationDocumentRequest(
					request,
					"Document",
					"top-frame",
					expected,
				),
			).toBe(false);
		}
		expect(
			isExpectedNavigationDocumentRequest(
				{
					url: "https://example.com/contact?step=2",
					method: "GET",
				},
				"Fetch",
				"top-frame",
				expected,
			),
		).toBe(false);
		expect(
			isExpectedNavigationDocumentRequest(
				{
					url: "https://example.com/contact?step=2",
					method: "GET",
				},
				"Document",
				"other-frame",
				expected,
			),
		).toBe(false);
	});

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
		expect(() =>
			assertExpectedSubmissionRequest(
				{
					url: "https://example.com/search?company=AnyReach",
					method: "GET",
				},
				createExpectedSubmissionRequest("https://example.com/search", "get"),
			),
		).not.toThrow();
		expect(() =>
			assertExpectedSubmissionRequest(
				{ url: "https://example.com/other", method: "GET" },
				createExpectedSubmissionRequest("https://example.com/search", "get"),
			),
		).toThrow();
	});

	test("claims only the first expected GET document navigation", () => {
		const expected = createExpectedSubmissionRequest(
			"https://example.com/search",
			"get",
		);
		const request = {
			url: "https://example.com/search?company=AnyReach",
			method: "GET",
		};
		const disposition = (
			resourceType: string,
			frameId: string,
			count: number,
			inFlight: boolean,
		) =>
			getSubmissionRequestDisposition(
				request,
				resourceType,
				frameId,
				expected,
				"form-frame",
				true,
				true,
				count,
				inFlight,
			);

		expect(disposition("Document", "form-frame", 0, false)).toBe("claim");
		expect(disposition("Document", "other-frame", 0, false)).toBe("ignore");
		expect(disposition("Document", "", 0, false)).toBe("block");
		expect(disposition("Fetch", "form-frame", 0, false)).toBe("ignore");
		expect(disposition("Image", "form-frame", 0, false)).toBe("ignore");
		expect(disposition("Script", "form-frame", 0, false)).toBe("ignore");
		expect(disposition("Document", "form-frame", 0, true)).toBe("block");
		expect(disposition("Document", "form-frame", 1, false)).toBe("block");
	});

	test("classifies uncertain submissions without persisting request data", () => {
		expect(submitUncertainReasonCode("dom", false)).toBe(
			"SUBMIT_DOM_REQUEST_NOT_OBSERVED",
		);
		expect(submitUncertainReasonCode("mouse", false)).toBe(
			"SUBMIT_MOUSE_REQUEST_NOT_OBSERVED",
		);
		expect(submitUncertainReasonCode("enter", false)).toBe(
			"SUBMIT_ENTER_REQUEST_NOT_OBSERVED",
		);
		expect(submitUncertainReasonCode("mouse", true)).toBe(
			"SUBMIT_CONFIRMATION_NOT_OBSERVED",
		);
		expect(submitUncertainReasonCode("mouse", false, "expected_request")).toBe(
			"SUBMIT_EXPECTED_REQUEST_BLOCKED",
		);
		expect(submitUncertainReasonCode("mouse", false, "network_policy")).toBe(
			"SUBMIT_NETWORK_POLICY_BLOCKED",
		);
		expect(submitUncertainReasonCode("mouse", true, "expected_request")).toBe(
			"SUBMIT_CONFIRMATION_NOT_OBSERVED",
		);
	});

	test("activates only a connected native submit control through the DOM", () => {
		let nativeClickCount = 0;
		class TestHTMLElement {
			click() {
				nativeClickCount += 1;
			}
		}
		const activateSubmit = runInNewContext(`(${ACTIVATE_SUBMIT_FUNCTION})`, {
			getComputedStyle: (element: { visible?: boolean }) => ({
				display: element.visible === false ? "none" : "block",
				visibility: "visible",
				opacity: "1",
			}),
			HTMLElement: TestHTMLElement,
			URL,
		}) as (
			this: {
				isConnected: boolean;
				disabled: boolean;
				form: {
					action: string;
					method: string;
					getAttribute(name: string): string | null;
				} | null;
				tagName: string;
				type: string;
				visible?: boolean;
				getBoundingClientRect(): { width: number; height: number };
				getAttribute(name: string): string | null;
				hasAttribute(name: string): boolean;
				click(): void;
			},
			input: { isConnected: boolean; form: object },
			action: string,
			method: string,
		) => boolean;
		const form = {
			action: "https://example.com/submit#fragment",
			method: "post",
			getAttribute: () => null,
		};
		let instanceClickCount = 0;
		const submit = Object.assign(new TestHTMLElement(), {
			isConnected: true,
			disabled: false,
			form,
			tagName: "BUTTON",
			type: "submit",
			getBoundingClientRect: () => ({ width: 100, height: 40 }),
			getAttribute: () => null,
			hasAttribute: () => false,
			click() {
				instanceClickCount += 1;
			},
		});
		const input = { isConnected: true, form };
		const activate = (candidate = submit, candidateInput = input) =>
			activateSubmit.call(
				candidate,
				candidateInput,
				"https://example.com/submit",
				"POST",
			);

		expect(activate()).toBe(true);
		expect(nativeClickCount).toBe(1);
		expect(instanceClickCount).toBe(0);
		expect(
			activate(
				Object.assign(new TestHTMLElement(), submit, { disabled: true }),
			),
		).toBe(false);
		expect(
			activate(
				Object.assign(new TestHTMLElement(), submit, { type: "button" }),
			),
		).toBe(false);
		expect(
			activate(
				Object.assign(new TestHTMLElement(), submit, { visible: false }),
			),
		).toBe(false);
		expect(activate(submit, { ...input, form: {} })).toBe(false);
		expect(
			activate(
				Object.assign(new TestHTMLElement(), submit, {
					form: { ...form, action: "https://example.com/other" },
				}),
			),
		).toBe(false);
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

	test("activates checkbox and radio inputs through their DOM click semantics", () => {
		const events: string[] = [];
		const setChecked = runInNewContext(`(${SET_CHECKED_VALUE_FUNCTION})`) as (
			this: {
				tagName: string;
				type: string;
				checked: boolean;
				click(): void;
			},
			checked: boolean,
		) => boolean;
		const checkbox = {
			tagName: "INPUT",
			type: "checkbox",
			checked: false,
			click() {
				this.checked = !this.checked;
				events.push("click", "input", "change");
			},
		};

		expect(setChecked.call(checkbox, true)).toBe(true);
		expect(checkbox.checked).toBe(true);
		expect(events).toEqual(["click", "input", "change"]);
		expect(setChecked.call(checkbox, true)).toBe(true);
		expect(events).toEqual(["click", "input", "change"]);
		expect(setChecked.call(checkbox, false)).toBe(true);
		expect(checkbox.checked).toBe(false);

		const radio = { ...checkbox, type: "radio", checked: false };
		expect(setChecked.call(radio, true)).toBe(true);
		expect(setChecked.call(radio, false)).toBe(false);

		const controlledCheckbox = {
			...checkbox,
			checked: false,
			click() {
				this.checked = true;
				this.checked = false;
			},
		};
		expect(setChecked.call(controlledCheckbox, true)).toBe(false);
		expect(setChecked.call({ ...checkbox, type: "text" }, true)).toBe(false);
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
	test("accepts only a navigation of the submitted form frame", () => {
		const revisions = new Map([
			["form-frame", 2],
			["other-frame", 5],
		]);
		expect(hasExpectedFrameNavigated("form-frame", 1, revisions)).toBe(true);
		expect(hasExpectedFrameNavigated("form-frame", 2, revisions)).toBe(false);
		expect(
			hasExpectedFrameNavigated("form-frame", 1, new Map([["other-frame", 5]])),
		).toBe(false);
		expect(hasExpectedFrameNavigated(undefined, 0, revisions)).toBe(false);
	});

	test("retries submit mouse preparation for transient element mismatches", async () => {
		let attempts = 0;
		let waits = 0;
		const reportedAttempts: number[] = [];
		const point = await retrySubmitMousePreparation(
			async () => {
				attempts += 1;
				if (attempts < 3) throw new BrowserElementError();
				return { x: 10, y: 20 };
			},
			async () => {
				waits += 1;
			},
			(attempt) => reportedAttempts.push(attempt),
		);

		expect(point).toEqual({ x: 10, y: 20 });
		expect(attempts).toBe(3);
		expect(waits).toBe(2);
		expect(reportedAttempts).toEqual([1, 2, 3]);
	});

	test("stops submit mouse preparation after three mismatches", async () => {
		let attempts = 0;
		let waits = 0;
		const preparation = retrySubmitMousePreparation(
			async () => {
				attempts += 1;
				throw new BrowserElementError();
			},
			async () => {
				waits += 1;
			},
		);

		await expect(preparation).rejects.toBeInstanceOf(BrowserElementError);
		expect(attempts).toBe(3);
		expect(waits).toBe(2);
	});

	test("does not retry a successful submit mouse preparation", async () => {
		let attempts = 0;
		let waits = 0;
		await retrySubmitMousePreparation(
			async () => {
				attempts += 1;
			},
			async () => {
				waits += 1;
			},
		);

		expect(attempts).toBe(1);
		expect(waits).toBe(0);
	});

	test("does not retry a non-element submit preparation failure", async () => {
		let attempts = 0;
		let waits = 0;
		const preparation = retrySubmitMousePreparation(
			async () => {
				attempts += 1;
				throw new Error("CDP connection closed");
			},
			async () => {
				waits += 1;
			},
		);

		await expect(preparation).rejects.toThrow("CDP connection closed");
		expect(attempts).toBe(1);
		expect(waits).toBe(0);
	});

	test("logs only the activation strategy and allowlisted failure stage", () => {
		expect(
			JSON.parse(createSubmitActivationFailureLog("mouse", "hit_test")),
		).toEqual({
			event: "browser_submit_activation_failure",
			activationStrategy: "mouse",
			stage: "hit_test",
		});
	});

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

	test("records a submission request only after CDP continues it", async () => {
		let observed = false;
		await expect(
			continueSubmissionRequest(
				async () => {
					throw new Error("CDP continue failed");
				},
				() => {
					observed = true;
				},
			),
		).rejects.toThrow("CDP continue failed");
		expect(observed).toBe(false);

		await continueSubmissionRequest(
			async () => undefined,
			() => {
				observed = true;
			},
		);
		expect(observed).toBe(true);
	});

	test("classifies a confirmation read failure without persisting its message", async () => {
		const failure = readSubmissionConfirmation(
			0,
			true,
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
			0,
			true,
			async () => 1,
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

	test("does not accept confirmation without an allowed request", async () => {
		await expect(
			readSubmissionConfirmation(
				0,
				false,
				async () => 1,
				async () => "https://example.com/contact",
			),
		).resolves.toBeNull();
	});

	test("does not accept confirmation bodies that existed before submit", async () => {
		await expect(
			readSubmissionConfirmation(
				1,
				true,
				async () => 1,
				async () => "https://example.com/contact",
			),
		).resolves.toBeNull();
	});

	test("does not accept an existing confirmation before the submitted document updates", async () => {
		await expect(
			readSubmissionConfirmation(
				1,
				true,
				async () => 1,
				async () => "https://example.com/contact",
				false,
			),
		).resolves.toBeNull();
	});

	test("accepts an existing confirmation after the submitted document updates", async () => {
		await expect(
			readSubmissionConfirmation(
				1,
				true,
				async () => 1,
				async () => "https://example.com/submit?name=test",
				true,
			),
		).resolves.toEqual({
			outcome: "sent",
			formUrl: "https://example.com/submit?name=test",
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

describe("BrowserUseCdpDriver screenshot capture", () => {
	test("captures a viewport-only JPEG and decodes the payload", async () => {
		const requests: Array<Record<string, unknown>> = [];

		const bytes = await captureCdpScreenshot(async (params) => {
			requests.push(params);
			return { data: btoa(String.fromCharCode(1, 2, 255)) };
		});

		expect(requests).toEqual([
			{
				format: "jpeg",
				quality: 80,
				captureBeyondViewport: false,
				fromSurface: true,
			},
		]);
		expect([...bytes]).toEqual([1, 2, 255]);
	});

	test("wraps a payload-too-large failure without retrying, since the connection is already closed", async () => {
		let attempts = 0;

		const failure = await captureCdpScreenshot(async () => {
			attempts += 1;
			throw new BrowserUseCdpPayloadTooLargeError();
		}).catch((error: unknown) => error);

		expect(attempts).toBe(1);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(BrowserUseCdpPayloadTooLargeError);
		expect((failure as Error).message).toBe("Browser screenshot failed");
	});

	test("rejects an empty screenshot payload without retrying", async () => {
		let attempts = 0;

		await expect(
			captureCdpScreenshot(async (): Promise<CdpScreenshotResult> => {
				attempts += 1;
				return {};
			}),
		).rejects.toThrow("Browser screenshot failed");
		expect(attempts).toBe(1);
	});
});
