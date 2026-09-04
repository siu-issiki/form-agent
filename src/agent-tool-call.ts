import { AgentExecutionError } from "./agent-executor";
import type { AgentRunResult } from "./agent-runtime";
import type {
	AgentToolDiagnosticCode,
	AgentToolDiagnosticStage,
	AgentToolDiagnosticToolName,
} from "./agent-tool-diagnostic";
import {
	TOOL_ERROR_GUIDANCE,
	UNCERTAIN_REASON_CODES,
} from "./agent-tool-schema";
import { BROWSER_ERROR } from "./browser-error-messages";
import {
	type BrowserToolCoordinator,
	BrowserToolInputError,
	type BrowserToolName,
	BrowserToolSetupError,
} from "./browser-tool-handler";
import {
	BrowserUseCdpClosedError,
	BrowserUseCdpCommandError,
	BrowserUseCdpPayloadTooLargeError,
	BrowserUseCdpUpgradeRejectedError,
} from "./browser-use-cdp";
import {
	BrowserUseApiError,
	BrowserUseRequestError,
	BrowserUseResponseError,
} from "./browser-use-client";
import { D1JobStore } from "./d1-job-store";
import {
	isProhibitedReasonCode,
	MAX_PROHIBITION_EVIDENCE_LENGTH,
	MIN_PROHIBITION_EVIDENCE_LENGTH,
	type ProhibitedReasonCode,
} from "./form-prohibition";
import type { Job } from "./job";
import { isRecord } from "./json-record";
import { type JsonObject, throwIfAborted } from "./openai-responses-client";
import {
	assertAllowedTargetUrl,
	BrowserElementError,
	BrowserElementOperationError,
	BrowserFormInvalidError,
	type BrowserObservation,
	CorrectionRequiredError,
	FormStateChangedError,
	NavigationPolicyError,
	ObservationStaleError,
	ProhibitionEvidenceError,
	SubmissionEvidenceError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
	type SubmitActivationStrategy,
	SubmitProhibitedError,
	SubmitReviewDeniedError,
	SubmitReviewUnavailableError,
	SubmitStageUnverifiedError,
} from "./restricted-browser";
import {
	ELEMENT_ID_PATTERN,
	SUBMIT_ACTIVATION_STRATEGIES,
} from "./tool-input-patterns";

export interface FunctionCall {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
}

/**
 * What one tool call produced. The four states are exclusive, so the run loop
 * reads one `kind` instead of guessing from which optional fields are set.
 *
 * `review_denied` is a `kind` of its own rather than a flag on `error` because
 * it is the only failure that buys the model a correction turn; it still
 * carries an `errorCode` so it is logged like any other tool error.
 */
export type ToolExecution =
	| { kind: "finished"; output: string; result: AgentRunResult }
	| { kind: "review_denied"; output: string; errorCode: ToolErrorCode }
	| { kind: "succeeded"; output: string; tool: BrowserToolName }
	| { kind: "error"; output: string; errorCode: ToolErrorCode };

/**
 * Everything one tool call is executed against. The handlers take this single
 * value so that adding a dependency does not thread another positional
 * argument through every one of them.
 */
export interface ToolCallContext {
	readonly coordinator: BrowserToolCoordinator;
	readonly job: Job;
	readonly runToken: string;
	readonly signal: AbortSignal;
	readonly db: D1Database;
	readonly dryRun: boolean;
	readonly turn: number;
	readonly allowedToolNames: readonly string[];
	/**
	 * `recordToolDiagnostic` with the run's identity already applied, so each
	 * call site names only what it is reporting.
	 */
	readonly recordDiagnostic: (
		toolName: AgentToolDiagnosticToolName,
		stage: AgentToolDiagnosticStage,
		code: AgentToolDiagnosticCode,
	) => Promise<void>;
}

export function createToolCallContext(
	run: Omit<ToolCallContext, "recordDiagnostic">,
): ToolCallContext {
	return {
		...run,
		recordDiagnostic: (toolName, stage, code) =>
			recordToolDiagnostic(
				run.db,
				run.job,
				run.runToken,
				run.turn,
				toolName,
				stage,
				code,
			),
	};
}

/**
 * Validates the call, dispatches it, and turns whatever comes back -- a
 * result, a tool error, or a thrown failure -- into one `ToolExecution`.
 */
export async function executeToolCall(
	call: FunctionCall,
	context: ToolCallContext,
): Promise<ToolExecution> {
	throwIfAborted(context.signal);
	const parsed = await parseToolCall(call, context);
	if (parsed.execution) return parsed.execution;
	const params = parsed.params;

	if (isFinishToolName(call.name)) {
		return await handleFinishCall(call.name, params, context);
	}
	if (
		call.name === "submit" &&
		context.dryRun &&
		(!isElementId(params.elementId) ||
			!isSubmitActivationStrategy(params.activationStrategy))
	) {
		await context.recordDiagnostic(
			"submit",
			"input_parse",
			"INVALID_TOOL_INPUT",
		);
		return toolError("INVALID_TOOL_INPUT");
	}

	const tool = browserToolName(call.name);
	if (!tool) {
		await context.recordDiagnostic("unknown", "tool_dispatch", "UNKNOWN_TOOL");
		return toolError("UNKNOWN_TOOL");
	}
	try {
		if (tool === "submit" && context.dryRun) {
			return await handleDryRunSubmit(params, context);
		}
		return await runBrowserTool(tool, params, context);
	} catch (error) {
		throwIfAborted(context.signal);
		return await disposeToolFailure(error, tool, context);
	}
}

type ParsedToolCall =
	| { params: JsonObject; execution?: undefined }
	| { params?: undefined; execution: ToolExecution };

/** Rejects a tool the turn did not offer, and arguments that are not an object. */
async function parseToolCall(
	call: FunctionCall,
	context: ToolCallContext,
): Promise<ParsedToolCall> {
	if (!context.allowedToolNames.includes(call.name)) {
		await context.recordDiagnostic("unknown", "tool_dispatch", "UNKNOWN_TOOL");
		return { execution: toolError("UNKNOWN_TOOL") };
	}
	try {
		const value: unknown = JSON.parse(call.arguments);
		if (!isRecord(value)) throw new SyntaxError();
		return { params: value };
	} catch {
		await context.recordDiagnostic(
			diagnosticToolName(call.name),
			"input_parse",
			"INVALID_TOOL_INPUT",
		);
		return { execution: toolError("INVALID_TOOL_INPUT") };
	}
}

/** Ends the run on the model's own terms, once the claim survives validation. */
async function handleFinishCall(
	toolName: FinishToolName,
	params: JsonObject,
	context: ToolCallContext,
): Promise<ToolExecution> {
	const { coordinator, job, runToken, recordDiagnostic } = context;
	if (coordinator.hasUnconfirmedSubmission()) {
		// A submission was activated and the page never confirmed it. Whatever
		// the model concludes, the run cannot end as anything but uncertain:
		// something may well have been sent.
		await recordDiagnostic(
			"finish",
			"finish_validation",
			"SUBMIT_CONFIRMATION_NOT_OBSERVED",
		);
		return {
			kind: "finished",
			output: JSON.stringify({ outcome: "uncertain" }),
			result: {
				outcome: "uncertain",
				reasonCode: "SUBMIT_CONFIRMATION_NOT_OBSERVED",
				reason:
					"The submission was activated and the page did not confirm that it completed.",
			},
		};
	}
	const parsed = parseFinishResult(
		normalizeFinishParams(toolName, params),
		job.targetDomain,
		job.allowedHosts,
	);
	if (!parsed.result) {
		await recordDiagnostic(
			"finish",
			"finish_validation",
			parsed.diagnosticCode,
		);
		return toolError("INVALID_TOOL_INPUT");
	}
	if (parsed.result.outcome === "prohibited") {
		try {
			const verification = await coordinator.validateProhibited(
				job.id,
				runToken,
				parsed.result.reasonCode,
				parsed.result.formUrl,
				parsed.evidence,
			);
			if (verification === "PROHIBITION_EVIDENCE_VERIFIED") {
				// Fixed code only: the quoted sentence is never recorded.
				await recordDiagnostic("finish", "finish_validation", verification);
			}
		} catch (error) {
			await recordDiagnostic(
				"finish",
				"finish_validation",
				error instanceof ProhibitionEvidenceError
					? error.code
					: "FINISH_PROHIBITION_NOT_VERIFIED",
			);
			return toolError("PROHIBITION_NOT_VERIFIED");
		}
		await coordinator.captureEvidence(job.id, runToken, "prohibited");
	}
	await recordDiagnostic("finish", "finish_validation", parsed.diagnosticCode);
	return {
		kind: "finished",
		output: JSON.stringify({ outcome: parsed.result.outcome }),
		result: parsed.result,
	};
}

/**
 * The dry-run reviews the submit control through `validateSubmit` and stops.
 * It never reaches the browser submission, so it always ends the run.
 */
async function handleDryRunSubmit(
	params: JsonObject,
	context: ToolCallContext,
): Promise<ToolExecution> {
	const { coordinator, job, runToken, recordDiagnostic } = context;
	const decision = await coordinator.validateSubmit(job.id, runToken, params);
	await recordDiagnostic(
		"submit",
		"submit_review",
		decision.decision === "allow"
			? "SUBMIT_REVIEW_ALLOWED"
			: "SUBMIT_REVIEW_DENIED",
	);
	// The screen the review judged is already stored as
	// `dry_run_before_submit`; the values it carried follow here. The
	// evidence is kept for a denial too, because that is where the
	// operator looks to see what the review objected to. Both captures
	// are best effort and never change the dry-run result.
	await coordinator.captureDryRunFieldMap(job.id, runToken, decision);
	// A denied review must not reach the dry-run boundary. The real-send
	// guard treats `DRY_RUN_COMPLETE` as a passed dry-run, so a denial
	// that kept that code would put refused content in front of an
	// approver. The dry-run has no correction path -- it reviews through
	// `validateSubmit` instead of `submit`, so the denial budget and the
	// correction turns of a real submission never run -- and one denial
	// therefore ends the run.
	if (decision.decision === "deny") {
		await recordDiagnostic(
			"submit",
			"submit_validate",
			"DRY_RUN_REVIEW_DENIED",
		);
		return {
			kind: "finished",
			output: JSON.stringify({ status: "dry_run", submitted: false }),
			result: {
				outcome: "uncertain",
				reasonCode: "DRY_RUN_REVIEW_DENIED",
				reason: `Dry-run stopped before submission authorization because the pre-submit review denied the submission. Pre-submit review: deny (${decision.reasonCode}).`,
			},
		};
	}
	await recordDiagnostic("submit", "submit_validate", "DRY_RUN_COMPLETE");
	return {
		kind: "finished",
		output: JSON.stringify({ status: "dry_run", submitted: false }),
		result: {
			outcome: "prohibited",
			formUrl: job.targetUrl,
			reasonCode: "DRY_RUN_COMPLETE",
			reason: `Dry-run validated the current submit control and stopped before submission authorization or browser submission. Pre-submit review: ${decision.decision} (${decision.reasonCode}).`,
		},
	};
}

/** Runs one browser tool and reads what the handler returned. */
async function runBrowserTool(
	tool: BrowserToolName,
	params: JsonObject,
	context: ToolCallContext,
): Promise<ToolExecution> {
	const { coordinator, job, runToken, recordDiagnostic } = context;
	const value = await coordinator.execute(job.id, runToken, tool, params);
	if (tool === "observe" && "result" in value) {
		await recordDiagnostic(tool, tool, "OK");
		return {
			kind: "succeeded",
			tool,
			output: observeOutput(value.result as BrowserObservation),
		};
	}
	if (tool === "submit" && "result" in value) {
		// One stage was activated and the page has shown no completion. The
		// job stays `submitting`; the model may observe what the page shows
		// now and activate the next control of the same submission. The call
		// succeeded, but only `observe` unlocks the full tool set, so nothing
		// downstream separates this from any other successful submit.
		await recordDiagnostic(tool, "submit", "SUBMIT_STAGE_PENDING");
		return {
			kind: "succeeded",
			tool,
			output: JSON.stringify({
				status: "submit_stage_pending",
				...(value.result as JsonObject),
			}),
		};
	}
	if (tool === "submit" && "job" in value) {
		const result = terminalResultFromJob(value.job);
		if (result) {
			await recordDiagnostic(tool, "submit", "OK");
			return {
				kind: "finished",
				output: JSON.stringify({ status: value.job.status }),
				result,
			};
		}
		await recordDiagnostic(tool, "submit", "SUBMIT_RESULT_NOT_PERSISTED");
		return toolError("SUBMIT_RESULT_NOT_PERSISTED");
	}
	await recordDiagnostic(tool, tool, "OK");
	return { kind: "succeeded", tool, output: JSON.stringify(value) };
}

/** Records the diagnostic for a failed call and carries out its disposition. */
async function disposeToolFailure(
	error: unknown,
	tool: BrowserToolName,
	context: ToolCallContext,
): Promise<ToolExecution> {
	const { db, job, runToken, recordDiagnostic } = context;
	const originalError =
		error instanceof BrowserToolSetupError ? error.originalError : error;
	const failure = describeToolFailure(originalError);
	await recordDiagnostic(
		tool,
		error instanceof BrowserToolSetupError
			? error.stage
			: isSubmitReviewError(originalError)
				? "submit_review"
				: tool,
		failure.diagnosticCode,
	);
	switch (failure.disposition) {
		case "rethrow":
			throw originalError;
		case "soft": {
			const execution = toolError(failure.errorCode, failure.details);
			return failure.reviewDenied
				? {
						kind: "review_denied",
						output: execution.output,
						errorCode: execution.errorCode,
					}
				: execution;
		}
		case "hard":
			throw new AgentExecutionError(
				failure.reasonCode,
				failure.message,
				failure.retryable,
			);
		case "persisted": {
			const persisted = await new D1JobStore(db).find(job.id);
			const result =
				persisted?.runToken === runToken && terminalResultFromJob(persisted);
			return result
				? {
						kind: "finished",
						output: JSON.stringify({ status: persisted.status }),
						result,
					}
				: toolError("JOB_STATE_CONFLICT");
		}
		case "unavailable":
			// BROWSER_TOOL_UNAVAILABLE is the only reason code the run failure
			// carries, so the breakdown is logged here as fixed values. Without
			// it a bootstrap failure is only visible in the D1 diagnostics, not
			// in Workers Logs. No value, URL, or session id is logged.
			console.log(
				JSON.stringify({
					event: "browser_setup_failed",
					code: failure.diagnosticCode,
					stage: error instanceof BrowserToolSetupError ? error.stage : tool,
					...failure.cdpDetail,
				}),
			);
			throw new AgentExecutionError(
				"BROWSER_TOOL_UNAVAILABLE",
				"The browser provider or tool became unavailable.",
				true,
				failure.cdpDetail?.method,
				failure.cdpDetail?.kind,
			);
	}
}

/** The CDP breakdown a command failure carries into the log and the result. */
interface CdpFailureDetail {
	method: string;
	kind: BrowserUseCdpCommandError["kind"];
	cdpCode?: number;
}

/**
 * What a failed tool call turns into. Decided from the error alone, so the
 * decision is a value the caller carries out rather than control flow buried
 * in a catch block.
 *
 * - `rethrow` re-raises the original error unchanged.
 * - `soft` returns a fixed tool error to the model and the run continues.
 * - `hard` ends the run with a fixed `AgentExecutionError`.
 * - `persisted` re-reads the job, because the submission may already have
 *   completed and the stored result is the only trustworthy answer.
 * - `unavailable` ends the run as `BROWSER_TOOL_UNAVAILABLE` after logging the
 *   breakdown, and claims every failure no earlier branch matched.
 */
type ToolFailureDisposition =
	| { disposition: "rethrow" }
	| {
			disposition: "soft";
			errorCode: ToolErrorCode;
			details?: JsonObject;
			/** Set when the denial buys the model its one correction turn. */
			reviewDenied?: true;
	  }
	| {
			disposition: "hard";
			reasonCode: string;
			message: string;
			retryable: boolean;
	  }
	| { disposition: "persisted" }
	| { disposition: "unavailable"; cdpDetail?: CdpFailureDetail };

export type ToolFailure = ToolFailureDisposition & {
	diagnosticCode: AgentToolDiagnosticCode;
};

/**
 * The one place a tool failure is recognised. Every branch names both halves
 * of the decision -- the diagnostic code written to D1 and the disposition the
 * caller applies -- so an error type cannot be handled by one half and missed
 * by the other.
 *
 * Order matters only where one class extends another: the `BrowserElementError`
 * subclasses are listed before their base, and every other branch is
 * independent of its neighbours.
 */
export function describeToolFailure(error: unknown): ToolFailure {
	// A reviewer provider failure keeps its own classification instead of
	// collapsing into a generic browser tool failure.
	if (error instanceof AgentExecutionError) {
		return {
			diagnosticCode: "SUBMIT_REVIEW_UNAVAILABLE",
			disposition: "rethrow",
		};
	}
	if (error instanceof SubmitReviewDeniedError) {
		return {
			diagnosticCode: "SUBMIT_REVIEW_DENIED",
			disposition: "soft",
			errorCode: "SUBMIT_REVIEW_DENIED",
			details: { reasonCode: error.reasonCode },
			reviewDenied: true,
		};
	}
	if (error instanceof SubmitReviewUnavailableError) {
		return {
			diagnosticCode: "SUBMIT_REVIEW_UNAVAILABLE",
			disposition: "hard",
			reasonCode: "SUBMIT_REVIEW_UNAVAILABLE",
			message: "The pre-submit review could not be completed.",
			retryable: true,
		};
	}
	if (error instanceof SubmissionEvidenceError) {
		return {
			diagnosticCode: "EVIDENCE_CAPTURE_FAILED",
			disposition: "hard",
			reasonCode: "SUBMISSION_EVIDENCE_UNAVAILABLE",
			message:
				"The submission evidence could not be captured before submission.",
			retryable: true,
		};
	}
	if (error instanceof BrowserUseCdpPayloadTooLargeError) {
		return {
			diagnosticCode: "PAYLOAD_TOO_LARGE",
			disposition: "hard",
			reasonCode: "BROWSER_PAYLOAD_TOO_LARGE",
			message: "The browser document exceeded the safe processing limit.",
			retryable: false,
		};
	}
	// The browser may already have submitted, so the stored job is the only
	// trustworthy account of what happened.
	if (error instanceof SubmissionResultUncertainError) {
		return {
			diagnosticCode: "SUBMISSION_RESULT_UNCERTAIN",
			disposition: "persisted",
		};
	}
	if (error instanceof SubmissionNotAuthorizedError) {
		return {
			diagnosticCode: "SUBMISSION_NOT_AUTHORIZED",
			disposition: "persisted",
		};
	}
	if (error instanceof NavigationPolicyError) {
		return {
			diagnosticCode: "NAVIGATION_POLICY",
			disposition: "soft",
			errorCode: "NAVIGATION_NOT_ALLOWED",
		};
	}
	// `BrowserElementError` subclasses. Several share the base's diagnostic
	// code but tell the model something different, so the two halves of the
	// decision are not the same partition of this family.
	if (error instanceof CorrectionRequiredError) {
		return {
			diagnosticCode: "ELEMENT_UNAVAILABLE",
			disposition: "soft",
			errorCode: "CORRECTION_REQUIRED",
		};
	}
	if (error instanceof FormStateChangedError) {
		return {
			diagnosticCode: "ELEMENT_UNAVAILABLE",
			disposition: "soft",
			errorCode: "FORM_STATE_CHANGED",
		};
	}
	if (error instanceof ObservationStaleError) {
		return {
			diagnosticCode: "ELEMENT_UNAVAILABLE",
			disposition: "soft",
			errorCode: "OBSERVATION_STALE",
		};
	}
	if (error instanceof SubmitStageUnverifiedError) {
		return {
			diagnosticCode: "SUBMIT_STAGE_UNVERIFIED",
			disposition: "soft",
			errorCode: "SUBMIT_STAGE_UNVERIFIED",
		};
	}
	if (error instanceof SubmitProhibitedError) {
		return {
			diagnosticCode: "SUBMIT_PROHIBITED",
			disposition: "soft",
			errorCode: "SUBMIT_PROHIBITED",
			details: {
				prohibitedReasonCodes: error.reasonCodes,
				pageProhibited: error.pageProhibited,
			},
		};
	}
	if (error instanceof BrowserElementOperationError) {
		return {
			diagnosticCode: "ELEMENT_OPERATION_CDP_FAILED",
			disposition: "soft",
			errorCode: "ELEMENT_UNAVAILABLE",
		};
	}
	if (error instanceof BrowserFormInvalidError) {
		return {
			diagnosticCode: "FORM_INVALID",
			disposition: "soft",
			errorCode: "FORM_INVALID",
		};
	}
	if (error instanceof BrowserElementError) {
		return {
			diagnosticCode: "ELEMENT_UNAVAILABLE",
			disposition: "soft",
			errorCode: "ELEMENT_UNAVAILABLE",
		};
	}
	if (error instanceof BrowserToolInputError || error instanceof SyntaxError) {
		return {
			diagnosticCode: "TOOL_INPUT_INVALID",
			disposition: "soft",
			errorCode: "INVALID_TOOL_INPUT",
		};
	}
	// A provider rejection that will not succeed on a second attempt ends the
	// run; a transient one falls through to the retryable failure below.
	if (error instanceof BrowserUseCdpUpgradeRejectedError) {
		return error.retryable
			? { diagnosticCode: "CDP_UPGRADE_REJECTED", disposition: "unavailable" }
			: {
					diagnosticCode: "CDP_UPGRADE_REJECTED",
					disposition: "hard",
					reasonCode: "BROWSER_UPGRADE_REJECTED",
					message: "The browser provider rejected the connection.",
					retryable: false,
				};
	}
	if (error instanceof BrowserUseCdpClosedError) {
		const diagnosticCode = messageDiagnosticCode(error);
		return error.retryable
			? { diagnosticCode, disposition: "unavailable" }
			: {
					diagnosticCode,
					disposition: "hard",
					reasonCode: "BROWSER_CONNECTION_REJECTED",
					message: "The browser provider rejected the connection.",
					retryable: false,
				};
	}
	if (error instanceof BrowserUseApiError) {
		const diagnosticCode =
			error.status === 429
				? "BROWSER_SESSION_LIMIT"
				: "BROWSER_SESSION_API_FAILED";
		return error.retryable
			? { diagnosticCode, disposition: "unavailable" }
			: {
					diagnosticCode,
					disposition: "hard",
					reasonCode: "BROWSER_SESSION_REJECTED",
					message: "The browser provider rejected the session request.",
					retryable: false,
				};
	}
	if (
		error instanceof BrowserUseRequestError ||
		error instanceof BrowserUseResponseError
	) {
		return {
			diagnosticCode: "BROWSER_SESSION_API_FAILED",
			disposition: "unavailable",
		};
	}
	return {
		diagnosticCode: messageDiagnosticCode(error),
		disposition: "unavailable",
		...(error instanceof BrowserUseCdpCommandError
			? {
					cdpDetail: {
						method: error.method,
						kind: error.kind,
						...(error.code !== null ? { cdpCode: error.code } : {}),
					},
				}
			: {}),
	};
}

/**
 * The fallback layer of the classification: several call sites raise plain
 * `Error`s carrying a fixed `BROWSER_ERROR` string rather than a dedicated
 * class, so the message is read when no branch above recognised the type.
 */
function messageDiagnosticCode(error: unknown): AgentToolDiagnosticCode {
	if (!(error instanceof Error)) return "UNKNOWN";

	switch (error.message) {
		case BROWSER_ERROR.CDP_CONNECTION_FAILED:
			return "CDP_CONNECTION_FAILED";
		case BROWSER_ERROR.CDP_CONNECTION_IS_CLOSED:
		case BROWSER_ERROR.CDP_CONNECTION_CLOSED:
			return "CDP_CONNECTION_CLOSED";
		case BROWSER_ERROR.CDP_COMMAND_TIMED_OUT:
			return "CDP_COMMAND_TIMEOUT";
		case BROWSER_ERROR.CDP_COMMAND_NOT_SENT:
			return "CDP_COMMAND_SEND_FAILED";
		case BROWSER_ERROR.CDP_COMMAND_FAILED:
			return "CDP_COMMAND_FAILED";
		case BROWSER_ERROR.CDP_ENDPOINT_INVALID:
			return "CDP_ENDPOINT_INVALID";
		case BROWSER_ERROR.API_KEY_REQUIRED:
			return "BROWSER_CREDENTIALS_MISSING";
		case BROWSER_ERROR.DOMAIN_SCOPE_CANNOT_CHANGE:
		case BROWSER_ERROR.HOST_SCOPE_CANNOT_CHANGE:
		case BROWSER_ERROR.DOMAIN_SCOPE_NOT_CONFIGURED:
			return "SCOPE_CONFIGURATION_FAILED";
		case BROWSER_ERROR.NAVIGATION_FAILED:
			return "NAVIGATION_FAILED";
		case BROWSER_ERROR.PAGE_NOT_READY:
			return "PAGE_NOT_READY";
		case BROWSER_ERROR.DOM_DISCOVERY_FAILED:
			return "DOM_DISCOVERY_FAILED";
		case BROWSER_ERROR.PAGE_EVALUATION_FAILED:
			return "PAGE_EVALUATION_FAILED";
		case BROWSER_ERROR.SCREENSHOT_FAILED:
			return "SCREENSHOT_FAILED";
		default:
			return "UNKNOWN";
	}
}

async function recordToolDiagnostic(
	db: D1Database,
	job: Job,
	runToken: string,
	turn: number,
	toolName: AgentToolDiagnosticToolName,
	stage: AgentToolDiagnosticStage,
	resultCode: AgentToolDiagnosticCode,
): Promise<void> {
	try {
		await new D1JobStore(db).recordAgentToolDiagnostic(
			job.id,
			runToken,
			turn,
			toolName,
			stage,
			resultCode,
			new Date().toISOString(),
		);
	} catch {
		console.warn("agent_tool_diagnostic_write_failed");
	}
}

export function diagnosticToolName(value: string): AgentToolDiagnosticToolName {
	if (isFinishToolName(value)) return "finish";
	return browserToolName(value) ?? "unknown";
}

function isSubmitReviewError(error: unknown): boolean {
	return (
		error instanceof SubmitReviewDeniedError ||
		error instanceof SubmitReviewUnavailableError ||
		error instanceof AgentExecutionError
	);
}

function observeOutput(observation: BrowserObservation): string {
	return JSON.stringify({
		trust: "untrusted_page_content",
		observation,
		...(observation.pageTextTruncated
			? {
					pageTextTruncated: true,
					omitted: "page text was truncated at the trusted handler's limit",
				}
			: {}),
	});
}

type FinishToolName =
	| "finish_prohibited"
	| "finish_uncertain"
	| "finish_failed";

function isFinishToolName(value: string): value is FinishToolName {
	return (
		value === "finish_prohibited" ||
		value === "finish_uncertain" ||
		value === "finish_failed"
	);
}

function normalizeFinishParams(
	toolName: FinishToolName,
	params: JsonObject,
): JsonObject {
	if (toolName === "finish_prohibited") {
		return { ...params, outcome: "prohibited", retryable: null };
	}
	if (toolName === "finish_uncertain") {
		return { ...params, outcome: "uncertain", formUrl: null, retryable: null };
	}
	return { ...params, outcome: "failed", formUrl: null };
}

function terminalResultFromJob(
	job: Omit<Job, "runToken">,
): AgentRunResult | null {
	if (job.status === "sent" && job.result?.formUrl) {
		return { outcome: "sent", formUrl: job.result.formUrl };
	}
	if (
		job.status === "uncertain" &&
		job.result?.reasonCode &&
		job.result.reason
	) {
		return {
			outcome: "uncertain",
			reasonCode: job.result.reasonCode,
			reason: job.result.reason,
		};
	}
	return null;
}

type FinishParseResult =
	| {
			result:
				| Exclude<AgentRunResult, { outcome: "prohibited" }>
				| {
						outcome: "prohibited";
						formUrl: string | null;
						reasonCode: ProhibitedReasonCode;
						reason: string;
				  };
			/**
			 * The sentence the model quoted from the page, kept out of `result`
			 * so it never reaches the stored reason, an event, or a log.
			 */
			evidence?: string;
			diagnosticCode: "OK";
	  }
	| {
			result: null;
			evidence?: undefined;
			diagnosticCode:
				| "FINISH_FIELDS_INVALID"
				| "FINISH_FORM_URL_NOT_ALLOWED"
				| "FINISH_OUTCOME_INVALID";
	  };

type UncertainReasonCode = (typeof UNCERTAIN_REASON_CODES)[number];

function isUncertainReasonCode(value: string): value is UncertainReasonCode {
	return (UNCERTAIN_REASON_CODES as readonly string[]).includes(value);
}

function parseFinishResult(
	params: JsonObject,
	targetDomain: string,
	allowedHosts: readonly string[],
): FinishParseResult {
	const { outcome, formUrl, reasonCode, reason, retryable, evidence } = params;
	if (
		evidence !== undefined &&
		evidence !== null &&
		(typeof evidence !== "string" ||
			evidence.length < MIN_PROHIBITION_EVIDENCE_LENGTH ||
			evidence.length > MAX_PROHIBITION_EVIDENCE_LENGTH)
	) {
		return { result: null, diagnosticCode: "FINISH_FIELDS_INVALID" };
	}
	if (
		typeof reasonCode !== "string" ||
		!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode) ||
		typeof reason !== "string" ||
		reason.length === 0 ||
		reason.length > 1_000 ||
		(formUrl !== null && typeof formUrl !== "string") ||
		(retryable !== null && typeof retryable !== "boolean")
	) {
		return { result: null, diagnosticCode: "FINISH_FIELDS_INVALID" };
	}

	if (outcome === "prohibited" && retryable === null) {
		if (!isProhibitedReasonCode(reasonCode)) {
			return { result: null, diagnosticCode: "FINISH_FIELDS_INVALID" };
		}
		try {
			if (formUrl) {
				assertAllowedTargetUrl(formUrl, targetDomain, allowedHosts);
			}
		} catch {
			return {
				result: null,
				diagnosticCode: "FINISH_FORM_URL_NOT_ALLOWED",
			};
		}
		return {
			result: { outcome, formUrl, reasonCode, reason },
			...(typeof evidence === "string" ? { evidence } : {}),
			diagnosticCode: "OK",
		};
	}
	if (outcome === "uncertain" && formUrl === null && retryable === null) {
		if (!isUncertainReasonCode(reasonCode)) {
			return { result: null, diagnosticCode: "FINISH_FIELDS_INVALID" };
		}
		return {
			result: { outcome, reasonCode, reason },
			diagnosticCode: "OK",
		};
	}
	if (
		outcome === "failed" &&
		formUrl === null &&
		typeof retryable === "boolean"
	) {
		return {
			result: { outcome, reasonCode, reason, retryable },
			diagnosticCode: "OK",
		};
	}
	return { result: null, diagnosticCode: "FINISH_OUTCOME_INVALID" };
}

function browserToolName(value: string): BrowserToolName | null {
	switch (value) {
		case "navigate":
		case "observe":
		case "click":
		case "fill":
		case "select":
		case "submit":
			return value;
		default:
			return null;
	}
}

function isElementId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 64 &&
		ELEMENT_ID_PATTERN.test(value)
	);
}

function isSubmitActivationStrategy(
	value: unknown,
): value is SubmitActivationStrategy {
	return SUBMIT_ACTIVATION_STRATEGIES.some((strategy) => strategy === value);
}

type ToolErrorCode = keyof typeof TOOL_ERROR_GUIDANCE;

function toolError(
	code: ToolErrorCode,
	details: JsonObject = {},
): ToolExecution & { kind: "error" } {
	return {
		kind: "error",
		output: JSON.stringify({
			error: code,
			...details,
			guidance: TOOL_ERROR_GUIDANCE[code],
		}),
		errorCode: code,
	};
}
