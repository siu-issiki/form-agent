import {
	CORRECTION_TURNS,
	MAX_PROVIDER_REQUESTS,
	MAX_TURNS,
} from "./agent-budget";
import { AgentExecutionError, type AgentExecutor } from "./agent-executor";
import type { AgentRunInput, AgentRunResult } from "./agent-runtime";
import type {
	AgentToolDiagnosticCode,
	AgentToolDiagnosticStage,
	AgentToolDiagnosticToolName,
} from "./agent-tool-diagnostic";
import {
	AGENT_TOOLS,
	INITIAL_AGENT_TOOLS,
	systemPrompt,
	TOOL_ERROR_GUIDANCE,
	UNCERTAIN_REASON_CODES,
} from "./agent-tool-schema";
import { BROWSER_ERROR } from "./browser-error-messages";
import {
	type BrowserDriverFactory,
	BrowserToolCoordinator,
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
import { BrowserUseCdpDriver } from "./browser-use-cdp-driver";
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
import {
	type AgentRunMetrics,
	type AgentRunOutcome,
	DRY_RUN_KEY,
	EFFECTIVE_DRY_RUN_KEY,
	type Job,
} from "./job";
import { isRecord } from "./json-record";
import {
	type JsonObject,
	type ProviderUsage,
	providerRequestByteLength,
	readProviderUsage,
	readResponseOutput,
	requestResponses,
	throwIfAborted,
} from "./openai-responses-client";
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
	type SubmitReviewer,
	SubmitReviewUnavailableError,
	SubmitStageUnverifiedError,
} from "./restricted-browser";
import { SEND_APPROVAL_KEY } from "./send-approval";
import type { EvidenceObjectStore } from "./submission-evidence";
import { ResponsesSubmitReviewer } from "./submit-reviewer";
import {
	ELEMENT_ID_PATTERN,
	SUBMIT_ACTIVATION_STRATEGIES,
} from "./tool-input-patterns";

const RUN_METRICS_WRITE_TIMEOUT_MS = 2_000;
const MAX_PROVIDER_OUTPUT_TOKENS = 4_096;
const MAX_PROVIDER_REQUEST_BYTES = 512 * 1_024;
const MAX_JOB_PROMPT_LENGTH = 64_000;

interface FunctionCall {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
}

interface ResponsesAgentExecutorOptions {
	db: D1Database;
	evidenceStore: EvidenceObjectStore;
	model: string;
	reviewModel?: string;
	openAiApiKey: string;
	browserUseApiKey: string;
	dryRun?: boolean;
	fetcher?: typeof fetch;
	createBrowserDriver?: (
		apiKey: string,
		job: Job,
		dryRun: boolean,
		signal?: AbortSignal,
	) => ReturnType<BrowserDriverFactory>;
}

/** Counters collected while one run executes. Numbers and fixed codes only. */
interface RunCounters {
	turns: number;
	providerRequests: number;
	reviewRequests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cachedTokens: number;
	submitReviewAllow: number;
	submitReviewDeny: number;
}

interface ToolExecution {
	output: string;
	result?: AgentRunResult;
	/** Set when the pre-submit review denied a correctable submission. */
	reviewDenied?: true;
	successfulTool?: BrowserToolName;
	/** Fixed error code returned to the model instead of a tool result. */
	errorCode?: ToolErrorCode;
}

export class ResponsesAgentExecutor implements AgentExecutor {
	readonly terminationGraceMs = 30_000;

	readonly #db: D1Database;
	readonly #evidenceStore: EvidenceObjectStore;
	readonly #model: string;
	readonly #reviewModel: string;
	readonly #openAiApiKey: string;
	readonly #browserUseApiKey: string;
	readonly #dryRun: boolean;
	readonly #fetcher: typeof fetch;
	readonly #createBrowserDriver: (
		apiKey: string,
		job: Job,
		dryRun: boolean,
		signal?: AbortSignal,
	) => ReturnType<BrowserDriverFactory>;

	constructor(options: ResponsesAgentExecutorOptions) {
		if (!options.model || options.model.length > 128) {
			throw new Error("Invalid agent model");
		}
		if (options.reviewModel !== undefined && options.reviewModel.length > 128) {
			throw new Error("Invalid agent model");
		}
		if (!options.openAiApiKey || !options.browserUseApiKey) {
			throw new Error("Agent provider credentials are required");
		}
		this.#db = options.db;
		this.#evidenceStore = options.evidenceStore;
		this.#model = options.model;
		this.#reviewModel = options.reviewModel || options.model;
		this.#openAiApiKey = options.openAiApiKey;
		this.#browserUseApiKey = options.browserUseApiKey;
		this.#dryRun = options.dryRun ?? false;
		const fetcher = options.fetcher ?? fetch;
		this.#fetcher = (resource, init) => fetcher(resource, init);
		this.#createBrowserDriver =
			options.createBrowserDriver ??
			((apiKey, job, dryRun, signal) =>
				BrowserUseCdpDriver.connect(
					apiKey,
					job,
					dryRun,
					signal ? { signal } : {},
				));
	}

	async execute(
		input: AgentRunInput,
		signal: AbortSignal,
	): Promise<AgentRunResult> {
		const dryRun = isJobDryRun(input.job.payload, this.#dryRun);
		const counters = newRunCounters();
		const startedAt = Date.now();
		const coordinator = new BrowserToolCoordinator(
			this.#db,
			(job) =>
				this.#createBrowserDriver(this.#browserUseApiKey, job, dryRun, signal),
			this.#evidenceStore,
			(job) => this.#createReviewer(job, input.runToken, signal, counters),
		);
		const abort = () => {
			void coordinator.close().catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });

		// Every exit path is measured: the loop result, the early returns of
		// #run, and the AgentExecutionError it throws.
		let outcome: AgentRunOutcome = "error";
		try {
			const result = await this.#run(
				input,
				coordinator,
				signal,
				dryRun,
				counters,
			);
			outcome = result.outcome;
			return result;
		} finally {
			signal.removeEventListener("abort", abort);
			await coordinator.close().catch(() => undefined);
			await this.#recordRunMetrics(input, {
				...counters,
				browserConnectMs: coordinator.connectDurationMs,
				browserConnected: coordinator.browserConnected,
				durationMs: Math.max(0, Date.now() - startedAt),
				outcome,
			});
		}
	}

	/**
	 * Best-effort and bounded: the write runs inside the executor's deadline
	 * race, so a slow D1 must not let the timeout win over a run result that
	 * #run already settled. A write cut off by the bound is reported, not
	 * awaited.
	 */
	async #recordRunMetrics(
		input: AgentRunInput,
		metrics: AgentRunMetrics,
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"TIMEOUT">((resolve) => {
			timer = setTimeout(
				() => resolve("TIMEOUT"),
				RUN_METRICS_WRITE_TIMEOUT_MS,
			);
		});
		try {
			const write = new D1JobStore(this.#db)
				.recordAgentRunMetrics(
					input.job.id,
					input.runToken,
					input.job.attemptCount,
					metrics,
					new Date().toISOString(),
				)
				.then(
					() => "OK" as const,
					() => "WRITE_FAILED" as const,
				);
			const result = await Promise.race([write, timedOut]);
			if (result !== "OK") {
				console.warn(
					JSON.stringify({
						event: "agent_run_metrics_not_recorded",
						reason: result,
					}),
				);
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async #run(
		input: AgentRunInput,
		coordinator: BrowserToolCoordinator,
		signal: AbortSignal,
		dryRun: boolean,
		counters: RunCounters,
	): Promise<AgentRunResult> {
		const safeJob = withoutTrustedOnlyFields(input.job);
		const jobJson = JSON.stringify(safeJob);
		if (jobJson.length > MAX_JOB_PROMPT_LENGTH) {
			return failed("JOB_INPUT_TOO_LARGE", false);
		}

		const store = new D1JobStore(this.#db);
		const history: unknown[] = [
			{
				role: "user",
				content: `Process exactly this one form outreach job. Never process another company.\n${jobJson}`,
			},
		];
		let hasObservedPage = false;

		let maxTurns = MAX_TURNS;
		let correctionTurnsGranted = false;
		let observations = 0;
		let toolCalls = 0;
		let toolErrors = 0;
		for (let turn = 0; turn < maxTurns; turn += 1) {
			throwIfAborted(signal);
			counters.turns += 1;
			const tools = hasObservedPage ? AGENT_TOOLS : INITIAL_AGENT_TOOLS;
			const body = JSON.stringify({
				model: this.#model,
				instructions: systemPrompt(dryRun),
				input: history,
				tools,
				tool_choice: "required",
				parallel_tool_calls: false,
				max_output_tokens: MAX_PROVIDER_OUTPUT_TOKENS,
				reasoning: { effort: "low" },
				store: false,
				include: ["reasoning.encrypted_content"],
			});
			if (providerRequestByteLength(body) > MAX_PROVIDER_REQUEST_BYTES) {
				return failed("AGENT_CONTEXT_TOO_LARGE", false);
			}
			if (
				!(await store.claimProviderRequest(
					input.job.id,
					input.runToken,
					MAX_PROVIDER_REQUESTS,
					new Date().toISOString(),
				))
			) {
				return failed("PROVIDER_REQUEST_LIMIT_REACHED", false);
			}

			const response = await requestResponses(
				this.#fetcher,
				this.#openAiApiKey,
				body,
				signal,
			);
			counters.providerRequests += 1;
			addUsage(counters, readProviderUsage(response));
			if (isRecord(response.usage)) {
				console.log(
					JSON.stringify({
						event: "provider_usage",
						jobId: input.job.id,
						turn: turn + 1,
						usage: response.usage,
					}),
				);
			}
			const output = readResponseOutput(response);
			const calls = output.filter(isFunctionCall);
			const call = calls[0];
			if (calls.length !== 1 || !call) {
				return failed("AGENT_DID_NOT_FINISH", false);
			}

			history.push(...output);
			toolCalls += 1;
			const execution = await executeToolCall(
				call,
				tools.map((tool) => tool.name),
				coordinator,
				input.job,
				input.runToken,
				signal,
				this.#db,
				dryRun,
				turn + 1,
			);
			if (execution.errorCode) {
				toolErrors += 1;
				// Fixed values only: the tool name and the error code come from
				// closed sets, so no elementId, payloadKey, value, or URL is logged.
				console.log(
					JSON.stringify({
						event: "browser_tool_error",
						tool: diagnosticToolName(call.name),
						code: execution.errorCode,
						turn: turn + 1,
					}),
				);
			}
			if (execution.result) return execution.result;
			if (execution.reviewDenied && !correctionTurnsGranted) {
				// The single correction the review allows must not be cut short
				// by a denial that lands near the turn limit.
				correctionTurnsGranted = true;
				maxTurns += CORRECTION_TURNS;
			}
			if (execution.successfulTool === "observe") {
				hasObservedPage = true;
				observations += 1;
			}
			history.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: execution.output,
			});
		}

		// Counts only, so the line says how the budget was spent without
		// revealing any input value, page text, or URL.
		console.log(
			JSON.stringify({
				event: "agent_turn_limit_reached",
				observations,
				toolCalls,
				toolErrors,
			}),
		);
		return failed("AGENT_TURN_LIMIT", false);
	}

	/**
	 * The reviewer keeps its own interface; the wrapper only counts what the
	 * run metrics need.
	 */
	#createReviewer(
		job: Job,
		runToken: string,
		signal: AbortSignal,
		counters: RunCounters,
	): SubmitReviewer {
		const reviewer = new ResponsesSubmitReviewer({
			db: this.#db,
			jobId: job.id,
			runToken,
			model: this.#reviewModel,
			openAiApiKey: this.#openAiApiKey,
			fetcher: this.#fetcher,
			signal,
			onUsage: (usage) => {
				counters.reviewRequests += 1;
				addUsage(counters, usage);
			},
		});
		return {
			async review(input) {
				const decision = await reviewer.review(input);
				if (decision.decision === "allow") counters.submitReviewAllow += 1;
				else counters.submitReviewDeny += 1;
				return decision;
			},
		};
	}
}

function newRunCounters(): RunCounters {
	return {
		turns: 0,
		providerRequests: 0,
		reviewRequests: 0,
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cachedTokens: 0,
		submitReviewAllow: 0,
		submitReviewDeny: 0,
	};
}

function addUsage(counters: RunCounters, usage: ProviderUsage): void {
	counters.inputTokens += usage.inputTokens;
	counters.outputTokens += usage.outputTokens;
	counters.reasoningTokens += usage.reasoningTokens;
	counters.cachedTokens += usage.cachedTokens;
}

export function isJobDryRun(
	payload: Record<string, unknown>,
	legacyDryRun: boolean,
): boolean {
	const effectiveDryRun = payload[EFFECTIVE_DRY_RUN_KEY];
	return (
		effectiveDryRun === true ||
		payload[DRY_RUN_KEY] === true ||
		(effectiveDryRun === undefined && legacyDryRun)
	);
}

async function executeToolCall(
	call: FunctionCall,
	allowedToolNames: readonly string[],
	coordinator: BrowserToolCoordinator,
	job: Job,
	runToken: string,
	signal: AbortSignal,
	db: D1Database,
	dryRun: boolean,
	turn: number,
): Promise<ToolExecution> {
	throwIfAborted(signal);
	const toolName = diagnosticToolName(call.name);
	if (!allowedToolNames.includes(call.name)) {
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			"unknown",
			"tool_dispatch",
			"UNKNOWN_TOOL",
		);
		return toolError("UNKNOWN_TOOL");
	}
	let params: JsonObject;
	try {
		const value: unknown = JSON.parse(call.arguments);
		if (!isRecord(value)) throw new SyntaxError();
		params = value;
	} catch {
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			toolName,
			"input_parse",
			"INVALID_TOOL_INPUT",
		);
		return toolError("INVALID_TOOL_INPUT");
	}

	if (isFinishToolName(call.name) && coordinator.hasUnconfirmedSubmission()) {
		// A submission was activated and the page never confirmed it. Whatever
		// the model concludes, the run cannot end as anything but uncertain:
		// something may well have been sent.
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			"finish",
			"finish_validation",
			"SUBMIT_CONFIRMATION_NOT_OBSERVED",
		);
		return {
			output: JSON.stringify({ outcome: "uncertain" }),
			result: {
				outcome: "uncertain",
				reasonCode: "SUBMIT_CONFIRMATION_NOT_OBSERVED",
				reason:
					"The submission was activated and the page did not confirm that it completed.",
			},
		};
	}
	if (isFinishToolName(call.name)) {
		params = normalizeFinishParams(call.name, params);
		const parsed = parseFinishResult(
			params,
			job.targetDomain,
			job.allowedHosts,
		);
		if (!parsed.result) {
			await recordToolDiagnostic(
				db,
				job,
				runToken,
				turn,
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
					await recordToolDiagnostic(
						db,
						job,
						runToken,
						turn,
						"finish",
						"finish_validation",
						verification,
					);
				}
			} catch (error) {
				await recordToolDiagnostic(
					db,
					job,
					runToken,
					turn,
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
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			"finish",
			"finish_validation",
			parsed.diagnosticCode,
		);
		return {
			output: JSON.stringify({ outcome: parsed.result.outcome }),
			result: parsed.result,
		};
	}
	if (
		call.name === "submit" &&
		dryRun &&
		(!isElementId(params.elementId) ||
			!isSubmitActivationStrategy(params.activationStrategy))
	) {
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			"submit",
			"input_parse",
			"INVALID_TOOL_INPUT",
		);
		return toolError("INVALID_TOOL_INPUT");
	}

	const tool = browserToolName(call.name);
	if (!tool) {
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			"unknown",
			"tool_dispatch",
			"UNKNOWN_TOOL",
		);
		return toolError("UNKNOWN_TOOL");
	}
	try {
		if (tool === "submit" && dryRun) {
			const decision = await coordinator.validateSubmit(
				job.id,
				runToken,
				params,
			);
			await recordToolDiagnostic(
				db,
				job,
				runToken,
				turn,
				tool,
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
				await recordToolDiagnostic(
					db,
					job,
					runToken,
					turn,
					tool,
					"submit_validate",
					"DRY_RUN_REVIEW_DENIED",
				);
				return {
					output: JSON.stringify({ status: "dry_run", submitted: false }),
					result: {
						outcome: "uncertain",
						reasonCode: "DRY_RUN_REVIEW_DENIED",
						reason: `Dry-run stopped before submission authorization because the pre-submit review denied the submission. Pre-submit review: deny (${decision.reasonCode}).`,
					},
				};
			}
			await recordToolDiagnostic(
				db,
				job,
				runToken,
				turn,
				tool,
				"submit_validate",
				"DRY_RUN_COMPLETE",
			);
			return {
				output: JSON.stringify({ status: "dry_run", submitted: false }),
				result: {
					outcome: "prohibited",
					formUrl: job.targetUrl,
					reasonCode: "DRY_RUN_COMPLETE",
					reason: `Dry-run validated the current submit control and stopped before submission authorization or browser submission. Pre-submit review: ${decision.decision} (${decision.reasonCode}).`,
				},
			};
		}
		const value = await coordinator.execute(job.id, runToken, tool, params);
		if (tool === "observe" && "result" in value) {
			await recordToolDiagnostic(db, job, runToken, turn, tool, tool, "OK");
			return {
				output: observeOutput(value.result as BrowserObservation),
				successfulTool: tool,
			};
		}
		if (tool === "submit" && "result" in value) {
			// One stage was activated and the page has shown no completion. The
			// job stays `submitting`; the model may observe what the page shows
			// now and activate the next control of the same submission.
			await recordToolDiagnostic(
				db,
				job,
				runToken,
				turn,
				tool,
				"submit",
				"SUBMIT_STAGE_PENDING",
			);
			return {
				output: JSON.stringify({
					status: "submit_stage_pending",
					...(value.result as JsonObject),
				}),
			};
		}
		if (tool === "submit" && "job" in value) {
			const result = terminalResultFromJob(value.job);
			if (result) {
				await recordToolDiagnostic(
					db,
					job,
					runToken,
					turn,
					tool,
					"submit",
					"OK",
				);
				return { output: JSON.stringify({ status: value.job.status }), result };
			}
			await recordToolDiagnostic(
				db,
				job,
				runToken,
				turn,
				tool,
				"submit",
				"SUBMIT_RESULT_NOT_PERSISTED",
			);
			return toolError("SUBMIT_RESULT_NOT_PERSISTED");
		}
		await recordToolDiagnostic(db, job, runToken, turn, tool, tool, "OK");
		return { output: JSON.stringify(value), successfulTool: tool };
	} catch (error) {
		throwIfAborted(signal);
		const originalError =
			error instanceof BrowserToolSetupError ? error.originalError : error;
		const diagnosticCode = classifyToolDiagnostic(originalError);
		await recordToolDiagnostic(
			db,
			job,
			runToken,
			turn,
			tool,
			error instanceof BrowserToolSetupError
				? error.stage
				: isSubmitReviewError(originalError)
					? "submit_review"
					: tool,
			diagnosticCode,
		);
		// A reviewer provider failure keeps its own classification instead of
		// collapsing into a generic browser tool failure.
		if (originalError instanceof AgentExecutionError) {
			throw originalError;
		}
		if (originalError instanceof SubmitReviewDeniedError) {
			return {
				...toolError("SUBMIT_REVIEW_DENIED", {
					reasonCode: originalError.reasonCode,
				}),
				reviewDenied: true,
			};
		}
		if (originalError instanceof SubmitReviewUnavailableError) {
			throw new AgentExecutionError(
				"SUBMIT_REVIEW_UNAVAILABLE",
				"The pre-submit review could not be completed.",
				true,
			);
		}
		if (originalError instanceof SubmissionEvidenceError) {
			throw new AgentExecutionError(
				"SUBMISSION_EVIDENCE_UNAVAILABLE",
				"The submission evidence could not be captured before submission.",
				true,
			);
		}
		if (originalError instanceof BrowserUseCdpPayloadTooLargeError) {
			throw new AgentExecutionError(
				"BROWSER_PAYLOAD_TOO_LARGE",
				"The browser document exceeded the safe processing limit.",
				false,
			);
		}
		if (
			originalError instanceof SubmissionResultUncertainError ||
			originalError instanceof SubmissionNotAuthorizedError
		) {
			const persisted = await new D1JobStore(db).find(job.id);
			const result =
				persisted?.runToken === runToken && terminalResultFromJob(persisted);
			return result
				? { output: JSON.stringify({ status: persisted.status }), result }
				: toolError("JOB_STATE_CONFLICT");
		}
		if (originalError instanceof NavigationPolicyError) {
			return toolError("NAVIGATION_NOT_ALLOWED");
		}
		if (originalError instanceof CorrectionRequiredError) {
			return toolError("CORRECTION_REQUIRED");
		}
		if (originalError instanceof FormStateChangedError) {
			return toolError("FORM_STATE_CHANGED");
		}
		if (originalError instanceof ObservationStaleError) {
			return toolError("OBSERVATION_STALE");
		}
		if (originalError instanceof SubmitStageUnverifiedError) {
			return toolError("SUBMIT_STAGE_UNVERIFIED");
		}
		if (originalError instanceof SubmitProhibitedError) {
			return toolError("SUBMIT_PROHIBITED", {
				prohibitedReasonCodes: originalError.reasonCodes,
				pageProhibited: originalError.pageProhibited,
			});
		}
		if (originalError instanceof BrowserFormInvalidError) {
			return toolError("FORM_INVALID");
		}
		if (originalError instanceof BrowserElementError) {
			return toolError("ELEMENT_UNAVAILABLE");
		}
		if (
			originalError instanceof BrowserToolInputError ||
			originalError instanceof SyntaxError
		) {
			return toolError("INVALID_TOOL_INPUT");
		}
		if (
			originalError instanceof BrowserUseCdpUpgradeRejectedError &&
			!originalError.retryable
		) {
			throw new AgentExecutionError(
				"BROWSER_UPGRADE_REJECTED",
				"The browser provider rejected the connection.",
				false,
			);
		}
		if (
			originalError instanceof BrowserUseCdpClosedError &&
			!originalError.retryable
		) {
			throw new AgentExecutionError(
				"BROWSER_CONNECTION_REJECTED",
				"The browser provider rejected the connection.",
				false,
			);
		}
		if (
			originalError instanceof BrowserUseApiError &&
			!originalError.retryable
		) {
			throw new AgentExecutionError(
				"BROWSER_SESSION_REJECTED",
				"The browser provider rejected the session request.",
				false,
			);
		}
		// BROWSER_TOOL_UNAVAILABLE is the only reason code the run failure carries,
		// so the breakdown is logged here as fixed values. Without it a bootstrap
		// failure is only visible in the D1 diagnostics, not in Workers Logs. No
		// value, URL, or session id is logged.
		const cdpDetail =
			originalError instanceof BrowserUseCdpCommandError
				? {
						method: originalError.method,
						kind: originalError.kind,
						...(originalError.code !== null
							? { cdpCode: originalError.code }
							: {}),
					}
				: undefined;
		console.log(
			JSON.stringify({
				event: "browser_setup_failed",
				code: diagnosticCode,
				stage: error instanceof BrowserToolSetupError ? error.stage : tool,
				...cdpDetail,
			}),
		);
		throw new AgentExecutionError(
			"BROWSER_TOOL_UNAVAILABLE",
			"The browser provider or tool became unavailable.",
			true,
			cdpDetail?.method,
			cdpDetail?.kind,
		);
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

function diagnosticToolName(value: string): AgentToolDiagnosticToolName {
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

export function classifyToolDiagnostic(
	error: unknown,
): AgentToolDiagnosticCode {
	if (error instanceof SubmitReviewDeniedError) return "SUBMIT_REVIEW_DENIED";
	if (
		error instanceof SubmitReviewUnavailableError ||
		error instanceof AgentExecutionError
	) {
		return "SUBMIT_REVIEW_UNAVAILABLE";
	}
	if (error instanceof BrowserUseCdpPayloadTooLargeError) {
		return "PAYLOAD_TOO_LARGE";
	}
	if (error instanceof BrowserUseCdpUpgradeRejectedError) {
		return "CDP_UPGRADE_REJECTED";
	}
	if (error instanceof BrowserUseApiError) {
		return error.status === 429
			? "BROWSER_SESSION_LIMIT"
			: "BROWSER_SESSION_API_FAILED";
	}
	if (
		error instanceof BrowserUseRequestError ||
		error instanceof BrowserUseResponseError
	) {
		return "BROWSER_SESSION_API_FAILED";
	}
	if (error instanceof BrowserToolInputError || error instanceof SyntaxError) {
		return "TOOL_INPUT_INVALID";
	}
	if (error instanceof SubmitStageUnverifiedError) {
		return "SUBMIT_STAGE_UNVERIFIED";
	}
	if (error instanceof SubmitProhibitedError) return "SUBMIT_PROHIBITED";
	if (error instanceof BrowserElementOperationError) {
		return "ELEMENT_OPERATION_CDP_FAILED";
	}
	if (error instanceof BrowserFormInvalidError) return "FORM_INVALID";
	if (error instanceof BrowserElementError) return "ELEMENT_UNAVAILABLE";
	if (error instanceof NavigationPolicyError) return "NAVIGATION_POLICY";
	if (error instanceof SubmissionNotAuthorizedError) {
		return "SUBMISSION_NOT_AUTHORIZED";
	}
	if (error instanceof SubmissionResultUncertainError) {
		return "SUBMISSION_RESULT_UNCERTAIN";
	}
	if (error instanceof SubmissionEvidenceError) {
		return "EVIDENCE_CAPTURE_FAILED";
	}
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

function isFunctionCall(value: JsonObject): value is JsonObject & FunctionCall {
	return (
		value.type === "function_call" &&
		typeof value.call_id === "string" &&
		value.call_id.length > 0 &&
		typeof value.name === "string" &&
		typeof value.arguments === "string"
	);
}

type ToolErrorCode = keyof typeof TOOL_ERROR_GUIDANCE;

function toolError(
	code: ToolErrorCode,
	details: JsonObject = {},
): ToolExecution {
	return {
		output: JSON.stringify({
			error: code,
			...details,
			guidance: TOOL_ERROR_GUIDANCE[code],
		}),
		errorCode: code,
	};
}

function failed(reasonCode: string, retryable: boolean): AgentRunResult {
	return {
		outcome: "failed",
		reasonCode,
		reason:
			"The agent could not complete the job within its configured limits.",
		retryable,
	};
}

/**
 * Strips the fields the model must never see: the run token that carries the
 * execution right, and the human approval record, which names the operator and
 * the dry-run it was granted against. Neither is an input to filling a form,
 * and page content reaching the model must never be able to quote them back.
 * The pre-submit reviewer receives only `payload.formValues`, so the approval
 * never reaches it either.
 */
function withoutTrustedOnlyFields(job: Job): Omit<Job, "runToken"> {
	const { runToken: _runToken, payload, ...rest } = job;
	const { [SEND_APPROVAL_KEY]: _approval, ...safePayload } = payload;
	return { ...rest, payload: safePayload };
}
