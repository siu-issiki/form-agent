import { describe, expect, test } from "vitest";
import { AgentExecutionError } from "../src/agent-executor";
import { describeToolFailure, type ToolFailure } from "../src/agent-tool-call";
import type { AgentToolDiagnosticCode } from "../src/agent-tool-diagnostic";
import {
	BROWSER_ERROR,
	type BrowserErrorMessage,
} from "../src/browser-error-messages";
import { BrowserToolInputError } from "../src/browser-tool-handler";
import {
	BrowserUseCdpClosedError,
	BrowserUseCdpCommandError,
	BrowserUseCdpPayloadTooLargeError,
	BrowserUseCdpUpgradeRejectedError,
} from "../src/browser-use-cdp";
import {
	BrowserUseApiError,
	BrowserUseRequestError,
	BrowserUseResponseError,
} from "../src/browser-use-client";
import { classifyToolDiagnostic } from "../src/responses-agent-executor";
import {
	BrowserElementError,
	BrowserElementOperationError,
	BrowserFormInvalidError,
	CorrectionRequiredError,
	FormStateChangedError,
	NavigationPolicyError,
	ObservationStaleError,
	ProhibitionEvidenceError,
	SubmissionEvidenceError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
	SubmitProhibitedError,
	SubmitReviewDeniedError,
	SubmitReviewUnavailableError,
	SubmitStageUnverifiedError,
} from "../src/restricted-browser";

// classifyToolDiagnostic (src/responses-agent-executor.ts) has two layers:
// 1. `instanceof` branches for well-typed error classes.
// 2. A fallback `switch` on `error.message` for plain `Error`s thrown with a
//    fixed string, because several call sites (browser-use-cdp.ts,
//    browser-use-cdp-driver.ts, browser-use-client.ts) raise plain `Error`s
//    rather than dedicated classes. Throw sites and classifier share the
//    BROWSER_ERROR constants, and this file pins which of those constants the
//    classifier still recognises.
// This file pins both layers, their priority order, and the fallback, so a
// message drifting out of sync between a throw site and the switch is caught
// here instead of silently degrading to UNKNOWN in production.

/**
 * Every BROWSER_ERROR message the fallback switch classifies, and the code it
 * yields. Referencing the constants by key means a message renamed in only one
 * place no longer compiles here, and the closed-set test below fails when a
 * key is dropped from the switch or newly added to it.
 */
const MESSAGE_TABLE: Array<
	[key: keyof typeof BROWSER_ERROR, code: AgentToolDiagnosticCode]
> = [
	["CDP_CONNECTION_FAILED", "CDP_CONNECTION_FAILED"],
	["CDP_CONNECTION_IS_CLOSED", "CDP_CONNECTION_CLOSED"],
	["CDP_CONNECTION_CLOSED", "CDP_CONNECTION_CLOSED"],
	["CDP_COMMAND_TIMED_OUT", "CDP_COMMAND_TIMEOUT"],
	["CDP_COMMAND_NOT_SENT", "CDP_COMMAND_SEND_FAILED"],
	["CDP_COMMAND_FAILED", "CDP_COMMAND_FAILED"],
	["CDP_ENDPOINT_INVALID", "CDP_ENDPOINT_INVALID"],
	["API_KEY_REQUIRED", "BROWSER_CREDENTIALS_MISSING"],
	["DOMAIN_SCOPE_CANNOT_CHANGE", "SCOPE_CONFIGURATION_FAILED"],
	["HOST_SCOPE_CANNOT_CHANGE", "SCOPE_CONFIGURATION_FAILED"],
	["DOMAIN_SCOPE_NOT_CONFIGURED", "SCOPE_CONFIGURATION_FAILED"],
	["NAVIGATION_FAILED", "NAVIGATION_FAILED"],
	["PAGE_NOT_READY", "PAGE_NOT_READY"],
	["DOM_DISCOVERY_FAILED", "DOM_DISCOVERY_FAILED"],
	["PAGE_EVALUATION_FAILED", "PAGE_EVALUATION_FAILED"],
	["SCREENSHOT_FAILED", "SCREENSHOT_FAILED"],
];

describe("classifyToolDiagnostic - message fallback table", () => {
	test("covers every case in the switch", () => {
		// Guards against someone adding/removing a case in the switch without
		// updating this table.
		expect(MESSAGE_TABLE).toHaveLength(16);
	});

	for (const [key, code] of MESSAGE_TABLE) {
		test(`${key} -> ${code}`, () => {
			expect(classifyToolDiagnostic(new Error(BROWSER_ERROR[key]))).toBe(code);
		});
	}
});

describe("classifyToolDiagnostic - classified BROWSER_ERROR messages", () => {
	test("exactly the table's messages classify as something other than UNKNOWN", () => {
		// The set is fixed rather than derived: a constant that is renamed or
		// deleted at its throw site drops out of this set, and a message that
		// starts being classified has to be added here on purpose.
		const classified = Object.entries(BROWSER_ERROR)
			.filter(
				([, message]) =>
					classifyToolDiagnostic(new Error(message)) !== "UNKNOWN",
			)
			.map(([key]) => key)
			.sort();
		const expected = [...new Set(MESSAGE_TABLE.map(([key]) => key))].sort();
		expect(classified).toEqual(expected);
	});

	test("the remaining messages fall through to UNKNOWN", () => {
		const unclassified: BrowserErrorMessage[] = [
			BROWSER_ERROR.CDP_CONNECTION_ABORTED,
			BROWSER_ERROR.CDP_PAYLOAD_TOO_LARGE,
			BROWSER_ERROR.API_REQUEST_FAILED,
			BROWSER_ERROR.SESSION_ID_REQUIRED,
			BROWSER_ERROR.SESSION_WITHOUT_CDP_URL,
		];
		for (const message of unclassified) {
			expect(classifyToolDiagnostic(new Error(message))).toBe("UNKNOWN");
		}
	});
});

describe("classifyToolDiagnostic - instanceof table", () => {
	const cases: Array<
		[label: string, error: unknown, code: AgentToolDiagnosticCode]
	> = [
		[
			"SubmitReviewDeniedError",
			new SubmitReviewDeniedError("WRONG_FORM"),
			"SUBMIT_REVIEW_DENIED",
		],
		[
			"SubmitReviewUnavailableError",
			new SubmitReviewUnavailableError(),
			"SUBMIT_REVIEW_UNAVAILABLE",
		],
		[
			"AgentExecutionError",
			new AgentExecutionError("SOME_REASON", "boom", false),
			"SUBMIT_REVIEW_UNAVAILABLE",
		],
		[
			"BrowserUseCdpPayloadTooLargeError",
			new BrowserUseCdpPayloadTooLargeError(),
			"PAYLOAD_TOO_LARGE",
		],
		[
			"BrowserUseCdpUpgradeRejectedError",
			new BrowserUseCdpUpgradeRejectedError(503),
			"CDP_UPGRADE_REJECTED",
		],
		[
			"BrowserUseApiError (429)",
			new BrowserUseApiError("create", 429),
			"BROWSER_SESSION_LIMIT",
		],
		[
			"BrowserUseApiError (non-429)",
			new BrowserUseApiError("create", 500),
			"BROWSER_SESSION_API_FAILED",
		],
		[
			"BrowserUseRequestError",
			new BrowserUseRequestError(),
			"BROWSER_SESSION_API_FAILED",
		],
		[
			"BrowserUseResponseError",
			new BrowserUseResponseError("bad response"),
			"BROWSER_SESSION_API_FAILED",
		],
		[
			"BrowserToolInputError",
			new BrowserToolInputError("bad input"),
			"TOOL_INPUT_INVALID",
		],
		["SyntaxError", new SyntaxError("bad json"), "TOOL_INPUT_INVALID"],
		[
			"SubmitStageUnverifiedError",
			new SubmitStageUnverifiedError(),
			"SUBMIT_STAGE_UNVERIFIED",
		],
		[
			"SubmitProhibitedError",
			new SubmitProhibitedError(["SALES_PROHIBITED"], true),
			"SUBMIT_PROHIBITED",
		],
		[
			"BrowserElementOperationError",
			new BrowserElementOperationError("click"),
			"ELEMENT_OPERATION_CDP_FAILED",
		],
		["BrowserFormInvalidError", new BrowserFormInvalidError(), "FORM_INVALID"],
		["BrowserElementError", new BrowserElementError(), "ELEMENT_UNAVAILABLE"],
		["NavigationPolicyError", new NavigationPolicyError(), "NAVIGATION_POLICY"],
		[
			"SubmissionNotAuthorizedError",
			new SubmissionNotAuthorizedError(),
			"SUBMISSION_NOT_AUTHORIZED",
		],
		[
			"SubmissionResultUncertainError",
			new SubmissionResultUncertainError(),
			"SUBMISSION_RESULT_UNCERTAIN",
		],
		[
			"SubmissionEvidenceError",
			new SubmissionEvidenceError(),
			"EVIDENCE_CAPTURE_FAILED",
		],
	];

	for (const [label, error, code] of cases) {
		test(`${label} -> ${code}`, () => {
			expect(classifyToolDiagnostic(error)).toBe(code);
		});
	}
});

describe("classifyToolDiagnostic - instanceof takes priority over message", () => {
	test("BrowserUseCdpUpgradeRejectedError shares its message with the CDP_CONNECTION_FAILED case, but classifies by type", () => {
		const error = new BrowserUseCdpUpgradeRejectedError(500);
		// Confirms the fixture actually collides with a switch case; otherwise
		// this test would not be exercising the priority rule at all.
		expect(error.message).toBe(BROWSER_ERROR.CDP_CONNECTION_FAILED);
		expect(classifyToolDiagnostic(error)).toBe("CDP_UPGRADE_REJECTED");
	});

	test("BrowserElementError classifies by type even when its message is overwritten to a switch-table string", () => {
		const error = new BrowserElementError();
		error.message = BROWSER_ERROR.CDP_CONNECTION_FAILED;
		expect(classifyToolDiagnostic(error)).toBe("ELEMENT_UNAVAILABLE");
	});

	test("AgentExecutionError is treated the same as SubmitReviewUnavailableError regardless of its own message", () => {
		const error = new AgentExecutionError(
			"REASON",
			BROWSER_ERROR.PAGE_NOT_READY,
			false,
		);
		expect(classifyToolDiagnostic(error)).toBe("SUBMIT_REVIEW_UNAVAILABLE");
	});
});

describe("classifyToolDiagnostic - fallback", () => {
	test("non-Error value", () => {
		expect(classifyToolDiagnostic("not an error")).toBe("UNKNOWN");
	});

	test("null", () => {
		expect(classifyToolDiagnostic(null)).toBe("UNKNOWN");
	});

	test("Error with an unrecognized message", () => {
		expect(classifyToolDiagnostic(new Error("something else"))).toBe("UNKNOWN");
	});
});

// A "does every switch-table message still appear verbatim in src/" check
// (reading src/*.ts with node:fs and grepping for each quoted literal) was
// attempted here and dropped, because this file runs under the Cloudflare
// Workers vitest pool, whose sandbox cannot read the project filesystem.
// The throw-site strings now live in BROWSER_ERROR, so that check is replaced
// by the two tests above: the table keys the constants by name, and the
// closed-set test pins which of them the classifier still recognises. A
// constant renamed or removed at its throw site therefore fails here instead
// of silently degrading to UNKNOWN in production.

// describeToolFailure (src/responses-agent-executor.ts) decides what a failed
// tool call becomes, from the error alone: the diagnostic code that is written
// to D1, and one of five dispositions the caller carries out. Before this
// function existed the two decisions were made by separate `instanceof`
// chains, so an error type could be added to one and forgotten in the other
// without a type error. The table below is the contract for both halves at
// once: every row states the code AND the disposition for one error, so a
// branch that is removed, reordered behind a superclass, or given a new
// disposition fails here rather than in an executor test that only covers the
// handful of errors its fixtures happen to raise.
describe("describeToolFailure - error to disposition table", () => {
	const cases: Array<[label: string, error: unknown, failure: ToolFailure]> = [
		[
			"AgentExecutionError is re-raised so the reviewer's own failure survives",
			new AgentExecutionError("SOME_REASON", "boom", false),
			{ diagnosticCode: "SUBMIT_REVIEW_UNAVAILABLE", disposition: "rethrow" },
		],
		[
			"SubmitReviewDeniedError buys a correction turn",
			new SubmitReviewDeniedError("WRONG_FORM"),
			{
				diagnosticCode: "SUBMIT_REVIEW_DENIED",
				disposition: "soft",
				errorCode: "SUBMIT_REVIEW_DENIED",
				details: { reasonCode: "WRONG_FORM" },
				reviewDenied: true,
			},
		],
		[
			"SubmitReviewUnavailableError",
			new SubmitReviewUnavailableError(),
			{
				diagnosticCode: "SUBMIT_REVIEW_UNAVAILABLE",
				disposition: "hard",
				reasonCode: "SUBMIT_REVIEW_UNAVAILABLE",
				message: "The pre-submit review could not be completed.",
				retryable: true,
			},
		],
		[
			"SubmissionEvidenceError",
			new SubmissionEvidenceError(),
			{
				diagnosticCode: "EVIDENCE_CAPTURE_FAILED",
				disposition: "hard",
				reasonCode: "SUBMISSION_EVIDENCE_UNAVAILABLE",
				message:
					"The submission evidence could not be captured before submission.",
				retryable: true,
			},
		],
		[
			"BrowserUseCdpPayloadTooLargeError is not retryable",
			new BrowserUseCdpPayloadTooLargeError(),
			{
				diagnosticCode: "PAYLOAD_TOO_LARGE",
				disposition: "hard",
				reasonCode: "BROWSER_PAYLOAD_TOO_LARGE",
				message: "The browser document exceeded the safe processing limit.",
				retryable: false,
			},
		],
		[
			"SubmissionResultUncertainError re-reads the job",
			new SubmissionResultUncertainError(),
			{
				diagnosticCode: "SUBMISSION_RESULT_UNCERTAIN",
				disposition: "persisted",
			},
		],
		[
			"SubmissionNotAuthorizedError re-reads the job",
			new SubmissionNotAuthorizedError(),
			{
				diagnosticCode: "SUBMISSION_NOT_AUTHORIZED",
				disposition: "persisted",
			},
		],
		[
			"NavigationPolicyError",
			new NavigationPolicyError(),
			{
				diagnosticCode: "NAVIGATION_POLICY",
				disposition: "soft",
				errorCode: "NAVIGATION_NOT_ALLOWED",
			},
		],
		[
			"CorrectionRequiredError keeps its own tool error under a shared code",
			new CorrectionRequiredError(),
			{
				diagnosticCode: "ELEMENT_UNAVAILABLE",
				disposition: "soft",
				errorCode: "CORRECTION_REQUIRED",
			},
		],
		[
			"FormStateChangedError keeps its own tool error under a shared code",
			new FormStateChangedError(),
			{
				diagnosticCode: "ELEMENT_UNAVAILABLE",
				disposition: "soft",
				errorCode: "FORM_STATE_CHANGED",
			},
		],
		[
			"ObservationStaleError keeps its own tool error under a shared code",
			new ObservationStaleError(),
			{
				diagnosticCode: "ELEMENT_UNAVAILABLE",
				disposition: "soft",
				errorCode: "OBSERVATION_STALE",
			},
		],
		[
			"SubmitStageUnverifiedError",
			new SubmitStageUnverifiedError(),
			{
				diagnosticCode: "SUBMIT_STAGE_UNVERIFIED",
				disposition: "soft",
				errorCode: "SUBMIT_STAGE_UNVERIFIED",
			},
		],
		[
			"SubmitProhibitedError carries the reason codes back to the model",
			new SubmitProhibitedError(["SALES_PROHIBITED"], true),
			{
				diagnosticCode: "SUBMIT_PROHIBITED",
				disposition: "soft",
				errorCode: "SUBMIT_PROHIBITED",
				details: {
					prohibitedReasonCodes: ["SALES_PROHIBITED"],
					pageProhibited: true,
				},
			},
		],
		[
			"BrowserElementOperationError is diagnosed apart from its superclass but disposed of with it",
			new BrowserElementOperationError("click"),
			{
				diagnosticCode: "ELEMENT_OPERATION_CDP_FAILED",
				disposition: "soft",
				errorCode: "ELEMENT_UNAVAILABLE",
			},
		],
		[
			"BrowserFormInvalidError",
			new BrowserFormInvalidError(),
			{
				diagnosticCode: "FORM_INVALID",
				disposition: "soft",
				errorCode: "FORM_INVALID",
			},
		],
		[
			"ProhibitionEvidenceError falls back to its superclass",
			new ProhibitionEvidenceError("PROHIBITION_EVIDENCE_NOT_FOUND"),
			{
				diagnosticCode: "ELEMENT_UNAVAILABLE",
				disposition: "soft",
				errorCode: "ELEMENT_UNAVAILABLE",
			},
		],
		[
			"BrowserElementError",
			new BrowserElementError(),
			{
				diagnosticCode: "ELEMENT_UNAVAILABLE",
				disposition: "soft",
				errorCode: "ELEMENT_UNAVAILABLE",
			},
		],
		[
			"BrowserToolInputError",
			new BrowserToolInputError("bad input"),
			{
				diagnosticCode: "TOOL_INPUT_INVALID",
				disposition: "soft",
				errorCode: "INVALID_TOOL_INPUT",
			},
		],
		[
			"SyntaxError",
			new SyntaxError("bad json"),
			{
				diagnosticCode: "TOOL_INPUT_INVALID",
				disposition: "soft",
				errorCode: "INVALID_TOOL_INPUT",
			},
		],
		[
			"BrowserUseCdpUpgradeRejectedError (403, not retryable) ends the run",
			new BrowserUseCdpUpgradeRejectedError(403),
			{
				diagnosticCode: "CDP_UPGRADE_REJECTED",
				disposition: "hard",
				reasonCode: "BROWSER_UPGRADE_REJECTED",
				message: "The browser provider rejected the connection.",
				retryable: false,
			},
		],
		[
			"BrowserUseCdpUpgradeRejectedError (503, retryable) falls through to the retryable failure",
			new BrowserUseCdpUpgradeRejectedError(503),
			{ diagnosticCode: "CDP_UPGRADE_REJECTED", disposition: "unavailable" },
		],
		[
			"BrowserUseCdpClosedError (1008, not retryable) ends the run",
			new BrowserUseCdpClosedError(1008, "NONE"),
			{
				diagnosticCode: "CDP_CONNECTION_CLOSED",
				disposition: "hard",
				reasonCode: "BROWSER_CONNECTION_REJECTED",
				message: "The browser provider rejected the connection.",
				retryable: false,
			},
		],
		[
			"BrowserUseCdpClosedError (AUTH hint, not retryable) ends the run",
			new BrowserUseCdpClosedError(1006, "AUTH"),
			{
				diagnosticCode: "CDP_CONNECTION_CLOSED",
				disposition: "hard",
				reasonCode: "BROWSER_CONNECTION_REJECTED",
				message: "The browser provider rejected the connection.",
				retryable: false,
			},
		],
		[
			"BrowserUseCdpClosedError (1006, retryable) falls through to the retryable failure",
			new BrowserUseCdpClosedError(1006, "OTHER"),
			{ diagnosticCode: "CDP_CONNECTION_CLOSED", disposition: "unavailable" },
		],
		[
			"BrowserUseApiError (403, not retryable) ends the run",
			new BrowserUseApiError("create", 403),
			{
				diagnosticCode: "BROWSER_SESSION_API_FAILED",
				disposition: "hard",
				reasonCode: "BROWSER_SESSION_REJECTED",
				message: "The browser provider rejected the session request.",
				retryable: false,
			},
		],
		[
			"BrowserUseApiError (429, retryable) keeps the session-limit code and retries",
			new BrowserUseApiError("create", 429),
			{ diagnosticCode: "BROWSER_SESSION_LIMIT", disposition: "unavailable" },
		],
		[
			"BrowserUseApiError (500, retryable)",
			new BrowserUseApiError("create", 500),
			{
				diagnosticCode: "BROWSER_SESSION_API_FAILED",
				disposition: "unavailable",
			},
		],
		[
			"BrowserUseRequestError",
			new BrowserUseRequestError(),
			{
				diagnosticCode: "BROWSER_SESSION_API_FAILED",
				disposition: "unavailable",
			},
		],
		[
			"BrowserUseResponseError",
			new BrowserUseResponseError("bad response"),
			{
				diagnosticCode: "BROWSER_SESSION_API_FAILED",
				disposition: "unavailable",
			},
		],
		[
			"BrowserUseCdpCommandError carries its breakdown into the run failure",
			new BrowserUseCdpCommandError("DOM.focus", -32000, "NODE_NOT_FOUND"),
			{
				diagnosticCode: "CDP_COMMAND_FAILED",
				disposition: "unavailable",
				cdpDetail: {
					method: "DOM.focus",
					kind: "NODE_NOT_FOUND",
					cdpCode: -32000,
				},
			},
		],
		[
			"BrowserUseCdpCommandError without a CDP code omits the field",
			new BrowserUseCdpCommandError("DOM.focus", null, "OTHER"),
			{
				diagnosticCode: "CDP_COMMAND_FAILED",
				disposition: "unavailable",
				cdpDetail: { method: "DOM.focus", kind: "OTHER" },
			},
		],
		[
			"an unrecognised Error",
			new Error("something else"),
			{ diagnosticCode: "UNKNOWN", disposition: "unavailable" },
		],
		[
			"a non-Error value",
			"not an error",
			{ diagnosticCode: "UNKNOWN", disposition: "unavailable" },
		],
	];

	for (const [label, error, failure] of cases) {
		test(label, () => {
			expect(describeToolFailure(error)).toEqual(failure);
		});
	}

	test("the diagnostic code always agrees with classifyToolDiagnostic", () => {
		// The two used to be independent chains. Pinning the equality here means
		// the wrapper cannot drift back apart without failing.
		for (const [, error, failure] of cases) {
			expect(classifyToolDiagnostic(error)).toBe(failure.diagnosticCode);
		}
	});
});
