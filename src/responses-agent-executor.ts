import { AgentExecutionError, type AgentExecutor } from "./agent-executor";
import type { AgentRunInput, AgentRunResult } from "./agent-runtime";
import {
	type BrowserDriverFactory,
	BrowserToolCoordinator,
	BrowserToolInputError,
	type BrowserToolName,
} from "./browser-tool-handler";
import { BrowserUseCdpDriver } from "./browser-use-cdp-driver";
import { D1JobStore } from "./d1-job-store";
import type { Job } from "./job";
import {
	assertAllowedTargetUrl,
	BrowserElementError,
	NavigationPolicyError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
} from "./restricted-browser";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_TURNS = 12;
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
	model: string;
	openAiApiKey: string;
	browserUseApiKey: string;
	fetcher?: typeof fetch;
	createBrowserDriver?: (
		apiKey: string,
		job: Job,
	) => ReturnType<BrowserDriverFactory>;
}

interface ToolExecution {
	output: string;
	result?: AgentRunResult;
}

export class ResponsesAgentExecutor implements AgentExecutor {
	readonly #db: D1Database;
	readonly #model: string;
	readonly #openAiApiKey: string;
	readonly #browserUseApiKey: string;
	readonly #fetcher: typeof fetch;
	readonly #createBrowserDriver: (
		apiKey: string,
		job: Job,
	) => ReturnType<BrowserDriverFactory>;

	constructor(options: ResponsesAgentExecutorOptions) {
		if (!options.model || options.model.length > 128) {
			throw new Error("Invalid agent model");
		}
		if (!options.openAiApiKey || !options.browserUseApiKey) {
			throw new Error("Agent provider credentials are required");
		}
		this.#db = options.db;
		this.#model = options.model;
		this.#openAiApiKey = options.openAiApiKey;
		this.#browserUseApiKey = options.browserUseApiKey;
		this.#fetcher = options.fetcher ?? fetch;
		this.#createBrowserDriver =
			options.createBrowserDriver ?? BrowserUseCdpDriver.connect;
	}

	async execute(
		input: AgentRunInput,
		signal: AbortSignal,
	): Promise<AgentRunResult> {
		const coordinator = new BrowserToolCoordinator(this.#db, (job) =>
			this.#createBrowserDriver(this.#browserUseApiKey, job),
		);
		const abort = () => {
			void coordinator.close().catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });

		try {
			return await this.#run(input, coordinator, signal);
		} finally {
			signal.removeEventListener("abort", abort);
			await coordinator.close().catch(() => undefined);
		}
	}

	async #run(
		input: AgentRunInput,
		coordinator: BrowserToolCoordinator,
		signal: AbortSignal,
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
				instructions: systemPrompt(),
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
				response.status === 429 || response.status >= 500,
			);
		}

		const value = await readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES);
		if (!isRecord(value)) {
			throw invalidProviderResponse();
		}
		return value;
	}
}

async function executeToolCall(
	call: FunctionCall,
	coordinator: BrowserToolCoordinator,
	job: Job,
	runToken: string,
	signal: AbortSignal,
	db: D1Database,
): Promise<ToolExecution> {
	throwIfAborted(signal);
	let params: JsonObject;
	try {
		const value: unknown = JSON.parse(call.arguments);
		if (!isRecord(value)) throw new SyntaxError();
		params = value;
	} catch {
		return toolError("INVALID_TOOL_INPUT");
	}

	if (call.name === "finish") {
		const result = parseFinishResult(params, job.targetDomain);
		return result
			? { output: JSON.stringify({ outcome: result.outcome }), result }
			: toolError("INVALID_TOOL_INPUT");
	}

	const tool = browserToolName(call.name);
	if (!tool) return toolError("UNKNOWN_TOOL");
	try {
		const value = await coordinator.execute(job.id, runToken, tool, params);
		if (tool === "submit" && "job" in value) {
			const result = terminalResultFromJob(value.job);
			if (result) {
				return { output: JSON.stringify({ status: value.job.status }), result };
			}
			return toolError("SUBMIT_RESULT_NOT_PERSISTED");
		}
		return { output: JSON.stringify(value) };
	} catch (error) {
		throwIfAborted(signal);
		if (
			error instanceof SubmissionResultUncertainError ||
			error instanceof SubmissionNotAuthorizedError
		) {
			const persisted = await new D1JobStore(db).find(job.id);
			const result =
				persisted?.runToken === runToken && terminalResultFromJob(persisted);
			return result
				? { output: JSON.stringify({ status: persisted.status }), result }
				: toolError("JOB_STATE_CONFLICT");
		}
		if (
			error instanceof BrowserToolInputError ||
			error instanceof BrowserElementError ||
			error instanceof NavigationPolicyError ||
			error instanceof SyntaxError
		) {
			return toolError("INVALID_TOOL_INPUT");
		}
		return toolError("TOOL_UNAVAILABLE");
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

function parseFinishResult(
	params: JsonObject,
	targetDomain: string,
): AgentRunResult | null {
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
		return null;
	}

	if (outcome === "prohibited" && retryable === null) {
		try {
			if (formUrl) assertAllowedTargetUrl(formUrl, targetDomain);
		} catch {
			return null;
		}
		return { outcome, formUrl, reasonCode, reason };
	}
	if (outcome === "uncertain" && formUrl === null && retryable === null) {
		return { outcome, reasonCode, reason };
	}
	if (
		outcome === "failed" &&
		formUrl === null &&
		typeof retryable === "boolean"
	) {
		return { outcome, reasonCode, reason, retryable };
	}
	return null;
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

function systemPrompt(): string {
	return [
		"You operate one company's inquiry form using only the provided tools.",
		"Stay on the persisted target domain. Never use another company or arbitrary URL.",
		"Observe the page before acting and check for sales, solicitation, or purpose restrictions.",
		"If outreach is prohibited or the form purpose is incompatible, do not submit; call finish with prohibited.",
		"Fill only values present in the job payload. Never invent required personal or company data.",
		"Before submit, re-observe and verify the target, all values, required fields, and that submit has not been attempted.",
		"Use submit exactly once. Only submit can report sent.",
		"If meaning or submission outcome is unclear, call finish with uncertain. For technical failures, call finish with failed.",
	].join(" ");
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
		"Inspect the current page URL, forms, fields, choices, and prohibition text.",
		{},
	),
	functionTool("click", "Click a non-submit element on the current page.", {
		elementId: { type: "string", pattern: "^fa-[a-z0-9-]+$", maxLength: 64 },
	}),
	functionTool("fill", "Fill one text-like form field.", {
		elementId: { type: "string", pattern: "^fa-[a-z0-9-]+$", maxLength: 64 },
		value: { type: "string", maxLength: 8_192 },
	}),
	functionTool("select", "Select a dropdown, radio, or checkbox value.", {
		elementId: { type: "string", pattern: "^fa-[a-z0-9-]+$", maxLength: 64 },
		value: { type: "string", maxLength: 2_048 },
	}),
	functionTool(
		"submit",
		"Submit once after confirming the target, required fields, values, and absence of sales prohibitions.",
		{
			elementId: {
				type: "string",
				pattern: "^fa-[a-z0-9-]+$",
				maxLength: 64,
			},
		},
	),
	functionTool(
		"finish",
		"Finish without sending when prohibited, uncertain, or technically failed. This tool cannot report sent.",
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
