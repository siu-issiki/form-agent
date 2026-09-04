import { describe, expect, test } from "vitest";
import { AgentExecutionError } from "../src/agent-executor";
import { BrowserToolInputError } from "../src/browser-tool-handler";
import {
	BrowserUseCdpPayloadTooLargeError,
	BrowserUseCdpUpgradeRejectedError,
} from "../src/browser-use-cdp";
import {
	BrowserUseApiError,
	BrowserUseRequestError,
	BrowserUseResponseError,
} from "../src/browser-use-client";
import type { AgentToolDiagnosticCode } from "../src/d1-job-store";
import { classifyToolDiagnostic } from "../src/responses-agent-executor";
import {
	BrowserElementError,
	BrowserElementOperationError,
	BrowserFormInvalidError,
	NavigationPolicyError,
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
//    rather than dedicated classes and there is no shared message constant.
// This file pins both layers, their priority order, and the fallback, so a
// message string drifting out of sync between a throw site and the switch is
// caught here instead of silently degrading to UNKNOWN in production.

describe("classifyToolDiagnostic - message fallback table", () => {
	const messageTable: Array<[message: string, code: AgentToolDiagnosticCode]> =
		[
			["Browser Use CDP connection failed", "CDP_CONNECTION_FAILED"],
			["Browser Use CDP connection is closed", "CDP_CONNECTION_CLOSED"],
			["Browser Use CDP connection closed", "CDP_CONNECTION_CLOSED"],
			["Browser Use CDP command timed out", "CDP_COMMAND_TIMEOUT"],
			["Browser Use CDP command could not be sent", "CDP_COMMAND_SEND_FAILED"],
			["Browser Use CDP command failed", "CDP_COMMAND_FAILED"],
			["Invalid Browser Use CDP endpoint", "CDP_ENDPOINT_INVALID"],
			["Browser Use API key is required", "BROWSER_CREDENTIALS_MISSING"],
			["Browser domain scope cannot be changed", "SCOPE_CONFIGURATION_FAILED"],
			["Browser host scope cannot be changed", "SCOPE_CONFIGURATION_FAILED"],
			["Browser domain scope is not configured", "SCOPE_CONFIGURATION_FAILED"],
			["Browser navigation failed", "NAVIGATION_FAILED"],
			["Browser page did not become ready", "PAGE_NOT_READY"],
			["Browser DOM discovery failed", "DOM_DISCOVERY_FAILED"],
			["Browser page evaluation failed", "PAGE_EVALUATION_FAILED"],
			["Browser screenshot failed", "SCREENSHOT_FAILED"],
		];

	test("covers every case in the switch", () => {
		// Guards against someone adding/removing a case in the switch without
		// updating this table.
		expect(messageTable).toHaveLength(16);
	});

	for (const [message, code] of messageTable) {
		test(`"${message}" -> ${code}`, () => {
			expect(classifyToolDiagnostic(new Error(message))).toBe(code);
		});
	}
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
		expect(error.message).toBe("Browser Use CDP connection failed");
		expect(classifyToolDiagnostic(error)).toBe("CDP_UPGRADE_REJECTED");
	});

	test("BrowserElementError classifies by type even when its message is overwritten to a switch-table string", () => {
		const error = new BrowserElementError();
		error.message = "Browser Use CDP connection failed";
		expect(classifyToolDiagnostic(error)).toBe("ELEMENT_UNAVAILABLE");
	});

	test("AgentExecutionError is treated the same as SubmitReviewUnavailableError regardless of its own message", () => {
		const error = new AgentExecutionError(
			"REASON",
			"Browser page did not become ready",
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
// attempted here and dropped. It ran fine under `bun test`, but this file
// runs under the Cloudflare Workers vitest pool, whose sandbox has no access
// to the real project filesystem: `readdirSync(...)` on the repo's src/
// directory fails with "no such file or directory, readdir ... /src" even
// though nodejs_compat makes `node:fs` importable. Re-adding this check would
// need the messages to come from an in-repo constant/import instead of a
// filesystem walk - worth revisiting once the throw-site strings are
// centralized (see the message-fallback table above for the full list this
// would have covered).
