import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { hasNewSubmissionConfirmation } from "../src/browser-submit-confirmation";
import {
	assertCdpMessageWithinLimit,
	BrowserUseCdpClosedError,
	BrowserUseCdpConnection,
	BrowserUseCdpPayloadTooLargeError,
	BrowserUseCdpUpgradeRejectedError,
	classifyCdpCloseReason,
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
	BrowserUseCdpDriver,
	type CdpScreenshotResult,
	CHECK_FORM_VALIDITY_FUNCTION,
	captureCdpScreenshot,
	centerOfQuad,
	collectCdpFrameParentIds,
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
	READ_FORM_PROHIBITION_REASON_CODES_FUNCTION,
	readPageText,
	readSubmissionConfirmation,
	retrySubmitMousePreparation,
	runSubmissionActivationWithinPermissionWindow,
	SET_CHECKED_VALUE_FUNCTION,
	shouldBlockNonSubmitRequest,
	submitUncertainReasonCode,
	toFormSnapshot,
	toObservedFieldState,
	waitForSubmissionConfirmation,
} from "../src/browser-use-cdp-driver";
import {
	BrowserUseApiError,
	type BrowserUseClient,
	BrowserUseRequestError,
	BrowserUseResponseError,
} from "../src/browser-use-client";
import type { Job } from "../src/job";
import {
	BrowserElementError,
	BrowserSubmitDiagnosticError,
	isReviewComparableField,
} from "../src/restricted-browser";

describe("BrowserUse CDP payload and DOM discovery", () => {
	test("reads preceding warnings and form text without including a footer", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];

		expect(
			readContext.call({
				previousElementSibling: {
					innerText: "営業利用は禁止です",
					previousElementSibling: null,
					matches: () => false,
					querySelector: () => null,
				},
				innerText: "一般お問い合わせフォーム",
				parentElement: { tagName: "BODY" },
			}),
		).toEqual(["SALES_PROHIBITED"]);
	});

	test("detects a warning split across preceding siblings", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const warningStart = {
			innerText: "営業目的での利用は",
			previousElementSibling: null,
			matches: () => false,
			querySelector: () => null,
		};
		const warningEnd = {
			innerText: "禁止しています",
			previousElementSibling: warningStart,
			matches: () => false,
			querySelector: () => null,
		};

		expect(
			readContext.call({
				innerText: "一般お問い合わせフォーム",
				previousElementSibling: warningEnd,
				parentElement: { tagName: "BODY" },
			}),
		).toEqual(["SALES_PROHIBITED"]);
	});

	test("uses pristine intrinsics outside a page realm with modified prototypes", () => {
		const pageRealm = runInNewContext(`(() => {
			Array.prototype.some = () => false;
			Array.prototype.includes = () => true;
			return {
				innerText: "営業目的での利用は禁止です",
				previousElementSibling: null,
				parentElement: { tagName: "BODY" },
			};
		})()`);
		const isolatedReadContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];

		expect(isolatedReadContext.call(pageRealm)).toEqual(["SALES_PROHIBITED"]);
	});

	test("crosses a shadow host but excludes unrelated header context", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
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

		expect(readContext.call(form)).toEqual(["SALES_PROHIBITED"]);
	});

	test("keeps an outside warning separate from oversized form text", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const previous = {
			tagName: "ASIDE",
			innerText: "営業目的の利用は禁止です",
			previousElementSibling: null,
			matches: () => false,
			querySelector: () => null,
		};
		const form = {
			tagName: "FORM",
			innerText: "x".repeat(500),
			previousElementSibling: previous,
			parentElement: { tagName: "BODY" },
		};

		expect(readContext.call(form)).toEqual(["SALES_PROHIBITED"]);
	});

	test("returns bounded reason codes for an oversized source", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const form = {
			tagName: "FORM",
			innerText: `${"x".repeat(5_000_000)}営業目的の利用は禁止です${"y".repeat(5_000_000)}`,
			previousElementSibling: null,
			parentElement: { tagName: "BODY" },
		};

		const result = readContext.call(form);
		expect(result).toEqual(["SALES_PROHIBITED"]);
		expect(JSON.stringify(result).length).toBeLessThan(100);
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

	test("maps nested frames to the isolated world of their parent", () => {
		expect(
			collectCdpFrameParentIds({
				frame: { id: "top" },
				childFrames: [
					{
						frame: { id: "child" },
						childFrames: [{ frame: { id: "grandchild" } }],
					},
				],
			}),
		).toEqual(
			new Map([
				["top", undefined],
				["child", "top"],
				["grandchild", "child"],
			]),
		);
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

		expect(
			discoverCdpBodyBackendNodeIds(root, 20, "top-frame", "top-frame"),
		).toEqual([2]);
		expect(
			discoverCdpBodyBackendNodeIds(root, 20, "form-frame", "top-frame"),
		).toEqual([5]);
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
	test("waits beyond the former five-second window for a late confirmation", async () => {
		let elapsed = 0;
		let reads = 0;
		const result = await waitForSubmissionConfirmation(
			async () => {
				reads += 1;
				return elapsed >= 6_000
					? {
							outcome: "sent" as const,
							formUrl: "https://example.com/complete",
						}
					: null;
			},
			async (milliseconds) => {
				elapsed += milliseconds;
			},
			15_000,
			() => elapsed,
		);

		expect(result).toEqual({
			outcome: "sent",
			formUrl: "https://example.com/complete",
		});
		expect(elapsed).toBe(6_000);
		expect(reads).toBe(6);
	});

	test("stops confirmation checks at the configured deadline", async () => {
		let elapsed = 0;
		let reads = 0;
		const result = await waitForSubmissionConfirmation(
			async () => {
				reads += 1;
				return null;
			},
			async (milliseconds) => {
				elapsed += milliseconds;
			},
			3_500,
			() => elapsed,
		);

		expect(result).toBeNull();
		expect(elapsed).toBe(3_500);
		expect(reads).toBe(5);
	});

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

describe("BrowserUseCdpDriver page text", () => {
	test("keeps a short page text untruncated", () => {
		expect(readPageText("Contact us")).toEqual({
			text: "Contact us",
			truncated: false,
		});
	});

	test("reports truncation at the observation limit", () => {
		const raw = "a".repeat(20_001);

		const result = readPageText(raw);

		expect(result.truncated).toBe(true);
		expect(result.text).toHaveLength(20_000);
	});

	test("does not report truncation for text exactly at the limit", () => {
		const result = readPageText("a".repeat(20_000));

		expect(result.truncated).toBe(false);
		expect(result.text).toHaveLength(20_000);
	});
});

describe("BrowserUseCdpDriver reviewed field comparison", () => {
	test("excludes the controls that submit the form", () => {
		expect(isReviewComparableField("input", "text")).toBe(true);
		expect(isReviewComparableField("input", "checkbox")).toBe(true);
		expect(isReviewComparableField("textarea", null)).toBe(true);
		expect(isReviewComparableField("select", null)).toBe(true);
		expect(isReviewComparableField("input", "submit")).toBe(false);
		expect(isReviewComparableField("input", "image")).toBe(false);
		expect(isReviewComparableField("button", null)).toBe(false);
		expect(isReviewComparableField("button", "button")).toBe(false);
	});

	test("reads the live value and checked state of a comparable element", () => {
		expect(
			toObservedFieldState("fa-0-0", elementState({ value: "Hello" })),
		).toEqual({ elementId: "fa-0-0", value: "Hello", checked: false });
		expect(
			toObservedFieldState(
				"fa-0-2",
				elementState({ type: "checkbox", checked: true }),
			),
		).toEqual({ elementId: "fa-0-2", value: "", checked: true });
	});

	test("never exposes a password value to the comparison", () => {
		expect(
			toObservedFieldState(
				"fa-0-3",
				elementState({ type: "password", value: "secret" }),
			),
		).toEqual({ elementId: "fa-0-3", value: "", checked: false });
	});

	test("drops a submit control and an unusable element", () => {
		expect(
			toObservedFieldState(
				"fa-0-1",
				elementState({ type: "submit", submitLike: true }),
			),
		).toBeNull();
		expect(
			toObservedFieldState("fa-0-4", elementState({ ok: false })),
		).toBeNull();
	});
});

function elementState(
	overrides: Partial<Parameters<typeof toObservedFieldState>[1]> = {},
) {
	return {
		ok: true,
		tag: "input",
		type: "text",
		value: "",
		checked: false,
		submitLike: false,
		...overrides,
	};
}

describe("BrowserUseCdpDriver form snapshot", () => {
	test("keeps DOM order and includes hidden and disabled controls", () => {
		const snapshot = toFormSnapshot([
			snapshotElement({ type: "hidden", name: "csrf", value: "token" }),
			snapshotElement({ name: "message", value: "Hello" }),
			snapshotElement({ tag: "button", type: "submit", value: "Send" }),
		]);

		expect(JSON.parse(snapshot)).toEqual([
			["input", "hidden", "csrf", "token", false, false],
			["input", "text", "message", "Hello", false, false],
			["button", "submit", "", "Send", false, false],
		]);
		expect(snapshot).not.toBe(
			toFormSnapshot([
				snapshotElement({ name: "message", value: "Hello" }),
				snapshotElement({ type: "hidden", name: "csrf", value: "token" }),
				snapshotElement({ tag: "button", type: "submit", value: "Send" }),
			]),
		);
	});

	test("changes when a control is added, disabled, or renamed", () => {
		const base = [snapshotElement({ name: "message", value: "Hello" })];

		expect(toFormSnapshot(base)).not.toBe(
			toFormSnapshot([...base, snapshotElement({ type: "hidden" })]),
		);
		expect(toFormSnapshot(base)).not.toBe(
			toFormSnapshot([
				snapshotElement({ name: "message", value: "Hello", disabled: true }),
			]),
		);
		expect(toFormSnapshot(base)).not.toBe(
			toFormSnapshot([snapshotElement({ name: "renamed", value: "Hello" })]),
		);
	});

	test("masks a password value and records an unresolvable control", () => {
		expect(
			JSON.parse(
				toFormSnapshot([
					snapshotElement({ type: "password", value: "secret" }),
					snapshotElement({ ok: false }),
					null,
				]),
			),
		).toEqual([["input", "password", "", "", false, false], null, null]);
	});
});

function snapshotElement(
	overrides: Partial<Parameters<typeof toFormSnapshot>[0][number]> = {},
) {
	return {
		ok: true,
		tag: "input",
		type: "text",
		name: null,
		value: "",
		checked: false,
		disabled: false,
		...overrides,
	};
}

const connectJob: Job = {
	id: "connect-retry",
	companyId: "connect-retry",
	companyName: "Connect retry fixture",
	targetUrl: "https://example.com/contact",
	targetDomain: "example.com",
	allowedHosts: [],
	payload: {},
	status: "running",
	attemptCount: 1,
	submitReviewDenialCount: 0,
	runToken: "connect-retry",
	result: null,
	createdAt: "2026-09-03T00:00:00.000Z",
	updatedAt: "2026-09-03T00:00:00.000Z",
};

interface FakeBrowserUseClientOptions {
	createFailures?: ReadonlyArray<unknown>;
	cdpUrl?: string;
	stopError?: unknown;
	activeSessions?: ReadonlyArray<{ id: string; jobId?: string }>;
	listError?: unknown;
	onCreate?: () => void;
}

class FakeBrowserUseClient {
	createCount = 0;
	readonly createdMetadata: Array<Record<string, string>> = [];
	readonly createdTimeouts: number[] = [];
	readonly stopped: Array<{ id: string; hasSignal: boolean }> = [];
	readonly listedFilters: Array<string | undefined> = [];

	constructor(private readonly options: FakeBrowserUseClientOptions = {}) {}

	get onCreate(): (() => void) | undefined {
		return this.options.onCreate;
	}

	async createBrowser(options: {
		timeoutMinutes?: number;
		metadata?: Record<string, string>;
		signal?: AbortSignal;
	}): Promise<unknown> {
		const index = this.createCount;
		this.createCount += 1;
		this.createdMetadata.push(options.metadata ?? {});
		this.createdTimeouts.push(options.timeoutMinutes ?? 0);
		this.options.onCreate?.();
		const failure = this.options.createFailures?.[index];
		if (failure) throw failure;
		return this.#session(`session-${index + 1}`, options.metadata ?? {});
	}

	async stopBrowser(sessionId: string, signal?: AbortSignal): Promise<unknown> {
		this.stopped.push({ id: sessionId, hasSignal: Boolean(signal) });
		if (this.options.stopError) throw this.options.stopError;
		return this.#session(sessionId, {});
	}

	async listBrowsers(status?: "active" | "stopped"): Promise<unknown[]> {
		this.listedFilters.push(status);
		if (this.options.listError) throw this.options.listError;
		return (this.options.activeSessions ?? []).map((session) =>
			this.#session(
				session.id,
				session.jobId === undefined ? {} : { jobId: session.jobId },
			),
		);
	}

	#session(id: string, metadata: Record<string, string>): unknown {
		return {
			id,
			status: "active",
			cdpUrl: this.options.cdpUrl ?? "wss://connect.browser-use.com/session",
			liveUrl: null,
			timeoutAt: "2026-09-03T00:12:00.000Z",
			startedAt: "2026-09-03T00:00:00.000Z",
			finishedAt: null,
			metadata,
		};
	}
}

function asClient(client: FakeBrowserUseClient): BrowserUseClient {
	return client as unknown as BrowserUseClient;
}

function captureLogs(): { logs: string[]; restore: () => void } {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (message: unknown) => {
		logs.push(String(message));
	};
	return {
		logs,
		restore: () => {
			console.log = originalLog;
		},
	};
}

function logEvents(logs: readonly string[]): unknown[] {
	return logs.map((entry) => JSON.parse(entry));
}

class FakeCdpConnection {
	closeCount = 0;
	readonly sent: string[] = [];

	constructor(private readonly failure?: Error) {}

	send<TResult>(method: string): Promise<TResult> {
		this.sent.push(method);
		if (this.failure) return Promise.reject(this.failure);
		return Promise.resolve(fakeCdpResponse(method) as TResult);
	}

	on(): () => void {
		return () => {};
	}

	close(): void {
		this.closeCount += 1;
	}
}

function fakeCdpResponse(method: string): unknown {
	switch (method) {
		case "Target.getTargets":
			return { targetInfos: [{ targetId: "target-1", type: "page" }] };
		case "Target.attachToTarget":
			return { sessionId: "session-1" };
		case "Page.getFrameTree":
			return { frameTree: { frame: { id: "frame-1" } } };
		case "Runtime.evaluate":
			return { result: {} };
		default:
			return {};
	}
}

function asConnection(connection: FakeCdpConnection): BrowserUseCdpConnection {
	return connection as unknown as BrowserUseCdpConnection;
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message: unknown) => {
		warnings.push(String(message));
	};
	return {
		warnings,
		restore: () => {
			console.warn = originalWarn;
		},
	};
}

function stubUpgradeFetch(webSocket: FakeWebSocket): typeof fetch {
	return (async () =>
		({
			status: 101,
			webSocket,
		}) as unknown as Response) as unknown as typeof fetch;
}

describe("BrowserUseCdpDriver.connect retries", () => {
	test("retries a closed connection once and then succeeds", async () => {
		const connections: FakeCdpConnection[] = [];
		const delays: number[] = [];
		const captured = captureWarnings();

		let driver: BrowserUseCdpDriver;
		try {
			driver = await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async (ms) => {
					delays.push(ms);
				},
				connectConnection: async () => {
					const connection = new FakeCdpConnection(
						connections.length === 0
							? new Error("Browser Use CDP connection closed")
							: undefined,
					);
					connections.push(connection);
					return asConnection(connection);
				},
			});
		} finally {
			captured.restore();
		}

		expect(driver).toBeInstanceOf(BrowserUseCdpDriver);
		expect(connections).toHaveLength(2);
		expect(connections[0]?.closeCount).toBe(1);
		expect(connections[1]?.closeCount).toBe(0);
		expect(delays).toEqual([10]);
		expect(captured.warnings).toHaveLength(1);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_connect_retry",
			attempt: 1,
			delayMs: 10,
			reason: "CDP_CONNECTION_CLOSED",
		});
	});

	test("throws the last error after four failed attempts", async () => {
		const connections: FakeCdpConnection[] = [];
		const delays: number[] = [];
		const captured = captureWarnings();
		const failure = new Error("Browser Use CDP command timed out");

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async (ms) => {
					delays.push(ms);
				},
				connectConnection: async () => {
					const connection = new FakeCdpConnection(failure);
					connections.push(connection);
					return asConnection(connection);
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBe(failure);
		expect(connections).toHaveLength(4);
		expect(connections.map((connection) => connection.closeCount)).toEqual([
			1, 1, 1, 1,
		]);
		expect(delays).toEqual([10, 20, 30]);
		expect(
			captured.warnings.map(
				(warning) => (JSON.parse(warning) as { attempt: number }).attempt,
			),
		).toEqual([1, 2, 3]);
		expect(
			(JSON.parse(captured.warnings[0] ?? "{}") as { reason?: string }).reason,
		).toBe("CDP_COMMAND_TIMEOUT");
	});

	test("does not retry a rejected endpoint", async () => {
		let connectAttempts = 0;
		const captured = captureWarnings();
		const client = new FakeBrowserUseClient({
			cdpUrl: "wss://connect.example.com/session",
		});

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					connectAttempts += 1;
					return asConnection(new FakeCdpConnection());
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect((caught as Error).message).toBe("Invalid Browser Use CDP endpoint");
		expect(connectAttempts).toBe(0);
		expect(client.createCount).toBe(1);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
		expect(captured.warnings).toEqual([]);
	});

	test("does not retry a payload that is too large", async () => {
		const connections: FakeCdpConnection[] = [];
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					const connection = new FakeCdpConnection(
						new BrowserUseCdpPayloadTooLargeError(),
					);
					connections.push(connection);
					return asConnection(connection);
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseCdpPayloadTooLargeError);
		expect(connections).toHaveLength(1);
		expect(captured.warnings).toEqual([]);
	});
});

class FakeWebSocket {
	readonly sent: string[] = [];
	readonly closeCalls: Array<{ code: number; reason: string }> = [];
	readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

	accept(): void {}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners =
			this.#listeners.get(type) ?? new Set<(event: unknown) => void>();
		listeners.add(listener);
		this.#listeners.set(type, listeners);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code: number, reason: string): void {
		this.closeCalls.push({ code, reason });
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

describe("BrowserUseCdpConnection close logging", () => {
	test("records the close code, reason hint and pending command count", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
		);
		const pending = connection.send("Page.enable");
		const closeReason = "Concurrency limit exceeded for session s-123";
		const captured = captureWarnings();
		try {
			webSocket.emit("close", {
				code: 1006,
				reason: closeReason,
				wasClean: false,
			});
		} finally {
			captured.restore();
		}

		const rejection = await pending.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(BrowserUseCdpClosedError);
		expect((rejection as BrowserUseCdpClosedError).code).toBe(1006);
		expect((rejection as BrowserUseCdpClosedError).reasonHint).toBe("LIMIT");
		expect((rejection as BrowserUseCdpClosedError).retryable).toBe(true);
		expect((rejection as Error).message).toBe(
			"Browser Use CDP connection closed",
		);
		expect(captured.warnings).toHaveLength(1);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_cdp_closed",
			code: 1006,
			reasonLength: closeReason.length,
			reasonHint: "LIMIT",
			wasClean: false,
			pending: 1,
		});
		expect(captured.warnings[0]).not.toContain("s-123");
	});

	test("does not record a close that follows an intentional close", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
		);
		connection.close();
		const captured = captureWarnings();
		try {
			webSocket.emit("close", { code: 1000, reason: "", wasClean: true });
		} finally {
			captured.restore();
		}

		expect(captured.warnings).toEqual([]);
		expect(webSocket.closeCalls).toEqual([
			{ code: 1000, reason: "Form Agent run complete" },
		]);
	});
});

describe("BrowserUseCdpDriver.connect upgrade classification", () => {
	test("does not retry an unauthorized upgrade", async () => {
		let connectAttempts = 0;
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					connectAttempts += 1;
					throw new BrowserUseCdpUpgradeRejectedError(401);
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseCdpUpgradeRejectedError);
		expect((caught as BrowserUseCdpUpgradeRejectedError).status).toBe(401);
		expect(connectAttempts).toBe(1);
		expect(captured.warnings).toEqual([]);
	});

	test("retries an upgrade rejected by a server error", async () => {
		let connectAttempts = 0;
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					connectAttempts += 1;
					throw new BrowserUseCdpUpgradeRejectedError(503);
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect((caught as BrowserUseCdpUpgradeRejectedError).status).toBe(503);
		expect(connectAttempts).toBe(4);
		expect(captured.warnings).toHaveLength(3);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_connect_retry",
			attempt: 1,
			delayMs: 10,
			reason: "CDP_UPGRADE_REJECTED",
			status: 503,
		});
	});

	test("retries a failed upgrade request", async () => {
		let connectAttempts = 0;
		const captured = captureWarnings();
		const failure = new Error("Browser Use CDP connection failed");

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					connectAttempts += 1;
					throw failure;
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBe(failure);
		expect(connectAttempts).toBe(4);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_connect_retry",
			attempt: 1,
			delayMs: 10,
			reason: "CDP_CONNECTION_FAILED",
		});
	});

	test("classifies a rejected upgrade response by its status", async () => {
		let caught: unknown;
		try {
			await BrowserUseCdpConnection.connect(
				"wss://connect.browser-use.com/session",
				(async () =>
					new Response("no", { status: 403 })) as unknown as typeof fetch,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BrowserUseCdpUpgradeRejectedError);
		expect((caught as BrowserUseCdpUpgradeRejectedError).status).toBe(403);
		expect((caught as Error).message).toBe("Browser Use CDP connection failed");
	});

	test("treats a rejected upgrade request as a network failure", async () => {
		let caught: unknown;
		try {
			await BrowserUseCdpConnection.connect(
				"wss://connect.browser-use.com/session",
				(async () => {
					throw new TypeError("Network connection lost");
				}) as unknown as typeof fetch,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(BrowserUseCdpUpgradeRejectedError);
		expect((caught as Error).message).toBe("Browser Use CDP connection failed");
	});
});

describe("BrowserUseCdpConnection close diagnostics", () => {
	test("records the close diagnostics when an error precedes the close", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
		);
		const pending = [
			connection.send("Page.enable"),
			connection.send("DOM.enable"),
		];
		const captured = captureWarnings();
		try {
			webSocket.emit("error", {});
			webSocket.emit("close", {
				code: 1006,
				reason: "abnormal closure",
				wasClean: false,
			});
		} finally {
			captured.restore();
		}

		await expect(Promise.all(pending)).rejects.toThrow(
			"Browser Use CDP connection closed",
		);
		const events = captured.warnings.map(
			(warning) => (JSON.parse(warning) as { event: string }).event,
		);
		expect(events).toEqual(["browser_use_cdp_error", "browser_use_cdp_closed"]);
		expect(JSON.parse(captured.warnings[1] ?? "{}")).toEqual({
			event: "browser_use_cdp_closed",
			code: 1006,
			reasonLength: "abnormal closure".length,
			reasonHint: "OTHER",
			wasClean: false,
			pending: 2,
		});
	});

	test("records the close diagnostics once when a close precedes an error", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
		);
		const pending = connection.send("Page.enable");
		const captured = captureWarnings();
		try {
			webSocket.emit("close", {
				code: 1011,
				reason: "server error",
				wasClean: false,
			});
			webSocket.emit("error", {});
		} finally {
			captured.restore();
		}

		await expect(pending).rejects.toThrow("Browser Use CDP connection closed");
		expect(captured.warnings).toHaveLength(1);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_cdp_closed",
			code: 1011,
			reasonLength: "server error".length,
			reasonHint: "OTHER",
			wasClean: false,
			pending: 1,
		});
	});
});

describe("classifyCdpCloseReason", () => {
	test("maps a supplied reason to a fixed hint without keeping its text", () => {
		expect(classifyCdpCloseReason("")).toBe("NONE");
		expect(classifyCdpCloseReason("   ")).toBe("NONE");
		expect(classifyCdpCloseReason("Concurrency limit reached")).toBe("LIMIT");
		expect(classifyCdpCloseReason("too many concurrent sessions")).toBe(
			"LIMIT",
		);
		expect(classifyCdpCloseReason("Rate exceeded")).toBe("LIMIT");
		expect(classifyCdpCloseReason("monthly quota used")).toBe("LIMIT");
		expect(classifyCdpCloseReason("Unauthorized")).toBe("AUTH");
		expect(classifyCdpCloseReason("forbidden")).toBe("AUTH");
		expect(classifyCdpCloseReason("invalid API key abc123")).toBe("AUTH");
		expect(classifyCdpCloseReason("session timed out")).toBe("TIMEOUT");
		expect(classifyCdpCloseReason("Idle timeout")).toBe("TIMEOUT");
		expect(classifyCdpCloseReason("https://example.com/session/secret")).toBe(
			"OTHER",
		);
	});
});

describe("BrowserUseCdpDriver.connect close classification", () => {
	async function connectWithClose(
		failure: Error,
		options: { signal?: AbortSignal; retryDelaysMs?: number[] } = {},
	): Promise<{ connections: FakeCdpConnection[]; caught: unknown }> {
		const connections: FakeCdpConnection[] = [];
		const captured = captureWarnings();
		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: options.retryDelaysMs ?? [10, 20, 30],
				...(options.signal ? { signal: options.signal } : {}),
				...(options.signal ? {} : { sleep: async () => {} }),
				connectConnection: async () => {
					const connection = new FakeCdpConnection(failure);
					connections.push(connection);
					return asConnection(connection);
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}
		return { connections, caught };
	}

	test("does not retry a policy violation close", async () => {
		const failure = new BrowserUseCdpClosedError(1008, "OTHER");
		const { connections, caught } = await connectWithClose(failure);

		expect(caught).toBe(failure);
		expect(connections).toHaveLength(1);
		expect(connections[0]?.closeCount).toBe(1);
	});

	test("does not retry a close that names an authentication reason", async () => {
		const failure = new BrowserUseCdpClosedError(1006, "AUTH");
		const { connections, caught } = await connectWithClose(failure);

		expect(caught).toBe(failure);
		expect(connections).toHaveLength(1);
	});

	test("retries a close that names a limit reason", async () => {
		const failure = new BrowserUseCdpClosedError(1006, "LIMIT");
		const { connections, caught } = await connectWithClose(failure);

		expect(caught).toBe(failure);
		expect(connections).toHaveLength(4);
		expect(connections.map((connection) => connection.closeCount)).toEqual([
			1, 1, 1, 1,
		]);
	});

	test("stops waiting for the next attempt when the run is aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const startedAt = Date.now();
		const { connections, caught } = await connectWithClose(
			new BrowserUseCdpClosedError(1006, "LIMIT"),
			{ signal: controller.signal, retryDelaysMs: [5_000, 5_000, 5_000] },
		);

		expect((caught as Error).message).toBe(
			"Browser Use CDP connection aborted",
		);
		expect(connections).toHaveLength(1);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});

describe("BrowserUseCdpConnection error before close", () => {
	test("rejects with the close classification when an error precedes the close", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
			20,
		);
		const pending = connection.send("Page.enable");
		const captured = captureWarnings();
		try {
			webSocket.emit("error", {});
			webSocket.emit("close", {
				code: 1008,
				reason: "policy violation",
				wasClean: false,
			});
		} finally {
			captured.restore();
		}

		const rejection = await pending.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(BrowserUseCdpClosedError);
		expect((rejection as BrowserUseCdpClosedError).code).toBe(1008);
		expect((rejection as BrowserUseCdpClosedError).retryable).toBe(false);
	});

	test("falls back to a generic rejection when no close follows the error", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
			20,
		);
		const pending = connection.send("Page.enable");
		const captured = captureWarnings();
		try {
			webSocket.emit("error", {});
		} finally {
			captured.restore();
		}

		const rejection = await pending.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		expect(rejection).not.toBeInstanceOf(BrowserUseCdpClosedError);
		expect((rejection as Error).message).toBe(
			"Browser Use CDP connection closed",
		);
		expect(
			captured.warnings.map((warning) => JSON.parse(warning).event),
		).toEqual(["browser_use_cdp_error"]);
	});

	test("does not retry a connect attempt that errors before a policy close", async () => {
		const sockets: FakeWebSocket[] = [];
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(new FakeBrowserUseClient()),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					const webSocket = new FakeWebSocket();
					sockets.push(webSocket);
					const connection = await BrowserUseCdpConnection.connect(
						"wss://connect.browser-use.com/session",
						stubUpgradeFetch(webSocket),
						20,
					);
					setTimeout(() => {
						webSocket.emit("error", {});
						webSocket.emit("close", {
							code: 1008,
							reason: "policy violation",
							wasClean: false,
						});
					}, 0);
					return connection;
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseCdpClosedError);
		expect((caught as BrowserUseCdpClosedError).code).toBe(1008);
		expect(sockets).toHaveLength(1);
		// The remote already closed the socket, so the driver does not close it again.
		expect(sockets[0]?.closeCalls).toEqual([]);
	});
});

class HangingCdpConnection {
	closeCount = 0;
	#rejects: Array<(error: Error) => void> = [];

	send<TResult>(method: string): Promise<TResult> {
		if (method === "Target.getTargets" || method === "Target.attachToTarget") {
			return Promise.resolve(fakeCdpResponse(method) as TResult);
		}
		return new Promise<TResult>((_, reject) => {
			this.#rejects.push(reject);
		});
	}

	on(): () => void {
		return () => {};
	}

	close(): void {
		this.closeCount += 1;
		const rejects = this.#rejects;
		this.#rejects = [];
		for (const reject of rejects) {
			reject(new Error("Browser Use CDP connection is closed"));
		}
	}
}

describe("BrowserUseCdpDriver session lifecycle", () => {
	test("creates a session, resolves its debugger endpoint and stops it on close", async () => {
		const client = new FakeBrowserUseClient({
			cdpUrl: "https://cdp.browser-use.com/session-1/",
		});
		const versionRequests: string[] = [];
		const connections: FakeCdpConnection[] = [];
		const captured = captureLogs();

		try {
			const driver = await BrowserUseCdpDriver.connect(
				"api-key",
				connectJob,
				true,
				{
					client: asClient(client),
					fetcher: async (url) => {
						versionRequests.push(url);
						return Response.json({
							webSocketDebuggerUrl:
								"ws://cdp.browser-use.com/devtools/browser/abc",
						});
					},
					connectConnection: async (webSocketUrl) => {
						expect(webSocketUrl).toBe(
							"wss://cdp.browser-use.com/devtools/browser/abc",
						);
						const connection = new FakeCdpConnection();
						connections.push(connection);
						return asConnection(connection);
					},
				},
			);
			await driver.close();
		} finally {
			captured.restore();
		}

		expect(versionRequests).toEqual([
			"https://cdp.browser-use.com/session-1/json/version",
		]);
		expect(client.createdTimeouts).toEqual([12]);
		expect(client.createdMetadata).toEqual([
			{ jobId: connectJob.id, dryRun: "true" },
		]);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
		expect(connections[0]?.closeCount).toBe(1);
		expect(logEvents(captured.logs)).toEqual([
			{ event: "browser_use_session_created", cdpScheme: "https", attempt: 0 },
			{
				event: "browser_use_session_stopped",
				ok: true,
				durationMs: expect.any(Number),
			},
		]);
	});

	test("stops the session of a failed attempt before creating the next one", async () => {
		const client = new FakeBrowserUseClient();
		const captured = captureWarnings();
		let attempts = 0;

		let driver: BrowserUseCdpDriver;
		try {
			driver = await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => {
					attempts += 1;
					return asConnection(
						new FakeCdpConnection(
							attempts === 1
								? new Error("Browser Use CDP connection closed")
								: undefined,
						),
					);
				},
			});
		} finally {
			captured.restore();
		}

		expect(driver).toBeInstanceOf(BrowserUseCdpDriver);
		expect(client.createCount).toBe(2);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
	});

	test("retries a session limit and reports it without a provider message", async () => {
		const client = new FakeBrowserUseClient({
			createFailures: [
				new BrowserUseApiError("create", 429),
				new BrowserUseApiError("create", 429),
			],
		});
		const captured = captureWarnings();

		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} finally {
			captured.restore();
		}

		expect(client.createCount).toBe(3);
		expect(client.stopped).toEqual([]);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_connect_retry",
			attempt: 1,
			delayMs: 10,
			reason: "SESSION_LIMIT",
			status: 429,
		});
	});

	test("does not retry a rejected session request", async () => {
		const client = new FakeBrowserUseClient({
			createFailures: [new BrowserUseApiError("create", 401)],
		});
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseApiError);
		expect((caught as BrowserUseApiError).status).toBe(401);
		expect(client.createCount).toBe(1);
		expect(client.stopped).toEqual([]);
		expect(captured.warnings).toEqual([]);
	});

	test("stops the session once when close is called twice", async () => {
		const client = new FakeBrowserUseClient();
		const captured = captureLogs();

		try {
			const driver = await BrowserUseCdpDriver.connect(
				"api-key",
				connectJob,
				true,
				{
					client: asClient(client),
					connectConnection: async () => asConnection(new FakeCdpConnection()),
				},
			);
			await Promise.all([driver.close(), driver.close()]);
			await driver.close();
		} finally {
			captured.restore();
		}

		expect(client.stopped).toHaveLength(1);
		expect(
			logEvents(captured.logs).filter(
				(entry) =>
					(entry as { event: string }).event === "browser_use_session_stopped",
			),
		).toHaveLength(1);
	});

	test("records a failed stop without failing the close", async () => {
		const client = new FakeBrowserUseClient({
			stopError: new BrowserUseApiError("stop", 500),
		});
		const captured = captureLogs();

		try {
			const driver = await BrowserUseCdpDriver.connect(
				"api-key",
				connectJob,
				true,
				{
					client: asClient(client),
					connectConnection: async () => asConnection(new FakeCdpConnection()),
				},
			);
			await driver.close();
		} finally {
			captured.restore();
		}

		expect(logEvents(captured.logs)[1]).toEqual({
			event: "browser_use_session_stopped",
			ok: false,
			status: 500,
			durationMs: expect.any(Number),
		});
	});

	test("stops a created session when the run is aborted before the connection opens", async () => {
		const controller = new AbortController();
		const client = new FakeBrowserUseClient({
			onCreate: () => controller.abort(),
		});
		let connectAttempts = 0;
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				signal: controller.signal,
				retryDelaysMs: [10],
				connectConnection: async () => {
					connectAttempts += 1;
					return asConnection(new FakeCdpConnection());
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect((caught as Error).message).toBe(
			"Browser Use CDP connection aborted",
		);
		expect(connectAttempts).toBe(0);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
	});

	test("retries a transport failure while resolving the debugger endpoint", async () => {
		const client = new FakeBrowserUseClient({
			cdpUrl: "https://cdp.browser-use.com/session",
		});
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				fetcher: async () => {
					throw new TypeError("Network connection lost");
				},
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseRequestError);
		expect(client.createCount).toBe(4);
		expect(client.stopped).toHaveLength(4);
		expect(JSON.parse(captured.warnings[0] ?? "{}")).toEqual({
			event: "browser_use_connect_retry",
			attempt: 1,
			delayMs: 10,
			reason: "SESSION_CREATE_FAILED",
		});
	});

	test("retries an invalid debugger response as a transient provider failure", async () => {
		const client = new FakeBrowserUseClient({
			cdpUrl: "https://cdp.browser-use.com/session",
		});
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10],
				sleep: async () => {},
				fetcher: async () => Response.json({}),
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseResponseError);
		expect(client.createCount).toBe(2);
	});

	test("reclaims the sessions left by an earlier attempt of the same job", async () => {
		const client = new FakeBrowserUseClient({
			activeSessions: [
				{ id: "stale-1", jobId: connectJob.id },
				{ id: "other-1", jobId: "another-job" },
				{ id: "untagged-1" },
			],
		});
		const captured = captureLogs();

		try {
			await BrowserUseCdpDriver.connect(
				"api-key",
				{ ...connectJob, attemptCount: 2 },
				true,
				{
					client: asClient(client),
					connectConnection: async () => asConnection(new FakeCdpConnection()),
				},
			);
		} finally {
			captured.restore();
		}

		expect(client.listedFilters).toEqual(["active"]);
		expect(client.stopped).toEqual([{ id: "stale-1", hasSignal: true }]);
		expect(client.createCount).toBe(1);
		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_use_session_stopped",
				ok: true,
				durationMs: expect.any(Number),
			},
			{ event: "browser_use_session_reclaimed", ok: true, stopped: 1 },
			{ event: "browser_use_session_created", cdpScheme: "wss", attempt: 0 },
		]);
	});

	test("does not reclaim sessions on the first attempt of a job", async () => {
		const client = new FakeBrowserUseClient({
			activeSessions: [{ id: "stale-1", jobId: connectJob.id }],
		});
		const captured = captureLogs();

		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} finally {
			captured.restore();
		}

		expect(client.listedFilters).toEqual([]);
		expect(client.stopped).toEqual([]);
	});

	test("closes the connection and stops the session when the run is aborted during setup", async () => {
		const controller = new AbortController();
		const client = new FakeBrowserUseClient();
		const connections: HangingCdpConnection[] = [];
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				signal: controller.signal,
				retryDelaysMs: [5_000],
				connectConnection: async () => {
					const connection = new HangingCdpConnection();
					connections.push(connection);
					setTimeout(() => controller.abort(), 10);
					return connection as unknown as BrowserUseCdpConnection;
				},
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect((caught as Error).message).toBe(
			"Browser Use CDP connection aborted",
		);
		expect(connections).toHaveLength(1);
		expect(connections[0]?.closeCount).toBeGreaterThanOrEqual(1);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
	});
});
