import { describe, expect, setSystemTime, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	hasNewSubmissionConfirmation,
	hasSubmissionConfirmationText,
} from "../src/browser-submit-confirmation";
import {
	assertCdpMessageWithinLimit,
	BrowserUseCdpClosedError,
	BrowserUseCdpCommandError,
	BrowserUseCdpConnection,
	BrowserUseCdpPayloadTooLargeError,
	BrowserUseCdpUpgradeRejectedError,
	type CdpCommandErrorKind,
	classifyCdpCloseReason,
	classifyCdpCommandError,
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
	BLOCK_BROWSER_ESCAPE_EXPRESSION,
	BrowserUseCdpDriver,
	type CdpScreenshotResult,
	CHECK_FORM_VALIDITY_FUNCTION,
	ConfirmationReadPendingError,
	captureCdpFullPageScreenshot,
	captureCdpScreenshot,
	centerOfQuad,
	chooseFullPageScreenshotQuality,
	collectCdpFrameParentIds,
	continueSubmissionRequest,
	createExpectedSubmissionRequest,
	createSubmitActivationFailureLog,
	denyRelatedBrowserTargets,
	desiredCheckboxState,
	ENTER_KEY_DOWN_EVENT,
	FULL_PAGE_SCREENSHOT_QUALITY,
	FULL_PAGE_SCREENSHOT_REDUCED_QUALITY,
	getSubmissionRequestDisposition,
	HAS_SAME_FORM_OWNER_FUNCTION,
	hasExpectedFrameNavigated,
	IS_COMPOSED_DESCENDANT_FUNCTION,
	IS_ELEMENT_FOCUSED_FUNCTION,
	IS_SUBMIT_UNOBSCURED_FUNCTION,
	isAuthorizedSubmissionRedirect,
	isExpectedNavigationDocumentRequest,
	isPayloadIndependentClickTarget,
	isRetryableClickPreparationError,
	isTransientConfirmationReadError,
	MATCHES_CHOICE_CANDIDATE_FUNCTION,
	MAX_SUBMISSION_REQUESTS,
	planFullPageScreenshot,
	READ_FORM_PROHIBITION_REASON_CODES_FUNCTION,
	readPageText,
	readRadioSelectionOutcome,
	readSubmissionConfirmation,
	retrySubmitMousePreparation,
	runSubmissionActivationWithinPermissionWindow,
	SELECT_OPTION_BY_CANDIDATE_FUNCTION,
	SELECT_RADIO_BY_CANDIDATE_FUNCTION,
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
	SESSION_STILL_ACTIVE_MESSAGE,
} from "../src/browser-use-client";
import type { Job } from "../src/job";
import {
	BrowserElementError,
	BrowserElementOperationError,
	BrowserSubmitDiagnosticError,
	type BrowserSubmitResult,
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

	test("detects a purpose restriction stated next to a limiting word", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];

		expect(
			readContext.call({
				tagName: "FORM",
				innerText: "こちらは採用に関するお問い合わせ専用フォームです",
				previousElementSibling: null,
				parentElement: { tagName: "BODY" },
			}),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
	});

	test("detects a purpose restriction stated only in a heading", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const legend = { innerText: "ご予約フォーム" };

		expect(
			readContext.call({
				tagName: "FORM",
				innerText: "お名前 メールアドレス ご希望日",
				previousElementSibling: null,
				parentElement: { tagName: "BODY" },
				querySelectorAll: () => ({ length: 1, 0: legend }),
			}),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
	});

	test("leaves a general inquiry form and its headings undetected", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const heading = { innerText: "お問い合わせフォーム" };

		expect(
			readContext.call({
				tagName: "FORM",
				innerText:
					"お問い合わせ内容をご記入ください。ご予約はお電話のみで承ります。必須項目のみご入力ください。",
				previousElementSibling: null,
				parentElement: { tagName: "BODY" },
				ownerDocument: { title: "お問い合わせ｜株式会社サンプル採用情報" },
				querySelectorAll: () => ({ length: 1, 0: heading }),
			}),
		).toEqual([]);
	});

	test("requires the limiter to attach to the purpose word", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const form = (innerText: string) => ({
			tagName: "FORM",
			innerText,
			previousElementSibling: null,
			parentElement: { tagName: "BODY" },
		});

		expect(readContext.call(form("採用専用フォーム"))).toEqual([
			"FORM_PURPOSE_INCOMPATIBLE",
		]);
		expect(
			readContext.call(form("採用に関するお問い合わせのみ受け付けます")),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
		// The purpose word and the limiter belong to different sentences here.
		expect(
			readContext.call(
				form("採用以外のお問い合わせはこちら。必須項目のみご入力ください。"),
			),
		).toEqual([]);
	});

	test("detects an exclusion only when a refusal follows it", () => {
		const readContext = runInNewContext(
			`(${READ_FORM_PROHIBITION_REASON_CODES_FUNCTION})`,
		) as (this: object) => string[];
		const form = (innerText: string) => ({
			tagName: "FORM",
			innerText,
			previousElementSibling: null,
			parentElement: { tagName: "BODY" },
		});

		expect(
			readContext.call(
				form("採用に関するお問い合わせ以外は受け付けておりません"),
			),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
		expect(
			readContext.call(form("採用以外のお問い合わせは受け付けておりません")),
		).toEqual(["FORM_PURPOSE_INCOMPATIBLE"]);
		// The same words introduce a general inquiry form when nothing is refused.
		expect(readContext.call(form("採用以外のお問い合わせはこちら"))).toEqual(
			[],
		);
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
		const claimed = new Set(["submit-0", "submit-1"]);
		expect(isAuthorizedSubmissionRedirect(paused, claimed, "form-frame")).toBe(
			true,
		);
		expect(
			isAuthorizedSubmissionRedirect(paused, new Set(["other"]), "form-frame"),
		).toBe(false);
		expect(
			isAuthorizedSubmissionRedirect(paused, new Set(), "form-frame"),
		).toBe(false);
		expect(
			isAuthorizedSubmissionRedirect(
				{ ...paused, frameId: "other-frame" },
				claimed,
				"form-frame",
			),
		).toBe(false);
		expect(
			isAuthorizedSubmissionRedirect(
				{ ...paused, request: { ...paused.request, method: "POST" } },
				claimed,
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
		const { calls, connection, emit } = relatedTargetHarness();
		const failures: Error[] = [];

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
			emit(
				"Target.attachedToTarget",
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

	test("keeps a verification widget iframe target and polices its requests", async () => {
		const harness = relatedTargetHarness();
		const failures: Error[] = [];
		let frameCount = 0;
		let requestCount = 0;

		await denyRelatedBrowserTargets(
			harness.connection,
			"primary",
			(error) => failures.push(error),
			{
				onVerificationFrame: () => {
					frameCount += 1;
				},
				onVerificationRequest: () => {
					requestCount += 1;
				},
			},
		);
		harness.emit(
			"Target.attachedToTarget",
			{
				sessionId: "widget-session",
				targetInfo: {
					targetId: "widget-1",
					type: "iframe",
					url: "https://www.google.com/recaptcha/api2/anchor?k=key",
				},
				waitingForDebugger: true,
			},
			"primary",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(harness.calls.slice(1)).toEqual([
			{
				method: "Fetch.enable",
				params: { patterns: [{ urlPattern: "*" }] },
				sessionId: "widget-session",
			},
			{
				method: "Target.setAutoAttach",
				params: {
					autoAttach: true,
					waitForDebuggerOnStart: true,
					flatten: true,
				},
				sessionId: "widget-session",
			},
			{ method: "Page.enable", params: {}, sessionId: "widget-session" },
			{
				method: "Page.addScriptToEvaluateOnNewDocument",
				params: { source: BLOCK_BROWSER_ESCAPE_EXPRESSION },
				sessionId: "widget-session",
			},
			{
				method: "Runtime.runIfWaitingForDebugger",
				params: {},
				sessionId: "widget-session",
			},
		]);
		expect(frameCount).toBe(1);

		for (const [requestId, url, resourceType] of [
			["allow-1", "https://www.gstatic.com/recaptcha/x.js", "Script"],
			["allow-2", "https://www.google.com/recaptcha/api2/bframe", "Document"],
			["deny-1", "https://evil.example/", "Document"],
			["deny-2", "https://www.google.com/search", "XHR"],
		] as const) {
			harness.emit(
				"Fetch.requestPaused",
				{ requestId, resourceType, request: { url, method: "GET" } },
				"widget-session",
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			harness.calls.filter((call) => call.method.startsWith("Fetch.c")),
		).toEqual([
			{
				method: "Fetch.continueRequest",
				params: { requestId: "allow-1" },
				sessionId: "widget-session",
			},
			{
				method: "Fetch.continueRequest",
				params: { requestId: "allow-2" },
				sessionId: "widget-session",
			},
		]);
		expect(
			harness.calls.filter((call) => call.method === "Fetch.failRequest"),
		).toEqual([
			{
				method: "Fetch.failRequest",
				params: { requestId: "deny-1", errorReason: "BlockedByClient" },
				sessionId: "widget-session",
			},
			{
				method: "Fetch.failRequest",
				params: { requestId: "deny-2", errorReason: "BlockedByClient" },
				sessionId: "widget-session",
			},
		]);
		expect(requestCount).toBe(2);
		expect(
			harness.calls.some(
				(call) =>
					call.method === "Target.closeTarget" ||
					call.method === "Target.detachFromTarget" ||
					call.method === "Page.navigate",
			),
		).toBe(false);
		expect(failures).toEqual([]);
	});

	test("stops an iframe target outside the verification allowlist", async () => {
		const harness = relatedTargetHarness();
		const failures: Error[] = [];
		let frameCount = 0;

		await denyRelatedBrowserTargets(
			harness.connection,
			"primary",
			(error) => failures.push(error),
			{
				onVerificationFrame: () => {
					frameCount += 1;
				},
			},
		);
		const captured = captureLogs();
		try {
			for (const [targetId, url] of [
				["frame-1", "https://evil.example/recaptcha/api2/anchor"],
				[
					"frame-2",
					"https://www.google.com.evil.example/recaptcha/api2/anchor",
				],
				["frame-3", "https://www.google.com/search"],
			] as const) {
				harness.emit(
					"Target.attachedToTarget",
					{
						sessionId: `${targetId}-session`,
						targetInfo: { targetId, type: "iframe", url },
						waitingForDebugger: true,
					},
					"primary",
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			captured.restore();
		}

		expect(logEvents(captured.logs)).toEqual(
			Array.from({ length: 3 }, () => ({
				event: "browser_verification_frame_stopped",
				reason: "NOT_ALLOWLISTED",
			})),
		);

		// Every frame is emptied and released before its session is dropped, and
		// none of them is closed.
		for (const targetId of ["frame-1", "frame-2", "frame-3"]) {
			expect(frameCommands(harness.calls, `${targetId}-session`)).toEqual([
				"Page.navigate",
				"Runtime.runIfWaitingForDebugger",
				"Target.detachFromTarget",
			]);
		}
		expect(
			harness.calls.some((call) => call.method === "Target.closeTarget"),
		).toBe(false);
		expect(
			harness.calls.find((call) => call.method === "Page.navigate")?.params,
		).toEqual({ url: "about:blank" });
		expect(frameCount).toBe(0);
		expect(failures).toEqual([]);
	});

	test("keeps an unpaused allowlisted iframe under the restrictions", async () => {
		const harness = relatedTargetHarness();
		const failures: Error[] = [];
		let frameCount = 0;

		await denyRelatedBrowserTargets(
			harness.connection,
			"primary",
			(error) => failures.push(error),
			{
				onVerificationFrame: () => {
					frameCount += 1;
				},
			},
		);
		harness.emit(
			"Target.attachedToTarget",
			{
				sessionId: "widget-session",
				targetInfo: {
					targetId: "widget-1",
					type: "iframe",
					url: "https://www.google.com/recaptcha/api2/anchor?k=key",
				},
				waitingForDebugger: false,
			},
			"primary",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The frame is already running, so it is put under the restrictions rather
		// than released, and it is neither counted nor closed.
		expect(frameCommands(harness.calls, "widget-session")).toEqual([
			"Fetch.enable",
			"Target.setAutoAttach",
			"Page.enable",
			"Page.addScriptToEvaluateOnNewDocument",
		]);
		expect(frameCount).toBe(0);
		expect(failures.map((error) => error.message)).toEqual([
			"A related browser target was not paused",
		]);
	});

	test("stops an unpaused iframe target the restrictions do not cover", async () => {
		const harness = relatedTargetHarness(
			failFrameCommand("Target.setAutoAttach", "METHOD_NOT_FOUND"),
		);
		const failures: Error[] = [];

		await denyRelatedBrowserTargets(harness.connection, "primary", (error) =>
			failures.push(error),
		);
		const captured = captureLogs();
		try {
			harness.emit(
				"Target.attachedToTarget",
				{
					sessionId: "widget-session",
					targetInfo: {
						targetId: "widget-1",
						type: "iframe",
						url: "https://www.google.com/recaptcha/api2/anchor?k=key",
					},
					waitingForDebugger: false,
				},
				"primary",
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			captured.restore();
		}

		// Nothing is released: the frame was never paused, so the stop is the
		// empty navigation and the detach.
		expect(frameCommands(harness.calls, "widget-session")).toEqual([
			"Fetch.enable",
			"Target.setAutoAttach",
			"Page.navigate",
			"Target.detachFromTarget",
		]);
		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_verification_frame_restrict_failed",
				method: "Target.setAutoAttach",
				kind: "METHOD_NOT_FOUND",
			},
			{ event: "browser_verification_frame_stopped", reason: "NOT_PAUSED" },
		]);
		expect(failures.map((error) => error.message)).toEqual([
			"A related browser target was not paused",
		]);
	});

	test("stops the widget iframe when a required restriction cannot be installed", async () => {
		for (const [method, kind] of [
			["Fetch.enable", "NOT_ALLOWED"],
			["Target.setAutoAttach", "METHOD_NOT_FOUND"],
			["Page.addScriptToEvaluateOnNewDocument", "METHOD_NOT_FOUND"],
		] as const) {
			const harness = relatedTargetHarness(failFrameCommand(method, kind));
			const failures: Error[] = [];
			let frameCount = 0;
			let requestCount = 0;

			await denyRelatedBrowserTargets(
				harness.connection,
				"primary",
				(error) => failures.push(error),
				{
					onVerificationFrame: () => {
						frameCount += 1;
					},
					onVerificationRequest: () => {
						requestCount += 1;
					},
				},
			);
			const captured = captureLogs();
			try {
				harness.emit(
					"Target.attachedToTarget",
					{
						sessionId: "widget-session",
						targetInfo: {
							targetId: "widget-1",
							type: "iframe",
							url: "https://www.google.com/recaptcha/api2/anchor?k=key",
						},
						waitingForDebugger: true,
					},
					"primary",
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			} finally {
				captured.restore();
			}

			// The empty navigation comes before the release, so the widget document
			// is replaced rather than let go, and the detach is last.
			const commands = frameCommands(harness.calls, "widget-session");
			expect(commands.slice(-3)).toEqual([
				"Page.navigate",
				"Runtime.runIfWaitingForDebugger",
				"Target.detachFromTarget",
			]);
			expect(commands).toContain(method);
			expect(commands).not.toContain("Target.closeTarget");
			expect(logEvents(captured.logs)).toEqual([
				{
					event: "browser_verification_frame_restrict_failed",
					method,
					kind,
				},
				{
					event: "browser_verification_frame_stopped",
					reason: "RESTRICTION_FAILED",
				},
			]);

			// A request the stopped frame still makes is failed even though its URL
			// is on the allowlist.
			harness.emit(
				"Fetch.requestPaused",
				{
					requestId: "late-1",
					resourceType: "Script",
					request: {
						url: "https://www.gstatic.com/recaptcha/x.js",
						method: "GET",
					},
				},
				"widget-session",
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(
				harness.calls.filter((call) => call.method === "Fetch.continueRequest"),
			).toEqual([]);
			expect(
				harness.calls.filter((call) => call.method === "Fetch.failRequest"),
			).toEqual([
				{
					method: "Fetch.failRequest",
					params: { requestId: "late-1", errorReason: "BlockedByClient" },
					sessionId: "widget-session",
				},
			]);
			expect(requestCount).toBe(0);
			expect(frameCount).toBe(0);
			expect(failures).toEqual([]);
		}
	});

	test("keeps the widget iframe when only Page.enable fails", async () => {
		const harness = relatedTargetHarness(
			failFrameCommand("Page.enable", "METHOD_NOT_FOUND"),
		);
		const failures: Error[] = [];
		let frameCount = 0;

		await denyRelatedBrowserTargets(
			harness.connection,
			"primary",
			(error) => failures.push(error),
			{
				onVerificationFrame: () => {
					frameCount += 1;
				},
			},
		);
		const captured = captureLogs();
		try {
			harness.emit(
				"Target.attachedToTarget",
				{
					sessionId: "widget-session",
					targetInfo: {
						targetId: "widget-1",
						type: "iframe",
						url: "https://challenges.cloudflare.com/turnstile/v0/widget",
					},
					waitingForDebugger: true,
				},
				"primary",
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			captured.restore();
		}

		expect(frameCommands(harness.calls, "widget-session")).toEqual([
			"Fetch.enable",
			"Target.setAutoAttach",
			"Page.enable",
			"Page.addScriptToEvaluateOnNewDocument",
			"Runtime.runIfWaitingForDebugger",
		]);
		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_verification_frame_restrict_failed",
				method: "Page.enable",
				kind: "METHOD_NOT_FOUND",
			},
		]);
		expect(frameCount).toBe(1);
		expect(failures).toEqual([]);
	});

	test("keeps a refused emptying navigation from releasing the frame", async () => {
		const harness = relatedTargetHarness(
			failFrameCommand("Fetch.enable", "NOT_ALLOWED"),
			(method) =>
				method === "Page.navigate"
					? { errorText: "net::ERR_ABORTED" }
					: undefined,
		);
		const failures: Error[] = [];

		await denyRelatedBrowserTargets(harness.connection, "primary", (error) =>
			failures.push(error),
		);
		const captured = captureLogs();
		try {
			harness.emit(
				"Target.attachedToTarget",
				{
					sessionId: "widget-session",
					targetInfo: {
						targetId: "widget-1",
						type: "iframe",
						url: "https://www.google.com/recaptcha/api2/anchor?k=key",
					},
					waitingForDebugger: true,
				},
				"primary",
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			captured.restore();
		}

		// `Page.navigate` reports the refusal in `errorText` rather than by
		// rejecting, so the frame stays paused and is only detached.
		expect(frameCommands(harness.calls, "widget-session")).toEqual([
			"Fetch.enable",
			"Page.navigate",
			"Target.detachFromTarget",
		]);
		expect(
			harness.calls.some(
				(call) => call.method === "Runtime.runIfWaitingForDebugger",
			),
		).toBe(false);
		expect(failures).toEqual([]);
	});

	test("stops an unpaused iframe target outside the verification allowlist", async () => {
		const harness = relatedTargetHarness();
		const failures: Error[] = [];
		let frameCount = 0;
		let requestCount = 0;

		await denyRelatedBrowserTargets(
			harness.connection,
			"primary",
			(error) => failures.push(error),
			{
				onVerificationFrame: () => {
					frameCount += 1;
				},
				onVerificationRequest: () => {
					requestCount += 1;
				},
			},
		);
		const captured = captureLogs();
		try {
			harness.emit(
				"Target.attachedToTarget",
				{
					sessionId: "widget-session",
					targetInfo: {
						targetId: "widget-1",
						type: "iframe",
						url: "https://evil.example/recaptcha/api2/anchor",
					},
					waitingForDebugger: false,
				},
				"primary",
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			captured.restore();
		}

		// The allowlist decides on its own: a frame that started early gets no
		// restrictions installed, only the stop.
		expect(frameCommands(harness.calls, "widget-session")).toEqual([
			"Page.navigate",
			"Target.detachFromTarget",
		]);
		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_verification_frame_stopped",
				reason: "NOT_ALLOWLISTED",
			},
		]);
		expect(failures.map((error) => error.message)).toEqual([
			"A related browser target was not paused",
		]);

		// Its requests are failed even though the frame was never registered as a
		// verification session.
		harness.emit(
			"Fetch.requestPaused",
			{
				requestId: "late-1",
				resourceType: "Script",
				request: {
					url: "https://www.gstatic.com/recaptcha/x.js",
					method: "GET",
				},
			},
			"widget-session",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			harness.calls.filter((call) => call.method === "Fetch.continueRequest"),
		).toEqual([]);
		expect(
			harness.calls.filter((call) => call.method === "Fetch.failRequest"),
		).toEqual([
			{
				method: "Fetch.failRequest",
				params: { requestId: "late-1", errorReason: "BlockedByClient" },
				sessionId: "widget-session",
			},
		]);
		expect(requestCount).toBe(0);
		expect(frameCount).toBe(0);
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
		const { connection, emit } = relatedTargetHarness();
		const failures: Error[] = [];

		await denyRelatedBrowserTargets(connection, "primary", (error) =>
			failures.push(error),
		);
		emit(
			"Target.attachedToTarget",
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

	test("retries a confirmation read the navigating page could not answer", async () => {
		let elapsed = 0;
		let reads = 0;
		const captured = captureLogs();
		let result: BrowserSubmitResult | null;
		try {
			result = await waitForSubmissionConfirmation(
				async () => {
					reads += 1;
					if (reads <= 2) {
						throw new ConfirmationReadPendingError(
							cdpCommandError("Runtime.callFunctionOn", "NODE_DETACHED"),
						);
					}
					return {
						outcome: "sent" as const,
						formUrl: "https://example.com/complete",
					};
				},
				async (milliseconds) => {
					elapsed += milliseconds;
				},
				15_000,
				() => elapsed,
			);
		} finally {
			captured.restore();
		}

		expect(result).toEqual({
			outcome: "sent",
			formUrl: "https://example.com/complete",
		});
		expect(reads).toBe(3);
		expect(elapsed).toBe(3_000);
		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_confirmation_read_retry",
				method: "Runtime.callFunctionOn",
				kind: "NODE_DETACHED",
			},
			{
				event: "browser_confirmation_read_retry",
				method: "Runtime.callFunctionOn",
				kind: "NODE_DETACHED",
			},
		]);
	});

	test("reports the after-text failure only once the deadline passed", async () => {
		let elapsed = 0;
		let reads = 0;
		const captured = captureLogs();
		try {
			const confirmation = waitForSubmissionConfirmation(
				async () => {
					reads += 1;
					throw new ConfirmationReadPendingError(
						cdpCommandError("DOM.getDocument", "CONTEXT_DESTROYED"),
					);
				},
				async (milliseconds) => {
					elapsed += milliseconds;
				},
				3_500,
				() => elapsed,
			);

			const error = await confirmation.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(BrowserSubmitDiagnosticError);
			expect(error).toMatchObject({
				stage: "SUBMIT_READ_AFTER_TEXT",
				diagnosticCode: "CDP_COMMAND_FAILED",
			});
		} finally {
			captured.restore();
		}

		expect(elapsed).toBe(3_500);
		// Four polls inside the window plus the final read after the deadline.
		expect(reads).toBe(5);
	});

	test("ends the submission on a confirmation read failure that is not transient", async () => {
		let elapsed = 0;
		let reads = 0;
		const failure = new BrowserSubmitDiagnosticError(
			"SUBMIT_READ_AFTER_TEXT",
			"CDP_COMMAND_FAILED",
		);

		const confirmation = waitForSubmissionConfirmation(
			async () => {
				reads += 1;
				throw failure;
			},
			async (milliseconds) => {
				elapsed += milliseconds;
			},
			15_000,
			() => elapsed,
		);

		expect(await confirmation.catch((reason: unknown) => reason)).toBe(failure);
		expect(reads).toBe(1);
		expect(elapsed).toBe(1_000);
	});

	test("asks for another poll when the after-text read hit a detached node", async () => {
		const confirmation = readSubmissionConfirmation(
			0,
			true,
			async () => {
				throw cdpCommandError("Runtime.callFunctionOn", "NODE_DETACHED");
			},
			async () => "https://example.com/complete",
		);

		const error = await confirmation.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ConfirmationReadPendingError);
		expect(error).toMatchObject({
			cdpMethod: "Runtime.callFunctionOn",
			cdpKind: "NODE_DETACHED",
		});
	});

	test("keeps a non-transient after-text failure a submission diagnostic", async () => {
		const confirmation = readSubmissionConfirmation(
			0,
			true,
			async () => {
				throw cdpCommandError(
					"Runtime.callFunctionOn",
					"INVALID_PARAMS",
					-32602,
				);
			},
			async () => "https://example.com/complete",
		);

		const error = await confirmation.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(BrowserSubmitDiagnosticError);
		expect(error).toMatchObject({ stage: "SUBMIT_READ_AFTER_TEXT" });
	});

	test("treats only a mid-navigation CDP failure as a pending read", () => {
		expect(
			isTransientConfirmationReadError(
				cdpCommandError("DOM.getDocument", "CONTEXT_DESTROYED"),
			),
		).toBe(true);
		expect(
			isTransientConfirmationReadError(
				cdpCommandError("DOM.getDocument", "OTHER"),
			),
		).toBe(false);
		expect(isTransientConfirmationReadError(new Error("boom"))).toBe(false);
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

describe("full-page screenshot plan", () => {
	test("scales a tall page down and cuts it at the height cap", () => {
		const plan = planFullPageScreenshot(1920, 9000);

		// 1280 / 1920 allows 0.667, but the height term is floored at 0.5 so the
		// image stays readable; what does not fit at that scale is cut.
		expect(plan).toEqual({
			quality: FULL_PAGE_SCREENSHOT_QUALITY,
			clip: { x: 0, y: 0, width: 1920, height: 8000, scale: 0.5 },
		});
		const clip = plan?.clip;
		expect((clip?.width ?? 0) * (clip?.scale ?? 0)).toBe(960);
		expect((clip?.height ?? 0) * (clip?.scale ?? 0)).toBe(4000);
	});

	test("keeps a page that already fits at full scale", () => {
		expect(planFullPageScreenshot(1280, 2000)).toEqual({
			quality: FULL_PAGE_SCREENSHOT_QUALITY,
			clip: { x: 0, y: 0, width: 1280, height: 2000, scale: 1 },
		});
	});

	test("lets the width cap override the scale floor on a wide page", () => {
		const plan = planFullPageScreenshot(4000, 9000);

		// The width cap is absolute, so the scale drops below the floor and the
		// whole page fits without a cut.
		expect(plan).toEqual({
			quality: FULL_PAGE_SCREENSHOT_QUALITY,
			clip: { x: 0, y: 0, width: 4000, height: 9000, scale: 0.32 },
		});
	});

	test("rejects layout metrics that are not a usable size", () => {
		for (const size of [undefined, null, 0, -100, Number.NaN, "1920"]) {
			expect(planFullPageScreenshot(size, 2000)).toBeNull();
			expect(planFullPageScreenshot(1280, size)).toBeNull();
		}
	});

	test("drops the quality once the planned image exceeds the pixel budget", () => {
		expect(chooseFullPageScreenshotQuality(6_000_000)).toBe(
			FULL_PAGE_SCREENSHOT_QUALITY,
		);
		expect(chooseFullPageScreenshotQuality(6_000_001)).toBe(
			FULL_PAGE_SCREENSHOT_REDUCED_QUALITY,
		);
	});
});

describe("captureCdpFullPageScreenshot", () => {
	test("captures the whole document in a single clipped call", async () => {
		const requests: Array<Record<string, unknown>> = [];

		const bytes = await captureCdpFullPageScreenshot(
			async () => ({ cssContentSize: { width: 1920, height: 9000 } }),
			async (params) => {
				requests.push(params);
				return { data: btoa(String.fromCharCode(7, 8, 9)) };
			},
		);

		expect(requests).toEqual([
			{
				format: "jpeg",
				quality: 60,
				captureBeyondViewport: true,
				fromSurface: true,
				clip: { x: 0, y: 0, width: 1920, height: 8000, scale: 0.5 },
			},
		]);
		expect([...bytes]).toEqual([7, 8, 9]);
	});

	test("reports an opaque error when the layout metrics are unusable", async () => {
		let captures = 0;

		await expect(
			captureCdpFullPageScreenshot(
				async () => ({}),
				async (): Promise<CdpScreenshotResult> => {
					captures += 1;
					return {};
				},
			),
		).rejects.toThrow("Browser screenshot failed");
		expect(captures).toBe(0);
	});

	test("reports an opaque error when the metrics command fails", async () => {
		await expect(
			captureCdpFullPageScreenshot(
				async () => {
					throw new BrowserUseCdpPayloadTooLargeError();
				},
				async () => ({ data: btoa("x") }),
			),
		).rejects.toThrow("Browser screenshot failed");
	});
});

describe("BrowserUseCdpDriver screenshot modes", () => {
	test("asks for a clipped full-page capture in full_page mode", async () => {
		const connection = new ScriptedCdpConnection();
		connection.respond = (method, params) => {
			if (method === "Page.getLayoutMetrics") {
				return { cssContentSize: { width: 1920, height: 9000 } };
			}
			if (method === "Page.captureScreenshot") {
				return { data: btoa(String.fromCharCode(3, 4)) };
			}
			return scriptedCdpResponse(method, params);
		};
		const driver = await scriptedDriver(connection);

		const bytes = await driver.captureScreenshot("full_page");

		expect([...bytes]).toEqual([3, 4]);
		const screenshots = connection.sent.filter(
			(entry) => entry.method === "Page.captureScreenshot",
		);
		expect(screenshots).toHaveLength(1);
		expect(screenshots[0]?.params).toEqual({
			format: "jpeg",
			quality: 60,
			captureBeyondViewport: true,
			fromSurface: true,
			clip: { x: 0, y: 0, width: 1920, height: 8000, scale: 0.5 },
		});
	});

	test("leaves the viewport mode on the unclipped parameters", async () => {
		const connection = new ScriptedCdpConnection();
		connection.respond = (method, params) =>
			method === "Page.captureScreenshot"
				? { data: btoa(String.fromCharCode(5)) }
				: scriptedCdpResponse(method, params);
		const driver = await scriptedDriver(connection);

		const bytes = await driver.captureScreenshot("viewport");

		expect([...bytes]).toEqual([5]);
		expect(
			connection.sent.filter(
				(entry) => entry.method === "Page.getLayoutMetrics",
			),
		).toHaveLength(0);
		expect(
			connection.sent
				.filter((entry) => entry.method === "Page.captureScreenshot")
				.map((entry) => entry.params),
		).toEqual([
			{
				format: "jpeg",
				quality: 80,
				captureBeyondViewport: false,
				fromSurface: true,
			},
		]);
	});

	test("falls back to the viewport capture while the connection is open", async () => {
		const connection = new ScriptedCdpConnection();
		connection.fail = (method) =>
			method === "Page.getLayoutMetrics"
				? new BrowserUseCdpCommandError(
						"Page.getLayoutMetrics",
						null,
						"unknown",
					)
				: null;
		connection.respond = (method, params) =>
			method === "Page.captureScreenshot"
				? { data: btoa(String.fromCharCode(6)) }
				: scriptedCdpResponse(method, params);
		const driver = await scriptedDriver(connection);

		const captured = captureLogs();
		let bytes: Uint8Array;
		try {
			bytes = await driver.captureScreenshot("full_page");
		} finally {
			captured.restore();
		}

		expect([...bytes]).toEqual([6]);
		expect(captured.logs).toContain(
			JSON.stringify({ event: "browser_full_page_screenshot_fallback" }),
		);
		expect(
			connection.sent
				.filter((entry) => entry.method === "Page.captureScreenshot")
				.map((entry) => entry.params),
		).toEqual([
			{
				format: "jpeg",
				quality: 80,
				captureBeyondViewport: false,
				fromSurface: true,
			},
		]);
	});

	test("does not retry once the oversized payload closed the connection", async () => {
		const connection = new ScriptedCdpConnection();
		connection.fail = (method) => {
			if (method !== "Page.captureScreenshot") return null;
			connection.closed = true;
			return new BrowserUseCdpPayloadTooLargeError();
		};
		connection.respond = (method, params) =>
			method === "Page.getLayoutMetrics"
				? { cssContentSize: { width: 1280, height: 2000 } }
				: scriptedCdpResponse(method, params);
		const driver = await scriptedDriver(connection);

		await expect(driver.captureScreenshot("full_page")).rejects.toThrow(
			"Browser screenshot failed",
		);
		expect(
			connection.sent.filter(
				(entry) => entry.method === "Page.captureScreenshot",
			),
		).toHaveLength(1);
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
	stopErrorsById?: Readonly<Record<string, unknown>>;
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
	readonly calls: string[] = [];

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
		this.calls.push("create");
		this.createdMetadata.push(options.metadata ?? {});
		this.createdTimeouts.push(options.timeoutMinutes ?? 0);
		this.options.onCreate?.();
		const failure = this.options.createFailures?.[index];
		if (failure) throw failure;
		return this.#session(`session-${index + 1}`, options.metadata ?? {});
	}

	async stopBrowser(sessionId: string, signal?: AbortSignal): Promise<unknown> {
		this.stopped.push({ id: sessionId, hasSignal: Boolean(signal) });
		this.calls.push(`stop:${sessionId}`);
		const failure =
			this.options.stopErrorsById?.[sessionId] ?? this.options.stopError;
		if (failure) throw failure;
		return this.#session(sessionId, {});
	}

	async listBrowsers(status?: "active" | "stopped"): Promise<unknown[]> {
		this.listedFilters.push(status);
		this.calls.push("list");
		if (this.options.listError) throw this.options.listError;
		return (this.options.activeSessions ?? []).map((session) =>
			this.#session(
				session.id,
				session.jobId === undefined
					? {}
					: { source: "form-agent", jobId: session.jobId },
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

/**
 * The commands one frame session received, in order. A detach is addressed to
 * the browser session and names the frame in its params, so it is counted for
 * the frame it detaches rather than for the session it was sent on.
 */
function frameCommands(
	calls: ReadonlyArray<{
		method: string;
		params: Record<string, unknown>;
		sessionId?: string;
	}>,
	sessionId: string,
): string[] {
	return calls
		.filter(
			(call) =>
				call.sessionId === sessionId ||
				(call.sessionId === undefined && call.params.sessionId === sessionId),
		)
		.map((call) => call.method);
}

/**
 * Fails one method on one session with a CDP command error, the way an iframe
 * session rejects a command it does not implement. Scoped to a session because
 * the policy sends `Target.setAutoAttach` to the page's session as well.
 */
function failFrameCommand(
	method: string,
	kind: CdpCommandErrorKind,
	sessionId = "widget-session",
): (sentMethod: string, sentSessionId?: string) => Error | null {
	return (sentMethod, sentSessionId) =>
		sentMethod === method && sentSessionId === sessionId
			? new BrowserUseCdpCommandError(method, -32000, kind)
			: null;
}

/**
 * A connection stub for the related-target policy that records the session each
 * command was sent on and keeps every listener the policy registers. `fail`
 * answers with an error for the commands that should not land, and `respond`
 * replaces the result of a command that answers without rejecting.
 */
function relatedTargetHarness(
	fail: (method: string, sessionId?: string) => Error | null = () => null,
	respond: (method: string, sessionId?: string) => unknown = () => undefined,
): {
	calls: Array<{
		method: string;
		params: Record<string, unknown>;
		sessionId?: string;
	}>;
	connection: {
		on(
			method: string,
			listener: (params: unknown, sessionId: string | undefined) => void,
		): () => void;
		send<TResult>(
			method: string,
			params?: Record<string, unknown>,
			sessionId?: string,
		): Promise<TResult>;
	};
	emit(method: string, params: unknown, sessionId?: string): void;
} {
	const calls: Array<{
		method: string;
		params: Record<string, unknown>;
		sessionId?: string;
	}> = [];
	const listeners = new Map<
		string,
		Set<(params: unknown, sessionId: string | undefined) => void>
	>();
	return {
		calls,
		connection: {
			on(
				method: string,
				listener: (params: unknown, sessionId: string | undefined) => void,
			) {
				const handlers = listeners.get(method) ?? new Set();
				handlers.add(listener);
				listeners.set(method, handlers);
				return () => {
					handlers.delete(listener);
				};
			},
			async send<TResult>(
				method: string,
				params: Record<string, unknown> = {},
				sessionId?: string,
			): Promise<TResult> {
				calls.push({ method, params, sessionId });
				const failure = fail(method, sessionId);
				if (failure) throw failure;
				return (respond(method, sessionId) ?? { success: true }) as TResult;
			},
		},
		emit(method: string, params: unknown, sessionId?: string): void {
			for (const handler of listeners.get(method) ?? []) {
				handler(params, sessionId);
			}
		},
	};
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

describe("CDP command error classification", () => {
	test("maps the fixed provider messages onto a kind", () => {
		expect(classifyCdpCommandError("Could not find node with given id")).toBe(
			"NODE_NOT_FOUND",
		);
		expect(classifyCdpCommandError("No node with given id found")).toBe(
			"NODE_NOT_FOUND",
		);
		expect(
			classifyCdpCommandError(
				"Node with given id does not belong to the document",
			),
		).toBe("NODE_NOT_FOUND");
		expect(classifyCdpCommandError("Node is not attached to the DOM")).toBe(
			"NODE_DETACHED",
		);
		expect(classifyCdpCommandError("Node is detached from document")).toBe(
			"NODE_DETACHED",
		);
		expect(classifyCdpCommandError("Could not compute box model.")).toBe(
			"NO_BOX_MODEL",
		);
		expect(classifyCdpCommandError("Node does not have a layout object")).toBe(
			"NO_BOX_MODEL",
		);
		expect(classifyCdpCommandError("Element is not focusable")).toBe(
			"NOT_FOCUSABLE",
		);
		expect(
			classifyCdpCommandError("Cannot find context with specified id"),
		).toBe("CONTEXT_NOT_FOUND");
		expect(classifyCdpCommandError("No node found at given location")).toBe(
			"NO_NODE_AT_LOCATION",
		);
		expect(classifyCdpCommandError("Execution context was destroyed.")).toBe(
			"CONTEXT_DESTROYED",
		);
		expect(classifyCdpCommandError("Some other execution context error")).toBe(
			"NO_EXECUTION_CONTEXT",
		);
		expect(classifyCdpCommandError("No frame for given id found")).toBe(
			"FRAME_NOT_FOUND",
		);
		expect(
			classifyCdpCommandError("Frame with the given id was not found"),
		).toBe("FRAME_NOT_FOUND");
		expect(classifyCdpCommandError("Frame not found")).toBe("FRAME_NOT_FOUND");
		expect(
			classifyCdpCommandError("Inspected target navigated or closed"),
		).toBe("TARGET_NAVIGATED");
		expect(classifyCdpCommandError("Not allowed")).toBe("NOT_ALLOWED");
		expect(classifyCdpCommandError("Operation not allowed")).toBe(
			"NOT_ALLOWED",
		);
		expect(classifyCdpCommandError("Internal error")).toBe("INTERNAL_ERROR");
	});

	test("classifies fixed CDP error codes ahead of the message", () => {
		expect(classifyCdpCommandError("Invalid parameters", -32602)).toBe(
			"INVALID_PARAMS",
		);
		expect(classifyCdpCommandError(undefined, -32602)).toBe("INVALID_PARAMS");
		expect(classifyCdpCommandError("Method not found", -32601)).toBe(
			"METHOD_NOT_FOUND",
		);
		// An unmapped code falls back to classifying the message.
		expect(classifyCdpCommandError("Not allowed", -32000)).toBe("NOT_ALLOWED");
	});

	test("falls back to OTHER for an unknown or absent message", () => {
		expect(classifyCdpCommandError("some unmapped failure")).toBe("OTHER");
		expect(classifyCdpCommandError("   ")).toBe("OTHER");
		expect(classifyCdpCommandError(undefined)).toBe("OTHER");
		expect(classifyCdpCommandError({ message: "Could not find node" })).toBe(
			"OTHER",
		);
	});

	test("retries only the click preparation kinds that a settling layout reports", () => {
		const retryable = [
			"NO_BOX_MODEL",
			"NODE_NOT_FOUND",
			"NODE_DETACHED",
			"NO_EXECUTION_CONTEXT",
			"CONTEXT_NOT_FOUND",
			"CONTEXT_DESTROYED",
			"NO_NODE_AT_LOCATION",
		] as const;
		for (const kind of retryable) {
			expect(
				isRetryableClickPreparationError(
					new BrowserUseCdpCommandError("DOM.getBoxModel", -32000, kind),
				),
			).toBe(true);
		}
		expect(
			isRetryableClickPreparationError(
				new BrowserUseCdpCommandError("DOM.focus", -32000, "NOT_FOCUSABLE"),
			),
		).toBe(false);
		expect(
			isRetryableClickPreparationError(
				new BrowserUseCdpCommandError("DOM.getBoxModel", null, "OTHER"),
			),
		).toBe(false);
		expect(isRetryableClickPreparationError(new BrowserElementError())).toBe(
			true,
		);
		expect(
			isRetryableClickPreparationError(
				new Error("Browser Use CDP command failed"),
			),
		).toBe(false);
	});
});

describe("BrowserUseCdpConnection command errors", () => {
	test("names the failing method and classifies the provider message", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
		);
		const pending = connection.send("DOM.getBoxModel", { backendNodeId: 5 });
		const sent = JSON.parse(webSocket.sent[0] ?? "{}") as { id: number };

		webSocket.emit("message", {
			data: JSON.stringify({
				id: sent.id,
				error: { code: -32000, message: "Could not compute box model." },
			}),
		});

		const rejection = await pending.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(BrowserUseCdpCommandError);
		const commandError = rejection as BrowserUseCdpCommandError;
		expect(commandError.message).toBe("Browser Use CDP command failed");
		expect(commandError.method).toBe("DOM.getBoxModel");
		expect(commandError.code).toBe(-32000);
		expect(commandError.kind).toBe("NO_BOX_MODEL");
	});

	test("keeps a missing code and an unreadable message reportable", async () => {
		const webSocket = new FakeWebSocket();
		const connection = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			stubUpgradeFetch(webSocket),
		);
		const pending = connection.send("Input.dispatchMouseEvent");
		const sent = JSON.parse(webSocket.sent[0] ?? "{}") as { id: number };

		webSocket.emit("message", {
			data: JSON.stringify({ id: sent.id, error: "rejected" }),
		});

		const rejection = await pending.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(BrowserUseCdpCommandError);
		const commandError = rejection as BrowserUseCdpCommandError;
		expect(commandError.method).toBe("Input.dispatchMouseEvent");
		expect(commandError.code).toBeNull();
		expect(commandError.kind).toBe("OTHER");
	});
});

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
			{ source: "form-agent", jobId: connectJob.id, dryRun: "true" },
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
		// The provider snapshot is taken before the backoff sleep, right after
		// the rejection, so it describes the sessions that consumed the limit.
		expect(JSON.parse(captured.warnings[1] ?? "{}")).toEqual({
			event: "browser_use_session_limit",
			activeTotal: 0,
			activeTagged: 0,
		});
		expect(client.listedFilters.length).toBeGreaterThanOrEqual(2);
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
			reason: "API_ERROR",
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
			{
				event: "browser_use_session_reclaimed",
				ok: true,
				activeTotal: 3,
				activeTagged: 2,
				matched: 1,
				stopped: 1,
				failed: 0,
			},
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

describe("BrowserUseCdpDriver session recovery", () => {
	test("does not retry a redirected debugger endpoint", async () => {
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
				fetcher: async () =>
					new Response(null, {
						status: 302,
						headers: { Location: "https://evil.example/json/version" },
					}),
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseApiError);
		expect((caught as BrowserUseApiError).status).toBe(302);
		expect(client.createCount).toBe(1);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
		expect(captured.warnings).toEqual([]);
	});

	test("stops an unusable created session and reclaims before the next attempt", async () => {
		const client = new FakeBrowserUseClient({
			createFailures: [
				new BrowserUseResponseError(
					"Browser Use did not return an active session with a CDP URL",
					"session-lost",
				),
			],
		});
		const captured = captureWarnings();

		let driver: BrowserUseCdpDriver;
		try {
			driver = await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10, 20, 30],
				sleep: async () => {},
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} finally {
			captured.restore();
		}

		expect(driver).toBeInstanceOf(BrowserUseCdpDriver);
		expect(client.calls).toEqual([
			"create",
			"stop:session-lost",
			"list",
			"create",
		]);
		expect(client.listedFilters).toEqual(["active"]);
	});

	test("reclaims a session the provider kept from a failed attempt", async () => {
		const client = new FakeBrowserUseClient({
			createFailures: [new BrowserUseApiError("create", 503)],
			activeSessions: [{ id: "orphan-1", jobId: connectJob.id }],
		});
		const captured = captureWarnings();

		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				retryDelaysMs: [10],
				sleep: async () => {},
				connectConnection: async () => asConnection(new FakeCdpConnection()),
			});
		} finally {
			captured.restore();
		}

		expect(client.calls).toEqual(["create", "list", "stop:orphan-1", "create"]);
	});

	test("ends the run without retrying when the upgrade is aborted", async () => {
		const controller = new AbortController();
		const client = new FakeBrowserUseClient();
		const signals: Array<AbortSignal | undefined> = [];
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await BrowserUseCdpDriver.connect("api-key", connectJob, true, {
				client: asClient(client),
				signal: controller.signal,
				retryDelaysMs: [5_000],
				connectConnection: async (_webSocketUrl, connectSignal) => {
					signals.push(connectSignal);
					controller.abort();
					throw new Error("Browser Use CDP connection aborted");
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
		expect(signals).toEqual([controller.signal]);
		expect(client.createCount).toBe(1);
		expect(client.stopped).toEqual([{ id: "session-1", hasSignal: true }]);
		expect(captured.warnings).toEqual([]);
	});
});

describe("BrowserUseCdpConnection upgrade abort", () => {
	test("reports an aborted upgrade instead of a connection failure", async () => {
		const controller = new AbortController();
		const inits: Array<RequestInit | undefined> = [];

		const caught = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			(async (_url: unknown, init: RequestInit | undefined) => {
				inits.push(init);
				controller.abort();
				throw new Error("The operation was aborted");
			}) as unknown as typeof fetch,
			20,
			controller.signal,
		).catch((error: unknown) => error);

		expect((caught as Error).message).toBe(
			"Browser Use CDP connection aborted",
		);
		expect(inits[0]?.signal).toBe(controller.signal);
	});

	test("still reports a transport failure when the run is not aborted", async () => {
		const controller = new AbortController();

		const caught = await BrowserUseCdpConnection.connect(
			"wss://connect.browser-use.com/session",
			(async () => {
				throw new TypeError("Network connection lost");
			}) as unknown as typeof fetch,
			20,
			controller.signal,
		).catch((error: unknown) => error);

		expect((caught as Error).message).toBe("Browser Use CDP connection failed");
	});
});

describe("BrowserUseCdpDriver session stop accounting", () => {
	test("records a stop that left the session active as a failure", async () => {
		const client = new FakeBrowserUseClient({
			stopError: new BrowserUseResponseError(
				SESSION_STILL_ACTIVE_MESSAGE,
				"session-1",
			),
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
			reason: "STILL_ACTIVE",
			durationMs: expect.any(Number),
		});
	});

	test("counts only the confirmed stops when reclaiming a job", async () => {
		const client = new FakeBrowserUseClient({
			activeSessions: [
				{ id: "stale-1", jobId: connectJob.id },
				{ id: "stale-2", jobId: connectJob.id },
				{ id: "other-1", jobId: "another-job" },
			],
			stopErrorsById: { "stale-2": new BrowserUseApiError("stop", 500) },
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

		expect(client.stopped.map((entry) => entry.id)).toEqual([
			"stale-1",
			"stale-2",
		]);
		expect(
			logEvents(captured.logs).find(
				(entry) =>
					(entry as { event: string }).event ===
					"browser_use_session_reclaimed",
			),
		).toEqual({
			event: "browser_use_session_reclaimed",
			ok: false,
			activeTotal: 3,
			activeTagged: 3,
			matched: 2,
			stopped: 1,
			failed: 1,
		});
	});
});

const ELEMENT_PAGE_URL = "https://example.com/contact";

const ELEMENT_PAGE_DOCUMENT = {
	backendNodeId: 1,
	nodeName: "#document",
	children: [
		{
			backendNodeId: 2,
			nodeName: "FORM",
			attributes: ["action", "/send", "method", "post"],
			children: [
				{ backendNodeId: 3, nodeName: "INPUT" },
				{ backendNodeId: 4, nodeName: "SELECT" },
				{ backendNodeId: 5, nodeName: "BUTTON" },
				{ backendNodeId: 6, nodeName: "INPUT" },
				{ backendNodeId: 7, nodeName: "INPUT" },
			],
		},
	],
};

/** The elementIds the first observation of the fixture page hands out. */
const TEXT_ELEMENT_ID = "fa-1-0";
const SELECT_ELEMENT_ID = "fa-1-1";
const BUTTON_ELEMENT_ID = "fa-1-2";
const RADIO_ELEMENT_ID = "fa-1-3";
const CHECKBOX_ELEMENT_ID = "fa-1-4";
const BUTTON_BACKEND_NODE_ID = 5;

function cdpCommandFailed(): Error {
	return new Error("Browser Use CDP command failed");
}

function cdpCommandError(
	method: string,
	kind: CdpCommandErrorKind,
	code: number | null = -32000,
): BrowserUseCdpCommandError {
	return new BrowserUseCdpCommandError(method, code, kind);
}

/** Fails the named command for its first `failures` calls and then lets it through. */
function failFirstCalls(
	method: string,
	failures: number,
	error: () => Error,
): (candidate: string) => Error | null {
	let calls = 0;
	return (candidate) => {
		if (candidate !== method) return null;
		calls += 1;
		return calls <= failures ? error() : null;
	};
}

function countSent(
	connection: ScriptedCdpConnection,
	method: string,
	match: (params: Record<string, unknown>) => boolean = () => true,
): number {
	return connection.sent.filter(
		(entry) => entry.method === method && match(entry.params),
	).length;
}

function elementFixtureState(backendNodeId: number): Record<string, unknown> {
	const base = {
		ok: true,
		visible: true,
		name: null,
		label: "",
		placeholder: null,
		required: false,
		value: "",
		options: [] as Array<{ value: string; label: string }>,
		submitLike: false,
		target: "",
		formAction: "",
		formMethod: "post",
		disabled: false,
		readOnly: false,
		checked: false,
	};
	if (backendNodeId === 3) return { ...base, tag: "input", type: "text" };
	if (backendNodeId === 4) {
		return {
			...base,
			tag: "select",
			type: "",
			options: [{ value: "sales", label: "Sales" }],
		};
	}
	if (backendNodeId === 6) {
		return { ...base, tag: "input", type: "radio", value: "email" };
	}
	if (backendNodeId === 7) {
		return { ...base, tag: "input", type: "checkbox", value: "checked" };
	}
	return { ...base, tag: "button", type: "button" };
}

/**
 * Answers the CDP commands `observe` and the element operations send, so a
 * test can fail one named command and watch how the driver reports it.
 */
class ScriptedCdpConnection {
	closeCount = 0;
	closed = false;
	readonly sent: Array<{ method: string; params: Record<string, unknown> }> =
		[];
	fail:
		| ((method: string, params: Record<string, unknown>) => Error | null)
		| null = null;
	respond: (method: string, params: Record<string, unknown>) => unknown =
		scriptedCdpResponse;

	send<TResult>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<TResult> {
		this.sent.push({ method, params });
		const failure = this.fail?.(method, params);
		if (failure) return Promise.reject(failure);
		return Promise.resolve(this.respond(method, params) as TResult);
	}

	lastResponseCharacters(): number | undefined {
		return undefined;
	}

	/** A Set per method, the way the real connection keeps its listeners. */
	readonly listeners = new Map<
		string,
		Set<(params: Record<string, unknown>, sessionId?: string) => void>
	>();

	on(
		method: string,
		handler: (params: Record<string, unknown>, sessionId?: string) => void,
	): () => void {
		const handlers = this.listeners.get(method) ?? new Set();
		handlers.add(handler);
		this.listeners.set(method, handlers);
		return () => {
			handlers.delete(handler);
		};
	}

	/** Delivers a CDP event to the driver the way the connection would. */
	emit(
		method: string,
		params: Record<string, unknown>,
		sessionId = "session-1",
	): void {
		for (const handler of this.listeners.get(method) ?? []) {
			handler(params, sessionId);
		}
	}

	close(): void {
		this.closeCount += 1;
		this.closed = true;
	}
}

function scriptedCdpResponse(
	method: string,
	params: Record<string, unknown>,
): unknown {
	switch (method) {
		case "Target.getTargets":
			return { targetInfos: [{ targetId: "target-1", type: "page" }] };
		case "Target.attachToTarget":
			return { sessionId: "session-1" };
		case "Page.getFrameTree":
			return { frameTree: { frame: { id: "frame-1" } } };
		case "Page.createIsolatedWorld":
			return { executionContextId: 11 };
		case "Runtime.evaluate": {
			const expression = String(params.expression ?? "");
			if (expression === "location.href") {
				return { result: { value: ELEMENT_PAGE_URL } };
			}
			if (expression === "document.readyState") {
				return { result: { value: "complete" } };
			}
			if (expression.startsWith("(document.body")) {
				return { result: { value: "Contact form" } };
			}
			return { result: {} };
		}
		case "DOM.getDocument":
			return { root: ELEMENT_PAGE_DOCUMENT };
		case "DOM.resolveNode":
			return { object: { objectId: `object-${params.backendNodeId}` } };
		case "Runtime.callFunctionOn": {
			if (
				params.functionDeclaration ===
				READ_FORM_PROHIBITION_REASON_CODES_FUNCTION
			) {
				return { result: { value: [] } };
			}
			// The choice page functions answer with fixed tokens only.
			if (
				params.functionDeclaration === SELECT_OPTION_BY_CANDIDATE_FUNCTION ||
				params.functionDeclaration === MATCHES_CHOICE_CANDIDATE_FUNCTION ||
				params.functionDeclaration === SET_CHECKED_VALUE_FUNCTION
			) {
				return { result: { value: true } };
			}
			if (params.functionDeclaration === SELECT_RADIO_BY_CANDIDATE_FUNCTION) {
				return { result: { value: "selected" } };
			}
			const backendNodeId = Number(
				String(params.objectId ?? "").replace("object-", ""),
			);
			return { result: { value: elementFixtureState(backendNodeId) } };
		}
		case "Accessibility.getPartialAXTree":
			return { nodes: [] };
		case "DOM.getBoxModel":
			return { model: { border: [0, 0, 20, 0, 20, 10, 0, 10] } };
		case "DOM.getNodeForLocation":
			return { backendNodeId: BUTTON_BACKEND_NODE_ID };
		default:
			return {};
	}
}

/** Connects a driver to the fixture page without navigating or observing. */
async function scriptedDriver(
	connection: ScriptedCdpConnection,
	dryRun = true,
	targetDomain = "example.com",
): Promise<BrowserUseCdpDriver> {
	const captured = captureLogs();
	try {
		const driver = await BrowserUseCdpDriver.connect(
			"api-key",
			connectJob,
			dryRun,
			{
				client: asClient(new FakeBrowserUseClient()),
				connectConnection: async () =>
					connection as unknown as BrowserUseCdpConnection,
			},
		);
		await driver.restrictToDomain(targetDomain, []);
		return driver;
	} finally {
		captured.restore();
	}
}

/** Connects a driver to the fixture page and takes the first observation. */
async function observedElementDriver(): Promise<{
	driver: BrowserUseCdpDriver;
	connection: ScriptedCdpConnection;
}> {
	const connection = new ScriptedCdpConnection();
	const driver = await scriptedDriver(connection);
	const captured = captureLogs();
	try {
		await driver.observe();
	} finally {
		captured.restore();
	}
	return { driver, connection };
}

describe("BrowserUseCdpDriver element operation failures", () => {
	test("reports a failed click command as an element operation error", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.fail = (method) =>
			method === "DOM.getBoxModel" ? cdpCommandFailed() : null;
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await driver.clickNonSubmit(BUTTON_ELEMENT_ID);
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserElementOperationError);
		expect((caught as BrowserElementOperationError).operation).toBe("click");
		expect(captured.warnings.map((entry) => JSON.parse(entry))).toEqual([
			{ event: "browser_element_operation_failed", operation: "click" },
		]);
	});

	test("keeps a failed mouse release a run error so the click is not repeated", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.fail = (method, params) =>
			method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"
				? cdpCommandFailed()
				: null;
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await driver.clickNonSubmit(BUTTON_ELEMENT_ID);
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).not.toBeInstanceOf(BrowserElementError);
		expect((caught as Error).message).toBe("Browser Use CDP command failed");
		expect(captured.warnings).toEqual([]);
		expect(
			connection.sent.filter(
				(entry) =>
					entry.method === "Input.dispatchMouseEvent" &&
					entry.params.type === "mousePressed",
			),
		).toHaveLength(1);
	});

	test("keeps a closed connection during a click a run error", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.fail = (method) =>
			method === "DOM.getBoxModel"
				? new Error("Browser Use CDP connection closed")
				: null;

		const caught = await driver
			.clickNonSubmit(BUTTON_ELEMENT_ID)
			.catch((error: unknown) => error);

		expect(caught).not.toBeInstanceOf(BrowserElementError);
		expect((caught as Error).message).toBe("Browser Use CDP connection closed");
	});

	test("reports a failed fill command as an element operation error", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.fail = (method) =>
			method === "DOM.focus" ? cdpCommandFailed() : null;
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await driver.fill(TEXT_ELEMENT_ID, "Hello");
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserElementOperationError);
		expect((caught as BrowserElementOperationError).operation).toBe("fill");
		expect(captured.warnings.map((entry) => JSON.parse(entry))).toEqual([
			{ event: "browser_element_operation_failed", operation: "fill" },
		]);
	});

	test("reports a failed select command as an element operation error", async () => {
		const { driver, connection } = await observedElementDriver();
		let callFunctionOnCount = 0;
		connection.fail = (method) => {
			if (method !== "Runtime.callFunctionOn") return null;
			callFunctionOnCount += 1;
			// The first call inspects the element; the second sets the value.
			return callFunctionOnCount === 2 ? cdpCommandFailed() : null;
		};
		const captured = captureWarnings();

		let caught: unknown;
		try {
			await driver.select(SELECT_ELEMENT_ID, ["sales"]);
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserElementOperationError);
		expect((caught as BrowserElementOperationError).operation).toBe("select");
		expect(captured.warnings.map((entry) => JSON.parse(entry))).toEqual([
			{ event: "browser_element_operation_failed", operation: "select" },
		]);
	});
});

describe("click preparation retries", () => {
	test("repeats a click preparation that reports no box model and then clicks", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.fail = failFirstCalls("DOM.getBoxModel", 2, () =>
			cdpCommandError("DOM.getBoxModel", "NO_BOX_MODEL"),
		);
		const captured = captureLogs();

		try {
			await driver.clickNonSubmit(BUTTON_ELEMENT_ID);
		} finally {
			captured.restore();
		}

		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_click_preparation_retry",
				attempt: 1,
				kind: "NO_BOX_MODEL",
			},
			{
				event: "browser_click_preparation_retry",
				attempt: 2,
				kind: "NO_BOX_MODEL",
			},
		]);
		expect(countSent(connection, "DOM.getBoxModel")).toBe(3);
		expect(countSent(connection, "DOM.scrollIntoViewIfNeeded")).toBe(3);
		expect(
			countSent(
				connection,
				"Input.dispatchMouseEvent",
				(params) => params.type === "mousePressed",
			),
		).toBe(1);
		expect(
			countSent(
				connection,
				"Input.dispatchMouseEvent",
				(params) => params.type === "mouseReleased",
			),
		).toBe(1);
	});

	test("repeats a click preparation whose hit test lands on another node", async () => {
		const { driver, connection } = await observedElementDriver();
		let hitTests = 0;
		connection.fail = null;
		const scripted = connection.respond;
		connection.respond = (method, params) => {
			if (method !== "DOM.getNodeForLocation") return scripted(method, params);
			hitTests += 1;
			return hitTests <= 2
				? { backendNodeId: 99 }
				: { backendNodeId: BUTTON_BACKEND_NODE_ID };
		};
		const captured = captureLogs();

		try {
			await driver.clickNonSubmit(BUTTON_ELEMENT_ID);
		} finally {
			captured.restore();
		}

		expect(logEvents(captured.logs)).toEqual([
			{
				event: "browser_click_preparation_retry",
				attempt: 1,
				kind: "HIT_TEST",
			},
			{
				event: "browser_click_preparation_retry",
				attempt: 2,
				kind: "HIT_TEST",
			},
		]);
		expect(hitTests).toBe(3);
	});

	test("reports the failing method and kind once the retries are spent", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.fail = (method) =>
			method === "DOM.getBoxModel"
				? cdpCommandError("DOM.getBoxModel", "NO_BOX_MODEL")
				: null;
		const capturedLogs = captureLogs();
		const capturedWarnings = captureWarnings();

		let caught: unknown;
		try {
			await driver.clickNonSubmit(BUTTON_ELEMENT_ID);
		} catch (error) {
			caught = error;
		} finally {
			capturedWarnings.restore();
			capturedLogs.restore();
		}

		expect(caught).toBeInstanceOf(BrowserElementOperationError);
		expect((caught as BrowserElementOperationError).operation).toBe("click");
		expect(countSent(connection, "DOM.getBoxModel")).toBe(3);
		expect(logEvents(capturedLogs.logs)).toEqual([
			{
				event: "browser_click_preparation_retry",
				attempt: 1,
				kind: "NO_BOX_MODEL",
			},
			{
				event: "browser_click_preparation_retry",
				attempt: 2,
				kind: "NO_BOX_MODEL",
			},
		]);
		expect(logEvents(capturedWarnings.warnings)).toEqual([
			{
				event: "browser_element_operation_failed",
				operation: "click",
				method: "DOM.getBoxModel",
				kind: "NO_BOX_MODEL",
				code: -32000,
			},
		]);
	});

	test("does not repeat a click preparation whose failure describes the element", async () => {
		// The kind, not the command it arrived on, decides whether another frame
		// can help, so a non-retryable kind ends the operation on the first try.
		for (const kind of ["NOT_FOCUSABLE", "OTHER"] as const) {
			const { driver, connection } = await observedElementDriver();
			connection.fail = (method) =>
				method === "DOM.getBoxModel"
					? cdpCommandError("DOM.getBoxModel", kind, null)
					: null;
			const capturedLogs = captureLogs();
			const capturedWarnings = captureWarnings();

			let caught: unknown;
			try {
				await driver.clickNonSubmit(BUTTON_ELEMENT_ID);
			} catch (error) {
				caught = error;
			} finally {
				capturedWarnings.restore();
				capturedLogs.restore();
			}

			expect(caught).toBeInstanceOf(BrowserElementOperationError);
			expect(countSent(connection, "DOM.getBoxModel")).toBe(1);
			expect(capturedLogs.logs).toEqual([]);
			expect(logEvents(capturedWarnings.warnings)).toEqual([
				{
					event: "browser_element_operation_failed",
					operation: "click",
					method: "DOM.getBoxModel",
					kind,
					code: null,
				},
			]);
		}
	});
});

interface FakeOption {
	value: string;
	text: string;
	selected: boolean;
	disabled: boolean;
	parentElement: { tagName: string; disabled: boolean } | null;
}

interface FakeRadio {
	tagName: string;
	type: string;
	name: string;
	value: string;
	form: object | null;
	disabled: boolean;
	checked: boolean;
	labels: Array<{ textContent: string }>;
	ariaLabel: string | null;
	ariaLabelledBy: string | null;
	ancestorLabel: string | null;
	getAttribute(name: string): string | null;
	closest(selector: string): { textContent: string } | null;
	getRootNode(): {
		querySelectorAll(selector: string): FakeRadio[];
		getElementById(id: string): { textContent: string } | undefined;
	};
	click(): void;
}

/** A minimal option list the select page function can walk. */
function fakeSelect(
	options: Array<{
		value: string;
		text: string;
		disabled?: boolean;
		group?: { tagName: string; disabled: boolean };
	}>,
): {
	tagName: string;
	options: FakeOption[];
	dispatchEvent(): boolean;
} {
	return {
		tagName: "SELECT",
		options: options.map((option) => ({
			value: option.value,
			text: option.text,
			selected: false,
			disabled: option.disabled === true,
			parentElement: option.group ?? null,
		})),
		dispatchEvent: () => true,
	};
}

/** Builds the same option list from value / text pairs, all enabled. */
function fakeSelectOf(
	options: Array<[value: string, text: string]>,
): ReturnType<typeof fakeSelect> {
	return fakeSelect(options.map(([value, text]) => ({ value, text })));
}

/**
 * Builds one radio group whose members share a form owner, so the page
 * function can be exercised against the DOM order as well as the candidate
 * order.
 */
function fakeRadioGroup(
	members: Array<{
		value: string;
		/** An array becomes several associated labels, as element.labels holds. */
		label?: string | string[];
		ariaLabel?: string;
		/**
		 * Text held by the elements this radio's aria-labelledby points at. An
		 * array becomes several space-separated ids, as a real page writes them.
		 */
		labelledBy?: string | string[];
		name?: string;
		disabled?: boolean;
		ownForm?: boolean;
	}>,
): FakeRadio[] {
	const form = {};
	const group: FakeRadio[] = [];
	const labelledByTargets = new Map<string, { textContent: string }>();
	for (const member of members) {
		const labelledByTexts =
			member.labelledBy === undefined
				? []
				: Array.isArray(member.labelledBy)
					? member.labelledBy
					: [member.labelledBy];
		// The id is derived from the text, so two radios naming the same text
		// really share one id, as a group sharing a question label does. The
		// ids carry an "s" on purpose, so a split on a broken whitespace
		// pattern loses them instead of quietly passing.
		const labelledByIds = labelledByTexts.map(
			(text) => `labels-${text.replace(/\s+/g, "-")}`,
		);
		const radio: FakeRadio = {
			tagName: "INPUT",
			type: "radio",
			name: member.name ?? "contactMethod",
			value: member.value,
			form: member.ownForm === false ? null : form,
			disabled: member.disabled === true,
			checked: false,
			labels: (member.label === undefined
				? []
				: Array.isArray(member.label)
					? member.label
					: [member.label]
			).map((textContent) => ({ textContent })),
			ariaLabel: member.ariaLabel ?? null,
			ariaLabelledBy:
				labelledByIds.length === 0 ? null : labelledByIds.join(" "),
			ancestorLabel: null,
			getAttribute: (name: string) => {
				if (name === "aria-label") return radio.ariaLabel;
				if (name === "aria-labelledby") return radio.ariaLabelledBy;
				return null;
			},
			closest: () =>
				radio.ancestorLabel === null
					? null
					: { textContent: radio.ancestorLabel },
			getRootNode: () => ({
				querySelectorAll: () => group,
				getElementById: (id: string) => labelledByTargets.get(id),
			}),
			click() {
				for (const other of group) {
					if (other.name === radio.name && other.form === radio.form) {
						other.checked = false;
					}
				}
				radio.checked = true;
			},
		};
		labelledByIds.forEach((id, index) => {
			labelledByTargets.set(id, {
				textContent: labelledByTexts[index] as string,
			});
		});
		group.push(radio);
	}
	return group;
}

function selectOptionByCandidate(): (
	this: object,
	candidates: readonly string[],
) => unknown {
	return runInNewContext(`(${SELECT_OPTION_BY_CANDIDATE_FUNCTION})`, {
		Event: class {},
	}) as (this: object, candidates: readonly string[]) => unknown;
}

function selectRadioByCandidate(): (
	this: object,
	candidates: readonly string[],
) => unknown {
	return runInNewContext(`(${SELECT_RADIO_BY_CANDIDATE_FUNCTION})`) as (
		this: object,
		candidates: readonly string[],
	) => unknown;
}

function matchesChoiceCandidate(): (
	this: object,
	candidates: readonly string[],
) => unknown {
	return runInNewContext(`(${MATCHES_CHOICE_CANDIDATE_FUNCTION})`) as (
		this: object,
		candidates: readonly string[],
	) => unknown;
}

describe("choice candidate matching in the page", () => {
	test("takes the first candidate an option offers by value or by text", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelectOf([
			["", "選択してください"],
			["shaken", "車検のご予約"],
			["other", "その他"],
		]);

		expect(setOption.call(element, ["その他のお問い合わせ", "その他"])).toBe(
			true,
		);
		expect(
			element.options
				.filter((option) => option.selected)
				.map((option) => option.value),
		).toEqual(["other"]);
	});

	test("prefers the earlier candidate over the earlier option", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelectOf([
			["shaken", "車検のご予約"],
			["other", "その他"],
		]);

		expect(setOption.call(element, ["その他", "車検のご予約"])).toBe(true);
		expect(element.options[1]?.selected).toBe(true);
	});

	test("matches an option text case-insensitively after trimming", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelectOf([["email", "  E-Mail  "]]);

		expect(setOption.call(element, ["e-mail"])).toBe(true);
		expect(element.options[0]?.selected).toBe(true);
	});

	test("never selects a placeholder option with an empty value", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelectOf([
			["", "選択してください"],
			["other", "その他"],
		]);

		expect(setOption.call(element, ["選択してください"])).toBe(false);
		expect(element.options.some((option) => option.selected)).toBe(false);
	});

	test("skips a disabled option and moves on to the next candidate", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelect([
			{ value: "shaken", text: "車検のご予約", disabled: true },
			{ value: "other", text: "その他" },
		]);

		expect(setOption.call(element, ["車検のご予約", "その他"])).toBe(true);
		expect(
			element.options
				.filter((option) => option.selected)
				.map((option) => option.value),
		).toEqual(["other"]);
	});

	test("skips an option under a disabled optgroup", () => {
		const setOption = selectOptionByCandidate();
		const closedGroup = { tagName: "OPTGROUP", disabled: true };
		const openGroup = { tagName: "OPTGROUP", disabled: false };
		const element = fakeSelect([
			{ value: "shaken", text: "車検のご予約", group: closedGroup },
			{ value: "other", text: "その他", group: openGroup },
		]);

		expect(setOption.call(element, ["車検のご予約", "その他"])).toBe(true);
		expect(
			element.options
				.filter((option) => option.selected)
				.map((option) => option.value),
		).toEqual(["other"]);
	});

	test("reports no match when every matching option is disabled", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelect([
			{ value: "shaken", text: "車検のご予約", disabled: true },
		]);

		expect(setOption.call(element, ["車検のご予約"])).toBe(false);
		expect(element.options.some((option) => option.selected)).toBe(false);
	});

	test("reports no match instead of guessing an option", () => {
		const setOption = selectOptionByCandidate();
		const element = fakeSelectOf([["shaken", "車検のご予約"]]);

		expect(setOption.call(element, ["その他"])).toBe(false);
		expect(element.options.some((option) => option.selected)).toBe(false);
	});

	test("checks the radio matching the earliest candidate regardless of DOM order", () => {
		const setRadio = selectRadioByCandidate();
		const [phone, email] = fakeRadioGroup([
			{ value: "phone", label: "電話" },
			{ value: "email", label: "メール" },
		]);

		expect(setRadio.call(email as object, ["メール", "Email"])).toBe(
			"selected",
		);
		expect(email?.checked).toBe(true);
		expect(phone?.checked).toBe(false);
	});

	test("refuses a radio when another radio matches an earlier candidate", () => {
		const setRadio = selectRadioByCandidate();
		const [phone, email] = fakeRadioGroup([
			{ value: "phone", label: "電話" },
			{ value: "email", label: "メール" },
		]);

		expect(setRadio.call(email as object, ["電話", "メール"])).toBe(
			"higher_priority_exists",
		);
		expect(email?.checked).toBe(false);
		expect(phone?.checked).toBe(false);
	});

	test("ignores a radio of another group, another form, or a disabled one", () => {
		const setRadio = selectRadioByCandidate();
		const [other, disabled, unowned, email] = fakeRadioGroup([
			{ value: "phone", label: "電話", name: "otherGroup" },
			{ value: "fax", label: "FAX", disabled: true },
			{ value: "post", label: "郵送", ownForm: false },
			{ value: "email", label: "メール" },
		]);

		expect(
			setRadio.call(email as object, ["電話", "FAX", "郵送", "メール"]),
		).toBe("selected");
		expect(email?.checked).toBe(true);
		expect(other?.checked).toBe(false);
		expect(disabled?.checked).toBe(false);
		expect(unowned?.checked).toBe(false);
	});

	test("matches a radio by its value and by its aria-label", () => {
		const setRadio = selectRadioByCandidate();
		const [byValue] = fakeRadioGroup([{ value: "email" }]);
		const [byAria] = fakeRadioGroup([
			{ value: "e", ariaLabel: "メール", name: "aria" },
		]);

		expect(setRadio.call(byValue as object, ["email"])).toBe("selected");
		expect(setRadio.call(byAria as object, ["メール"])).toBe("selected");
	});

	test("matches a radio labelled only through aria-labelledby", () => {
		const setRadio = selectRadioByCandidate();
		const [byLabelledBy] = fakeRadioGroup([
			{ value: "e", labelledBy: "メール" },
		]);

		expect(setRadio.call(byLabelledBy as object, ["メール"])).toBe("selected");
		expect(byLabelledBy?.checked).toBe(true);
	});

	test("matches only the joined form of several associated labels", () => {
		const setRadio = selectRadioByCandidate();
		const [byJoined] = fakeRadioGroup([
			{ value: "e", label: ["ご希望の連絡方法", "メール"] },
		]);
		const [byFragment] = fakeRadioGroup([
			{ value: "p", label: ["ご希望の連絡方法", "メール"], name: "fragment" },
		]);

		expect(setRadio.call(byJoined as object, ["ご希望の連絡方法 メール"])).toBe(
			"selected",
		);
		expect(setRadio.call(byFragment as object, ["メール"])).toBe(
			"not_candidate",
		);
	});

	test("matches only the joined form of a multi-target aria-labelledby", () => {
		const setRadio = selectRadioByCandidate();
		const [byJoined] = fakeRadioGroup([
			{ value: "e", labelledBy: ["ご希望の連絡方法", "メール"] },
		]);
		const [byFragment] = fakeRadioGroup([
			{
				value: "p",
				labelledBy: ["ご希望の連絡方法", "メール"],
				name: "fragment",
			},
		]);

		// observe reports the two targets as one string, so only that string is
		// a candidate's counterpart.
		expect(setRadio.call(byJoined as object, ["ご希望の連絡方法 メール"])).toBe(
			"selected",
		);
		expect(setRadio.call(byFragment as object, ["メール"])).toBe(
			"not_candidate",
		);
		expect(byFragment?.checked).toBe(false);
	});

	test("keeps a question label shared by a radio group from matching", () => {
		const setRadio = selectRadioByCandidate();
		const [email, phone] = fakeRadioGroup([
			{ value: "email", labelledBy: ["ご希望の連絡方法", "メール"] },
			{ value: "phone", labelledBy: ["ご希望の連絡方法", "電話"] },
		]);

		expect(setRadio.call(email as object, ["ご希望の連絡方法"])).toBe(
			"not_candidate",
		);
		expect(setRadio.call(phone as object, ["ご希望の連絡方法"])).toBe(
			"not_candidate",
		);
		expect(email?.checked).toBe(false);
		expect(phone?.checked).toBe(false);
	});

	test("matches a checkbox labelled only through aria-labelledby", () => {
		const matches = matchesChoiceCandidate();
		const [consent] = fakeRadioGroup([
			{ value: "agreed", labelledBy: "同意する" },
		]);

		expect(matches.call(consent as object, ["同意する"])).toBe(true);
		expect(matches.call(consent as object, ["同意"])).toBe(false);
	});

	test("answers not_candidate when no candidate matches the radio", () => {
		const setRadio = selectRadioByCandidate();
		const [email] = fakeRadioGroup([{ value: "email", label: "メール" }]);

		expect(setRadio.call(email as object, ["郵送"])).toBe("not_candidate");
		expect(email?.checked).toBe(false);
	});

	test("matches a checkbox by its own value or label only", () => {
		const matches = matchesChoiceCandidate();
		const [consent] = fakeRadioGroup([{ value: "agreed", label: "同意する" }]);

		expect(matches.call(consent as object, ["同意する"])).toBe(true);
		expect(matches.call(consent as object, ["agreed"])).toBe(true);
		expect(matches.call(consent as object, ["同意"])).toBe(false);
	});
});

describe("BrowserUseCdpDriver choice controls", () => {
	test("hands the page the candidate list and keeps page text out of the call", async () => {
		const { driver, connection } = await observedElementDriver();

		await driver.select(SELECT_ELEMENT_ID, ["その他", "other"]);

		const call = connection.sent.find(
			(entry) =>
				entry.method === "Runtime.callFunctionOn" &&
				entry.params.functionDeclaration ===
					SELECT_OPTION_BY_CANDIDATE_FUNCTION,
		);
		expect(call?.params.arguments).toEqual([{ value: ["その他", "other"] }]);
	});

	test("rejects a select the page reports as unmatched", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.respond = (method, params) =>
			method === "Runtime.callFunctionOn" &&
			params.functionDeclaration === SELECT_OPTION_BY_CANDIDATE_FUNCTION
				? { result: { value: false } }
				: scriptedCdpResponse(method, params);

		await expect(
			driver.select(SELECT_ELEMENT_ID, ["その他"]),
		).rejects.toBeInstanceOf(BrowserElementError);
	});

	test("rejects a select result that is not the page's fixed boolean", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.respond = (method, params) =>
			method === "Runtime.callFunctionOn" &&
			params.functionDeclaration === SELECT_OPTION_BY_CANDIDATE_FUNCTION
				? { result: { value: "その他" } }
				: scriptedCdpResponse(method, params);

		await expect(
			driver.select(SELECT_ELEMENT_ID, ["その他"]),
		).rejects.toBeInstanceOf(BrowserElementError);
	});

	test("checks a radio only when the page reports it selected", async () => {
		for (const [outcome, selected] of [
			["selected", true],
			["not_candidate", false],
			["higher_priority_exists", false],
			["メール", false],
		] as const) {
			const { driver, connection } = await observedElementDriver();
			connection.respond = (method, params) =>
				method === "Runtime.callFunctionOn" &&
				params.functionDeclaration === SELECT_RADIO_BY_CANDIDATE_FUNCTION
					? { result: { value: outcome } }
					: scriptedCdpResponse(method, params);

			const caught = await driver
				.select(RADIO_ELEMENT_ID, ["メール"])
				.then(() => null)
				.catch((error: unknown) => error);

			expect(caught === null).toBe(selected);
			if (!selected) expect(caught).toBeInstanceOf(BrowserElementError);
		}
	});

	test("reads the checkbox state from the candidate list", async () => {
		for (const [candidates, expected] of [
			[["checked"], true],
			[["true"], true],
			[["unchecked"], false],
			[["false"], false],
		] as const) {
			const { driver, connection } = await observedElementDriver();

			await driver.select(CHECKBOX_ELEMENT_ID, candidates);

			const call = connection.sent.find(
				(entry) =>
					entry.method === "Runtime.callFunctionOn" &&
					entry.params.functionDeclaration === SET_CHECKED_VALUE_FUNCTION,
			);
			expect(call?.params.arguments).toEqual([{ value: expected }]);
		}
	});

	test("checks a checkbox whose label matches a candidate", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.respond = (method, params) =>
			method === "Runtime.callFunctionOn" &&
			params.functionDeclaration === MATCHES_CHOICE_CANDIDATE_FUNCTION
				? { result: { value: true } }
				: scriptedCdpResponse(method, params);

		await driver.select(CHECKBOX_ELEMENT_ID, ["同意する"]);

		const call = connection.sent.find(
			(entry) =>
				entry.method === "Runtime.callFunctionOn" &&
				entry.params.functionDeclaration === SET_CHECKED_VALUE_FUNCTION,
		);
		expect(call?.params.arguments).toEqual([{ value: true }]);
	});

	test("never unchecks a checkbox for a candidate that names no state", async () => {
		const { driver, connection } = await observedElementDriver();
		connection.respond = (method, params) =>
			method === "Runtime.callFunctionOn" &&
			params.functionDeclaration === MATCHES_CHOICE_CANDIDATE_FUNCTION
				? { result: { value: false } }
				: scriptedCdpResponse(method, params);

		await expect(
			driver.select(CHECKBOX_ELEMENT_ID, ["いいえ"]),
		).rejects.toBeInstanceOf(BrowserElementError);
		expect(
			connection.sent.some(
				(entry) =>
					entry.method === "Runtime.callFunctionOn" &&
					entry.params.functionDeclaration === SET_CHECKED_VALUE_FUNCTION,
			),
		).toBe(false);
	});

	test("rejects an empty candidate list before it touches the page", async () => {
		const { driver } = await observedElementDriver();

		await expect(driver.select(SELECT_ELEMENT_ID, [])).rejects.toBeInstanceOf(
			BrowserElementError,
		);
	});

	test("accepts only the three radio outcomes the page may report", () => {
		expect(readRadioSelectionOutcome("selected")).toBe("selected");
		expect(readRadioSelectionOutcome("not_candidate")).toBe("not_candidate");
		expect(readRadioSelectionOutcome("higher_priority_exists")).toBe(
			"higher_priority_exists",
		);
		expect(() => readRadioSelectionOutcome("メール")).toThrow(
			BrowserElementError,
		);
		expect(() => readRadioSelectionOutcome(true)).toThrow(BrowserElementError);
	});

	test("reads the intended checkbox state from the first candidate that names one", () => {
		expect(desiredCheckboxState(["checked"])).toBe(true);
		expect(desiredCheckboxState(["false"])).toBe(false);
		expect(desiredCheckboxState(["unchecked", "checked"])).toBe(false);
		expect(desiredCheckboxState(["同意する"])).toBeUndefined();
	});
});

describe("bootstrap navigation readiness", () => {
	/** Replies to `document.readyState` and lets a test spend the deadline. */
	function readyStateConnection(
		reply: (call: number) => string,
	): ScriptedCdpConnection {
		const connection = new ScriptedCdpConnection();
		let calls = 0;
		connection.respond = (method, params) => {
			if (
				method === "Runtime.evaluate" &&
				params.expression === "document.readyState"
			) {
				calls += 1;
				return { result: { value: reply(calls) } };
			}
			return scriptedCdpResponse(method, params);
		};
		return connection;
	}

	/** Spends the whole readyState deadline without waiting it out for real. */
	function spendDeadline(): void {
		setSystemTime(new Date(Date.now() + 60_000));
	}

	test("navigates again once when the first bootstrap attempt is not ready", async () => {
		const connection = readyStateConnection((call) => {
			if (call === 1) {
				spendDeadline();
				return "loading";
			}
			return "complete";
		});
		const driver = await scriptedDriver(connection);
		const captured = captureLogs();

		try {
			await driver.navigate(ELEMENT_PAGE_URL);
		} finally {
			captured.restore();
			setSystemTime();
		}

		expect(countSent(connection, "Page.navigate")).toBe(2);
		expect(logEvents(captured.logs)).toEqual([
			{ event: "browser_bootstrap_navigate_retried" },
		]);
		// The retry stays inside the single navigation a dry-run allows.
		await expect(driver.navigate(ELEMENT_PAGE_URL)).rejects.toBeInstanceOf(
			BrowserElementError,
		);
	});

	test("reports PAGE_NOT_READY when both bootstrap attempts run out", async () => {
		const connection = readyStateConnection(() => {
			spendDeadline();
			return "loading";
		});
		const driver = await scriptedDriver(connection);
		const captured = captureLogs();

		let caught: unknown;
		try {
			await driver.navigate(ELEMENT_PAGE_URL).catch((error: unknown) => {
				caught = error;
			});
		} finally {
			captured.restore();
			setSystemTime();
		}

		expect((caught as Error).message).toBe("Browser page did not become ready");
		expect(countSent(connection, "Page.navigate")).toBe(2);
	});

	test("does not retry a navigation the model asked for", async () => {
		const connection = readyStateConnection((call) => {
			if (call === 1) return "complete";
			spendDeadline();
			return "loading";
		});
		const driver = await scriptedDriver(connection, false);
		const captured = captureLogs();

		let caught: unknown;
		try {
			await driver.navigate(ELEMENT_PAGE_URL);
			await driver.navigate(ELEMENT_PAGE_URL).catch((error: unknown) => {
				caught = error;
			});
		} finally {
			captured.restore();
			setSystemTime();
		}

		expect((caught as Error).message).toBe("Browser page did not become ready");
		expect(countSent(connection, "Page.navigate")).toBe(2);
	});

	test("leaves the readiness wait as soon as the connection is gone", async () => {
		const connection = new ScriptedCdpConnection();
		const driver = await scriptedDriver(connection);
		connection.fail = (method, params) =>
			method === "Runtime.evaluate" &&
			params.expression === "document.readyState"
				? new Error("Browser Use CDP connection is closed")
				: null;

		const caught = await driver
			.navigate(ELEMENT_PAGE_URL)
			.catch((error: unknown) => error);

		expect((caught as Error).message).toBe(
			"Browser Use CDP connection is closed",
		);
		expect(countSent(connection, "Page.navigate")).toBe(1);
	});

	test("does not navigate again over a connection that is already closed", async () => {
		const connection = readyStateConnection(() => {
			spendDeadline();
			connection.closed = true;
			return "loading";
		});
		const driver = await scriptedDriver(connection);

		let caught: unknown;
		try {
			await driver.navigate(ELEMENT_PAGE_URL).catch((error: unknown) => {
				caught = error;
			});
		} finally {
			setSystemTime();
		}

		expect((caught as Error).message).toBe("Browser page did not become ready");
		expect(countSent(connection, "Page.navigate")).toBe(1);
	});
});

describe("BrowserUseCdpDriver verification provider requests", () => {
	test("continues a reCAPTCHA request, blocks other hosts and counts the run", async () => {
		const connection = new ScriptedCdpConnection();
		const driver = await scriptedDriver(connection);

		connection.emit("Fetch.requestPaused", {
			requestId: "verify-1",
			resourceType: "XHR",
			frameId: "frame-1",
			request: {
				url: "https://www.google.com/recaptcha/api2/reload?k=key",
				method: "POST",
			},
		});
		connection.emit("Fetch.requestPaused", {
			requestId: "other-1",
			resourceType: "XHR",
			frameId: "frame-1",
			request: { url: "https://analytics.example/collect", method: "POST" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			connection.sent.filter(
				(entry) => entry.method === "Fetch.continueRequest",
			),
		).toEqual([
			{ method: "Fetch.continueRequest", params: { requestId: "verify-1" } },
		]);
		expect(
			connection.sent.filter((entry) => entry.method === "Fetch.failRequest"),
		).toEqual([
			{
				method: "Fetch.failRequest",
				params: { requestId: "other-1", errorReason: "BlockedByClient" },
			},
		]);

		const captured = captureLogs();
		try {
			await driver.close();
		} finally {
			captured.restore();
		}
		expect(logEvents(captured.logs)).toContainEqual({
			event: "browser_verification_requests",
			count: 1,
		});
	});

	test("continues the widget iframe document only below the top frame", async () => {
		const connection = new ScriptedCdpConnection();
		const driver = await scriptedDriver(connection);
		const anchor = "https://www.google.com/recaptcha/api2/anchor?k=key";

		connection.emit("Fetch.requestPaused", {
			requestId: "widget-frame",
			resourceType: "Document",
			frameId: "frame-2",
			request: { url: anchor, method: "GET" },
		});
		connection.emit("Fetch.requestPaused", {
			requestId: "top-frame",
			resourceType: "Document",
			frameId: "frame-1",
			request: { url: anchor, method: "GET" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			connection.sent.filter(
				(entry) => entry.method === "Fetch.continueRequest",
			),
		).toEqual([
			{
				method: "Fetch.continueRequest",
				params: { requestId: "widget-frame" },
			},
		]);
		expect(
			connection.sent.filter((entry) => entry.method === "Fetch.failRequest"),
		).toEqual([
			{
				method: "Fetch.failRequest",
				params: { requestId: "top-frame", errorReason: "BlockedByClient" },
			},
		]);

		const captured = captureLogs();
		try {
			await driver.close();
		} finally {
			captured.restore();
		}
	});

	test("counts the kept widget iframe and the requests it made", async () => {
		const connection = new ScriptedCdpConnection();
		const driver = await scriptedDriver(connection);

		connection.emit(
			"Target.attachedToTarget",
			{
				sessionId: "widget-session",
				targetInfo: {
					targetId: "widget-1",
					type: "iframe",
					url: "https://www.google.com/recaptcha/api2/anchor?k=key",
				},
				waitingForDebugger: true,
			},
			"session-1",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		connection.emit(
			"Fetch.requestPaused",
			{
				requestId: "widget-reload",
				resourceType: "XHR",
				request: {
					url: "https://www.google.com/recaptcha/api2/reload?k=key",
					method: "POST",
				},
			},
			"widget-session",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(countSent(connection, "Target.closeTarget")).toBe(0);
		const captured = captureLogs();
		try {
			await driver.close();
		} finally {
			captured.restore();
		}
		const events = logEvents(captured.logs);
		expect(events).toContainEqual({
			event: "browser_verification_frames",
			count: 1,
		});
		expect(events).toContainEqual({
			event: "browser_verification_requests",
			count: 1,
		});
	});

	test("never claims a verification provider host as the submission request", () => {
		expect(
			getSubmissionRequestDisposition(
				{ url: "https://www.google.com/recaptcha/api2/reload", method: "GET" },
				"XHR",
				"frame-1",
				{ url: "https://www.google.com/recaptcha/api2/reload", method: "GET" },
				"frame-1",
				true,
				true,
				0,
				false,
			),
		).toBe("ignore");
	});
});

const FRAMED_TARGET_DOMAIN = "example.co.jp";
const FRAMED_PAGE_URL = "https://example.co.jp/contact";
const FRAMED_FORM_ACTION = "https://example.co.jp/send";
const FRAMED_WIDGET_ACTION = "https://forms.example.co.jp/widget";
const THIRD_PARTY_FRAME_URL = "https://www.google.com/recaptcha/api2/anchor";

/** A page with one form of its own and one form inside a child frame. */
const FRAMED_PAGE_DOCUMENT = {
	backendNodeId: 1,
	nodeName: "#document",
	children: [
		{
			backendNodeId: 2,
			nodeName: "FORM",
			attributes: ["action", "/send", "method", "post"],
			children: [{ backendNodeId: 3, nodeName: "INPUT" }],
		},
		{
			backendNodeId: 20,
			nodeName: "IFRAME",
			frameId: "frame-2",
			children: [],
			contentDocument: {
				backendNodeId: 21,
				nodeName: "#document",
				frameId: "frame-2",
				children: [
					{
						backendNodeId: 22,
						nodeName: "FORM",
						attributes: ["action", FRAMED_WIDGET_ACTION, "method", "post"],
						children: [{ backendNodeId: 30, nodeName: "INPUT" }],
					},
				],
			},
		},
	],
};

/**
 * Answers the framed fixture page, reporting the child frame URL the frame
 * tree carries. The URL is omitted when the driver should not know it.
 */
function framedCdpConnection(childFrameUrl?: string): ScriptedCdpConnection {
	const connection = new ScriptedCdpConnection();
	connection.respond = (method, params) => {
		if (method === "Page.getFrameTree") {
			return {
				frameTree: {
					frame: { id: "frame-1", url: FRAMED_PAGE_URL },
					childFrames: [
						{
							frame: {
								id: "frame-2",
								parentId: "frame-1",
								...(childFrameUrl === undefined ? {} : { url: childFrameUrl }),
							},
						},
					],
				},
			};
		}
		if (method === "DOM.getDocument") return { root: FRAMED_PAGE_DOCUMENT };
		if (
			method === "Runtime.evaluate" &&
			String(params.expression ?? "") === "location.href"
		) {
			return { result: { value: FRAMED_PAGE_URL } };
		}
		return scriptedCdpResponse(method, params);
	};
	return connection;
}

async function observeFramedPage(connection: ScriptedCdpConnection): Promise<{
	actions: string[];
	logs: string[];
}> {
	const driver = await scriptedDriver(connection, true, FRAMED_TARGET_DOMAIN);
	const captured = captureLogs();
	try {
		const observation = await driver.observe();
		return {
			actions: observation.forms.map((form) => form.action),
			logs: captured.logs,
		};
	} finally {
		captured.restore();
	}
}

function framedObservationLog(logs: readonly string[]): unknown {
	return logEvents(logs).find(
		(entry) =>
			(entry as { event?: string }).event === "browser_dom_observation",
	);
}

describe("BrowserUseCdpDriver third-party frame forms", () => {
	test("leaves a form inside a third-party frame out of the observation", async () => {
		const connection = framedCdpConnection(THIRD_PARTY_FRAME_URL);

		const { actions, logs } = await observeFramedPage(connection);

		expect(actions).toEqual([FRAMED_FORM_ACTION]);
		expect(framedObservationLog(logs)).toMatchObject({
			skippedThirdPartyForms: 1,
			observedFieldCount: 1,
		});
		expect(
			countSent(
				connection,
				"Page.createIsolatedWorld",
				(params) => params.frameId === "frame-2",
			),
		).toBe(0);
	});

	test("keeps a form inside a frame on the target domain", async () => {
		const connection = framedCdpConnection(FRAMED_WIDGET_ACTION);

		const { actions, logs } = await observeFramedPage(connection);

		expect(actions).toEqual([FRAMED_FORM_ACTION, FRAMED_WIDGET_ACTION]);
		expect(framedObservationLog(logs)).toMatchObject({
			skippedThirdPartyForms: 0,
			observedFieldCount: 2,
		});
	});

	test("skips only the form whose frame context a CDP failure withheld", async () => {
		const connection = framedCdpConnection();
		connection.fail = (method, params) =>
			method === "Page.createIsolatedWorld" && params.frameId === "frame-2"
				? cdpCommandError("Page.createIsolatedWorld", "OTHER")
				: null;

		const { actions, logs } = await observeFramedPage(connection);

		expect(actions).toEqual([FRAMED_FORM_ACTION]);
		expect(
			logEvents(logs).filter(
				(entry) =>
					(entry as { event?: string }).event === "browser_form_skipped",
			),
		).toEqual([
			{ event: "browser_form_skipped", reason: "FRAME_CONTEXT_UNAVAILABLE" },
		]);
		expect(framedObservationLog(logs)).toMatchObject({
			skippedThirdPartyForms: 0,
			observedFieldCount: 1,
		});
	});

	test("still fails the observation when the top frame context is withheld", async () => {
		const connection = framedCdpConnection(FRAMED_WIDGET_ACTION);
		connection.fail = (method, params) =>
			method === "Page.createIsolatedWorld" && params.frameId === "frame-1"
				? cdpCommandError("Page.createIsolatedWorld", "OTHER")
				: null;
		const driver = await scriptedDriver(connection, true, FRAMED_TARGET_DOMAIN);
		const captured = captureLogs();

		let caught: unknown;
		try {
			await driver.observe();
		} catch (error) {
			caught = error;
		} finally {
			captured.restore();
		}

		expect(caught).toBeInstanceOf(BrowserUseCdpCommandError);
	});
});

/**
 * `example.com` is a special-use name the navigation policy always refuses, so
 * the submission tests need a domain a real job could carry.
 */
const SUBMISSION_TARGET_DOMAIN = "acme.co.jp";
const SUBMISSION_PAGE_URL = `https://${SUBMISSION_TARGET_DOMAIN}/contact`;

describe("BrowserUseCdpDriver submission network policy", () => {
	test("continues a same-domain post to another path and counts it as observed", async () => {
		const { driver, connection } = await submissionDriver([
			{
				requestId: "wp-json-1",
				resourceType: "XHR",
				frameId: "frame-1",
				request: {
					url: "https://acme.co.jp/wp-json/contact-form-7/v1/feedback",
					method: "POST",
				},
			},
		]);

		const result = await submitFixtureForm(driver);

		expect(continuedRequestIds(connection)).toEqual(["wp-json-1"]);
		expect(failedRequestIds(connection)).toEqual([]);
		// The request was seen, so the only thing missing is the confirmation.
		expect(result).toEqual({
			outcome: "uncertain",
			reasonCode: "SUBMIT_CONFIRMATION_NOT_OBSERVED",
			reason: "The page did not provide a reliable submission confirmation.",
		});
		await closeQuietly(driver);
	});

	test("blocks a submission request that leaves the target domain", async () => {
		const { driver, connection } = await submissionDriver([
			{
				requestId: "offsite-1",
				resourceType: "XHR",
				frameId: "frame-1",
				request: { url: "https://forms.other.test/collect", method: "POST" },
			},
		]);

		const result = await submitFixtureForm(driver);

		expect(continuedRequestIds(connection)).toEqual([]);
		expect(failedRequestIds(connection)).toEqual(["offsite-1"]);
		expect(result).toMatchObject({
			outcome: "uncertain",
			reasonCode: "SUBMIT_NETWORK_POLICY_BLOCKED",
		});
		await closeQuietly(driver);
	});

	test("blocks the request past the per-run submission budget", async () => {
		const { driver, connection } = await submissionDriver(
			Array.from({ length: MAX_SUBMISSION_REQUESTS + 1 }, (_, index) => ({
				requestId: `post-${index + 1}`,
				resourceType: "XHR",
				frameId: "frame-1",
				request: {
					url: `https://acme.co.jp/api/step-${index + 1}`,
					method: "POST",
				},
			})),
		);

		const result = await submitFixtureForm(driver);

		expect(continuedRequestIds(connection)).toEqual([
			"post-1",
			"post-2",
			"post-3",
			"post-4",
			"post-5",
		]);
		expect(failedRequestIds(connection)).toEqual(["post-6"]);
		expect(result).toMatchObject({
			outcome: "uncertain",
			reasonCode: "SUBMIT_REQUEST_LIMIT_REACHED",
		});
		await closeQuietly(driver);
	});

	test("keeps blocking every request of a dry-run once the form was touched", async () => {
		const connection = new ScriptedCdpConnection();
		connection.respond = submitFixtureResponse(connection, []);
		const driver = await scriptedDriver(connection, true);
		const captured = captureLogs();
		try {
			await driver.observe();
			await driver.fill(TEXT_ELEMENT_ID, "Hello");
		} finally {
			captured.restore();
		}

		connection.emit("Fetch.requestPaused", {
			requestId: "dry-run-1",
			resourceType: "XHR",
			frameId: "frame-1",
			request: { url: "https://acme.co.jp/send", method: "POST" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(continuedRequestIds(connection)).toEqual([]);
		expect(failedRequestIds(connection)).toEqual(["dry-run-1"]);
		await closeQuietly(driver);
	});
});

const SUBMISSION_BODY_BACKEND_NODE_ID = 8;

/** The fixture page with the body node the confirmation snapshot reads. */
const SUBMISSION_PAGE_DOCUMENT = {
	backendNodeId: 1,
	nodeName: "#document",
	children: [
		{
			backendNodeId: SUBMISSION_BODY_BACKEND_NODE_ID,
			nodeName: "BODY",
			children: ELEMENT_PAGE_DOCUMENT.children,
		},
	],
};

describe("BrowserUseCdpDriver confirmation snapshot", () => {
	test("counts a body the navigation detached as non-matching", async () => {
		const { driver } = await submissionDriver(
			[
				{
					requestId: "post-1",
					resourceType: "XHR",
					frameId: "frame-1",
					request: { url: "https://acme.co.jp/send", method: "POST" },
				},
			],
			(connection) => {
				const scripted = connection.respond;
				connection.respond = (method, params) =>
					method === "DOM.getDocument"
						? { root: SUBMISSION_PAGE_DOCUMENT }
						: scripted(method, params);
				// The body node was rediscovered a moment before the page navigated
				// away from it, so the call on it no longer finds the node.
				connection.fail = (method, params) =>
					method === "Runtime.callFunctionOn" &&
					params.objectId === `object-${SUBMISSION_BODY_BACKEND_NODE_ID}`
						? new BrowserUseCdpCommandError(
								"Runtime.callFunctionOn",
								-32000,
								classifyCdpCommandError("Could not find node with given id"),
							)
						: null;
			},
		);
		const captured = captureLogs();
		let result: BrowserSubmitResult;
		try {
			result = await driver.submit(BUTTON_ELEMENT_ID, "dom");
		} finally {
			captured.restore();
		}

		expect(
			logEvents(captured.logs).filter(
				(entry) =>
					(entry as { event?: string }).event ===
					"browser_confirmation_snapshot",
			)[0],
		).toEqual({
			event: "browser_confirmation_snapshot",
			bodyCount: 1,
			matchingBodyCount: 0,
			staleBodyCount: 1,
			frameScoped: false,
		});
		expect(result).toMatchObject({
			outcome: "uncertain",
			reasonCode: "SUBMIT_CONFIRMATION_NOT_OBSERVED",
		});
		await closeQuietly(driver);
	});
});

/**
 * A driver on the fixture page whose submit control is a real submit button,
 * with one filled field, ready for `submit`. The paused requests are delivered
 * while the submission is being activated, which is the only window in which
 * the page may send anything.
 */
async function submissionDriver(
	pausedRequests: readonly Record<string, unknown>[],
	prepare?: (connection: ScriptedCdpConnection) => void,
): Promise<{ driver: BrowserUseCdpDriver; connection: ScriptedCdpConnection }> {
	const connection = new ScriptedCdpConnection();
	connection.respond = submitFixtureResponse(connection, pausedRequests);
	prepare?.(connection);
	const captured = captureLogs();
	try {
		const driver = await BrowserUseCdpDriver.connect(
			"api-key",
			connectJob,
			false,
			{
				client: asClient(new FakeBrowserUseClient()),
				connectConnection: async () =>
					connection as unknown as BrowserUseCdpConnection,
				submissionConfirmationTimeoutMs: 20,
			},
		);
		await driver.restrictToDomain(SUBMISSION_TARGET_DOMAIN, []);
		await driver.observe();
		await driver.fill(TEXT_ELEMENT_ID, "Hello");
		return { driver, connection };
	} finally {
		captured.restore();
	}
}

async function submitFixtureForm(
	driver: BrowserUseCdpDriver,
): Promise<BrowserSubmitResult> {
	const captured = captureLogs();
	try {
		return await driver.submit(BUTTON_ELEMENT_ID, "dom");
	} finally {
		captured.restore();
	}
}

/**
 * Answers like the shared fixture, except that the button is a submit control
 * and the activation call delivers the paused requests the test scripted.
 */
function submitFixtureResponse(
	connection: ScriptedCdpConnection,
	pausedRequests: readonly Record<string, unknown>[],
): (method: string, params: Record<string, unknown>) => unknown {
	return (method, params) => {
		if (
			method === "Runtime.evaluate" &&
			String(params.expression ?? "") === "location.href"
		) {
			return { result: { value: SUBMISSION_PAGE_URL } };
		}
		if (method === "Runtime.callFunctionOn") {
			const declaration = params.functionDeclaration;
			if (declaration === ACTIVATE_SUBMIT_FUNCTION) {
				for (const paused of pausedRequests) {
					connection.emit("Fetch.requestPaused", paused);
				}
				return { result: { value: true } };
			}
			if (
				declaration === HAS_SAME_FORM_OWNER_FUNCTION ||
				declaration === CHECK_FORM_VALIDITY_FUNCTION
			) {
				return { result: { value: true } };
			}
			const backendNodeId = Number(
				String(params.objectId ?? "").replace("object-", ""),
			);
			if (backendNodeId === BUTTON_BACKEND_NODE_ID) {
				return {
					result: {
						value: {
							...elementFixtureState(backendNodeId),
							type: "submit",
							submitLike: true,
							formAction: `https://${SUBMISSION_TARGET_DOMAIN}/send`,
							formMethod: "post",
						},
					},
				};
			}
		}
		return scriptedCdpResponse(method, params);
	};
}

function continuedRequestIds(connection: ScriptedCdpConnection): string[] {
	return connection.sent
		.filter((entry) => entry.method === "Fetch.continueRequest")
		.map((entry) => String(entry.params.requestId));
}

function failedRequestIds(connection: ScriptedCdpConnection): string[] {
	return connection.sent
		.filter((entry) => entry.method === "Fetch.failRequest")
		.map((entry) => String(entry.params.requestId));
}

async function closeQuietly(driver: BrowserUseCdpDriver): Promise<void> {
	const captured = captureLogs();
	try {
		await driver.close();
	} finally {
		captured.restore();
	}
}

describe("submission confirmation text", () => {
	test("does not read a review-before-send screen as a completion", () => {
		expect(
			hasSubmissionConfirmationText(
				"入力内容の確認\nまだ送信は完了していません。内容をご確認のうえ、送信してください。\nこの内容で送信する",
			),
		).toBe(false);
		expect(
			hasSubmissionConfirmationText("確認画面\n送信完了までもう少しです"),
		).toBe(false);
	});

	test("still reads a real completion", () => {
		expect(
			hasSubmissionConfirmationText("お問い合わせの送信が完了しました。"),
		).toBe(true);
		expect(hasSubmissionConfirmationText("Thank you for your inquiry")).toBe(
			true,
		);
		expect(
			hasNewSubmissionConfirmation(
				"お問い合わせフォーム",
				"送信ありがとうございました",
			),
		).toBe(true);
	});
});
