import {
	CORRECTION_TURNS,
	MAX_PROVIDER_REQUESTS,
	MAX_TURNS,
} from "./agent-budget";
import type { AgentExecutor } from "./agent-executor";
import type { AgentRunInput, AgentRunResult } from "./agent-runtime";
import {
	createToolCallContext,
	describeToolFailure,
	diagnosticToolName,
	executeToolCall,
	type FunctionCall,
} from "./agent-tool-call";
import type { AgentToolDiagnosticCode } from "./agent-tool-diagnostic";
import {
	AGENT_TOOLS,
	INITIAL_AGENT_TOOLS,
	systemPrompt,
} from "./agent-tool-schema";
import {
	type BrowserDriverFactory,
	BrowserToolCoordinator,
} from "./browser-tool-handler";
import { BrowserUseCdpDriver } from "./browser-use-cdp-driver";
import { D1JobStore } from "./d1-job-store";
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
import type { SubmitReviewer } from "./restricted-browser";
import { SEND_APPROVAL_KEY } from "./send-approval";
import type { EvidenceObjectStore } from "./submission-evidence";
import { ResponsesSubmitReviewer } from "./submit-reviewer";

const RUN_METRICS_WRITE_TIMEOUT_MS = 2_000;
const MAX_PROVIDER_OUTPUT_TOKENS = 4_096;
const MAX_PROVIDER_REQUEST_BYTES = 512 * 1_024;
const MAX_JOB_PROMPT_LENGTH = 64_000;

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
				createToolCallContext({
					coordinator,
					job: input.job,
					runToken: input.runToken,
					signal,
					db: this.#db,
					dryRun,
					turn: turn + 1,
					allowedToolNames: tools.map((tool) => tool.name),
				}),
			);
			if (execution.kind === "error" || execution.kind === "review_denied") {
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
			switch (execution.kind) {
				case "finished":
					return execution.result;
				case "review_denied":
					if (!correctionTurnsGranted) {
						// The single correction the review allows must not be cut
						// short by a denial that lands near the turn limit.
						correctionTurnsGranted = true;
						maxTurns += CORRECTION_TURNS;
					}
					break;
				case "succeeded":
					if (execution.tool === "observe") {
						hasObservedPage = true;
						observations += 1;
					}
					break;
				case "error":
					break;
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

/**
 * Kept as the named entry point for the diagnostic classification, which now
 * lives with the rest of the tool-call handling. `describeToolFailure` decides
 * the code and the disposition together, so there is only one enumeration of
 * the error types to keep in step.
 */
export function classifyToolDiagnostic(
	error: unknown,
): AgentToolDiagnosticCode {
	return describeToolFailure(error).diagnosticCode;
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
