import { AgentExecutionError, type AgentExecutor } from "./agent-executor";
import type { AgentRunInput, AgentRunResult } from "./agent-runtime";
import {
	type BrowserDriverFactory,
	BrowserToolCoordinator,
	BrowserToolInputError,
	type BrowserToolName,
	BrowserToolSetupError,
} from "./browser-tool-handler";
import { BrowserUseCdpPayloadTooLargeError } from "./browser-use-cdp";
import { BrowserUseCdpDriver } from "./browser-use-cdp-driver";
import {
	type AgentToolDiagnosticCode,
	type AgentToolDiagnosticStage,
	type AgentToolDiagnosticToolName,
	D1JobStore,
} from "./d1-job-store";
import type { Job } from "./job";
import {
	assertAllowedTargetUrl,
	BrowserElementError,
	BrowserFormInvalidError,
	NavigationPolicyError,
	type ProhibitedReasonCode,
	SubmissionEvidenceError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
} from "./restricted-browser";
import type { EvidenceObjectStore } from "./submission-evidence";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_TURNS = 16;
const MAX_PROVIDER_REQUESTS = 16;
const MAX_PROVIDER_OUTPUT_TOKENS = 4_096;
const MAX_PROVIDER_REQUEST_BYTES = 128 * 1_024;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1_024;
const MAX_JOB_PROMPT_LENGTH = 64_000;

type JsonObject = Record<string, unknown>;

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
	openAiApiKey: string;
	browserUseApiKey: string;
	dryRun?: boolean;
	fetcher?: typeof fetch;
	createBrowserDriver?: (
		apiKey: string,
		job: Job,
		dryRun: boolean,
	) => ReturnType<BrowserDriverFactory>;
}

interface ToolExecution {
	output: string;
	result?: AgentRunResult;
}

export class ResponsesAgentExecutor implements AgentExecutor {
	readonly terminationGraceMs = 30_000;

	readonly #db: D1Database;
	readonly #evidenceStore: EvidenceObjectStore;
	readonly #model: string;
	readonly #openAiApiKey: string;
	readonly #browserUseApiKey: string;
	readonly #dryRun: boolean;
	readonly #fetcher: typeof fetch;
	readonly #createBrowserDriver: (
		apiKey: string,
		job: Job,
		dryRun: boolean,
	) => ReturnType<BrowserDriverFactory>;

	constructor(options: ResponsesAgentExecutorOptions) {
		if (!options.model || options.model.length > 128) {
			throw new Error("Invalid agent model");
		}
		if (!options.openAiApiKey || !options.browserUseApiKey) {
			throw new Error("Agent provider credentials are required");
		}
		this.#db = options.db;
		this.#evidenceStore = options.evidenceStore;
		this.#model = options.model;
		this.#openAiApiKey = options.openAiApiKey;
		this.#browserUseApiKey = options.browserUseApiKey;
		this.#dryRun = options.dryRun ?? false;
		const fetcher = options.fetcher ?? fetch;
		this.#fetcher = (resource, init) => fetcher(resource, init);
		this.#createBrowserDriver =
			options.createBrowserDriver ?? BrowserUseCdpDriver.connect;
	}

	async execute(
		input: AgentRunInput,
		signal: AbortSignal,
	): Promise<AgentRunResult> {
		const dryRun = isJobDryRun(input.job.payload, this.#dryRun);
		const coordinator = new BrowserToolCoordinator(
			this.#db,
			(job) => this.#createBrowserDriver(this.#browserUseApiKey, job, dryRun),
			this.#evidenceStore,
		);
		const abort = () => {
			void coordinator.close().catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });

		try {
			return await this.#run(input, coordinator, signal, dryRun);
		} finally {
			signal.removeEventListener("abort", abort);
			await coordinator.close().catch(() => undefined);
		}
	}

	async #run(
		input: AgentRunInput,
		coordinator: BrowserToolCoordinator,
		signal: AbortSignal,
		dryRun: boolean,
	): Promise<AgentRunResult> {
		const safeJob = withoutRunToken(input.job);
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

		for (let turn = 0; turn < MAX_TURNS; turn += 1) {
			throwIfAborted(signal);
			const body = JSON.stringify({
				model: this.#model,
				instructions: systemPrompt(dryRun),
				input: history,
				tools: AGENT_TOOLS,
				tool_choice: "required",
				parallel_tool_calls: false,
				max_output_tokens: MAX_PROVIDER_OUTPUT_TOKENS,
				reasoning: { effort: "low" },
				store: false,
				include: ["reasoning.encrypted_content"],
			});
			if (
				new TextEncoder().encode(body).byteLength > MAX_PROVIDER_REQUEST_BYTES
			) {
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

			const response = await this.#request(body, signal);
			const output = readResponseOutput(response);
			const calls = output.filter(isFunctionCall);
			const call = calls[0];
			if (calls.length !== 1 || !call) {
				return failed("AGENT_DID_NOT_FINISH", false);
			}

			history.push(...output);
			const execution = await executeToolCall(
				call,
				coordinator,
				input.job,
				input.runToken,
				signal,
				this.#db,
				dryRun,
				turn + 1,
			);
			if (execution.result) return execution.result;
			history.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: execution.output,
			});
		}

		return failed("AGENT_TURN_LIMIT", false);
	}

	async #request(body: string, signal: AbortSignal): Promise<JsonObject> {
		let response: Response;
		try {
			response = await this.#fetcher(OPENAI_RESPONSES_URL, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.#openAiApiKey}`,
					"content-type": "application/json",
				},
				body,
				redirect: "manual",
				signal,
			});
		} catch {
			throwIfAborted(signal);
			throw new AgentExecutionError(
				"PROVIDER_UNAVAILABLE",
				"The model provider request failed.",
				true,
			);
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new AgentExecutionError(
				response.status === 429
					? "PROVIDER_RATE_LIMITED"
					: "PROVIDER_REQUEST_REJECTED",
				"The model provider rejected the request.",
				[408, 409, 429].includes(response.status) || response.status >= 500,
			);
		}

		const value = await readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES);
		if (!isRecord(value)) {
			throw invalidProviderResponse();
		}
		return value;
	}
}

export function isJobDryRun(
	payload: Record<string, unknown>,
	legacyDryRun: boolean,
): boolean {
	const effectiveDryRun = payload._formAgentEffectiveDryRun;
	return (
		effectiveDryRun === true ||
		payload._formAgentDryRun === true ||
		(effectiveDryRun === undefined && legacyDryRun)
	);
}

async function executeToolCall(
	call: FunctionCall,
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

	if (call.name === "finish") {
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
				await coordinator.validateProhibited(
					job.id,
					runToken,
					parsed.result.reasonCode,
					parsed.result.formUrl,
				);
			} catch {
				await recordToolDiagnostic(
					db,
					job,
					runToken,
					turn,
					"finish",
					"finish_validation",
					"FINISH_PROHIBITION_NOT_VERIFIED",
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
			await coordinator.validateSubmit(job.id, runToken, params);
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
					reason:
						"Dry-run validated the current submit control and stopped before submission authorization or browser submission.",
				},
			};
		}
		const value = await coordinator.execute(job.id, runToken, tool, params);
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
		return { output: JSON.stringify(value) };
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
			error instanceof BrowserToolSetupError ? error.stage : tool,
			diagnosticCode,
		);
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
		if (
			originalError instanceof BrowserToolInputError ||
			originalError instanceof BrowserElementError ||
			originalError instanceof NavigationPolicyError ||
			originalError instanceof SyntaxError
		) {
			return toolError("INVALID_TOOL_INPUT");
		}
		throw new AgentExecutionError(
			"BROWSER_TOOL_UNAVAILABLE",
			"The browser provider or tool became unavailable.",
			true,
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
	if (value === "finish") return value;
	return browserToolName(value) ?? "unknown";
}

export function classifyToolDiagnostic(
	error: unknown,
): AgentToolDiagnosticCode {
	if (error instanceof BrowserUseCdpPayloadTooLargeError) {
		return "PAYLOAD_TOO_LARGE";
	}
	if (error instanceof BrowserToolInputError || error instanceof SyntaxError) {
		return "TOOL_INPUT_INVALID";
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
		case "Browser Use CDP connection failed":
			return "CDP_CONNECTION_FAILED";
		case "Browser Use CDP connection is closed":
		case "Browser Use CDP connection closed":
			return "CDP_CONNECTION_CLOSED";
		case "Browser Use CDP command timed out":
			return "CDP_COMMAND_TIMEOUT";
		case "Browser Use CDP command could not be sent":
			return "CDP_COMMAND_SEND_FAILED";
		case "Browser Use CDP command failed":
			return "CDP_COMMAND_FAILED";
		case "Invalid Browser Use CDP endpoint":
			return "CDP_ENDPOINT_INVALID";
		case "Browser Use API key is required":
			return "BROWSER_CREDENTIALS_MISSING";
		case "Browser domain scope cannot be changed":
		case "Browser host scope cannot be changed":
		case "Browser domain scope is not configured":
			return "SCOPE_CONFIGURATION_FAILED";
		case "Browser navigation failed":
			return "NAVIGATION_FAILED";
		case "Browser page did not become ready":
			return "PAGE_NOT_READY";
		case "Browser DOM discovery failed":
			return "DOM_DISCOVERY_FAILED";
		case "Browser page evaluation failed":
			return "PAGE_EVALUATION_FAILED";
		case "Browser screenshot failed":
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
			diagnosticCode: "OK";
	  }
	| {
			result: null;
			diagnosticCode:
				| "FINISH_FIELDS_INVALID"
				| "FINISH_FORM_URL_NOT_ALLOWED"
				| "FINISH_OUTCOME_INVALID";
	  };

const PROHIBITED_REASON_CODES = {
	NO_FORM: "NO_FORM_PRESENT",
	NO_FORM_PRESENT: "NO_FORM_PRESENT",
	NO_INQUIRY_FORM: "NO_FORM_PRESENT",
	OUTREACH_PROHIBITED: "SALES_PROHIBITED",
	SALES_PROHIBITED: "SALES_PROHIBITED",
	FORM_PURPOSE_INCOMPATIBLE: "FORM_PURPOSE_INCOMPATIBLE",
} as const;

function parseFinishResult(
	params: JsonObject,
	targetDomain: string,
	allowedHosts: readonly string[],
): FinishParseResult {
	const { outcome, formUrl, reasonCode, reason, retryable } = params;
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
		const prohibitedReasonCode =
			PROHIBITED_REASON_CODES[
				reasonCode as keyof typeof PROHIBITED_REASON_CODES
			];
		if (!prohibitedReasonCode) {
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
			result: { outcome, formUrl, reasonCode: prohibitedReasonCode, reason },
			diagnosticCode: "OK",
		};
	}
	if (outcome === "uncertain" && formUrl === null && retryable === null) {
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
		/^fa-[a-z0-9-]+$/.test(value)
	);
}

function isSubmitActivationStrategy(
	value: unknown,
): value is "dom" | "mouse" | "enter" {
	return value === "dom" || value === "mouse" || value === "enter";
}

function readResponseOutput(value: JsonObject): JsonObject[] {
	if (value.status !== "completed" || !Array.isArray(value.output)) {
		throw invalidProviderResponse();
	}
	if (!value.output.every(isRecord)) throw invalidProviderResponse();
	return value.output;
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

async function readBoundedJson(
	response: Response,
	maxBytes: number,
): Promise<unknown> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw invalidProviderResponse();
	}
	if (!response.body) throw invalidProviderResponse();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw invalidProviderResponse();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw invalidProviderResponse();
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new AgentExecutionError(
			"AGENT_TIMEOUT",
			"The agent execution exceeded its time limit.",
			true,
		);
	}
}

function invalidProviderResponse(): AgentExecutionError {
	return new AgentExecutionError(
		"PROVIDER_RESPONSE_INVALID",
		"The model provider returned an invalid response.",
		true,
	);
}

function toolError(code: string): ToolExecution {
	return { output: JSON.stringify({ error: code }) };
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

function withoutRunToken(job: Job): Omit<Job, "runToken"> {
	const { runToken: _, ...safeJob } = job;
	return safeJob;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function systemPrompt(dryRun: boolean): string {
	const instructions = [
		"You operate one company's inquiry form using only the provided tools.",
		"Stay on the persisted target domain. Never use another company or arbitrary URL.",
		"Observe the page before acting and check for sales, solicitation, or purpose restrictions.",
		"When the inquiry form is on another page, navigate only to an exact URL returned in observe.navigationLinks.",
		"If outreach is prohibited or the form purpose is incompatible, do not submit; call finish with prohibited.",
		"For prohibited, use reasonCode NO_FORM_PRESENT when no inquiry form exists, SALES_PROHIBITED when sales or outreach is prohibited, or FORM_PURPOSE_INCOMPATIBLE when the form purpose is incompatible.",
		"For fill and select, choose only a payloadKey from payload.formValues. The trusted handler resolves its value; never invent personal or company data.",
		"Use select for select elements, checkboxes, and radio controls. Click is only for a non-submit button with type=button.",
		"Before submit, re-observe and verify the target, all values, required fields, and that submit has not been attempted.",
		"Choose submit activationStrategy from the observed DOM: prefer dom for button or input submit controls; use mouse only when a trusted click gesture is required, or enter when keyboard activation is required.",
		"Use submit exactly once. Only submit can report sent.",
		"If meaning or submission outcome is unclear, call finish with uncertain. For technical failures, call finish with failed.",
	];
	if (dryRun) {
		instructions.push(
			"This is a dry-run. Inspect and fill the form, then call submit normally after validation. The trusted handler will intercept submit before authorization or browser submission.",
		);
	}
	return instructions.join(" ");
}

const AGENT_TOOLS = [
	functionTool(
		"navigate",
		"Navigate within the single allowed company domain.",
		{
			url: { type: "string", maxLength: 2_048 },
		},
	),
	functionTool(
		"observe",
		"Inspect the current page URL, allowed navigation links, forms, fields, choices, and prohibition text.",
		{},
	),
	functionTool("click", "Click a non-submit button with type=button.", {
		elementId: { type: "string", pattern: "^fa-[a-z0-9-]+$", maxLength: 64 },
	}),
	functionTool(
		"fill",
		"Fill one text-like form field with a trusted payload.formValues entry.",
		{
			elementId: { type: "string", pattern: "^fa-[a-z0-9-]+$", maxLength: 64 },
			payloadKey: {
				type: "string",
				pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$",
				maxLength: 64,
			},
		},
	),
	functionTool(
		"select",
		"Set a select element, checkbox, or radio control using a trusted payload.formValues entry.",
		{
			elementId: { type: "string", pattern: "^fa-[a-z0-9-]+$", maxLength: 64 },
			payloadKey: {
				type: "string",
				pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$",
				maxLength: 64,
			},
		},
	),
	functionTool(
		"submit",
		"Submit once with a model-selected constrained CDP activation after confirming the target, required fields, values, and absence of sales prohibitions. Prefer DOM activation; mouse coordinates are derived from the live DOM only when explicitly selected.",
		{
			elementId: {
				type: "string",
				pattern: "^fa-[a-z0-9-]+$",
				maxLength: 64,
			},
			activationStrategy: {
				type: "string",
				enum: ["dom", "mouse", "enter"],
			},
		},
	),
	functionTool(
		"finish",
		"Finish without sending when prohibited, uncertain, or technically failed. This tool cannot report sent. For prohibited, use only NO_FORM_PRESENT, SALES_PROHIBITED, or FORM_PURPOSE_INCOMPATIBLE as reasonCode.",
		{
			outcome: { type: "string", enum: ["prohibited", "uncertain", "failed"] },
			formUrl: { type: ["string", "null"], maxLength: 2_048 },
			reasonCode: {
				type: "string",
				pattern: "^[A-Z][A-Z0-9_]{0,63}$",
			},
			reason: { type: "string", minLength: 1, maxLength: 1_000 },
			retryable: { type: ["boolean", "null"] },
		},
	),
] as const;

function functionTool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
) {
	return {
		type: "function",
		name,
		description,
		parameters: {
			type: "object",
			properties,
			required: Object.keys(properties),
			additionalProperties: false,
		},
		strict: true,
	};
}
