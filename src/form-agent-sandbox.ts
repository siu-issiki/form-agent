import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox";
import {
	AgentToolGateway,
	AgentToolInputError,
	type AgentToolScope,
} from "./agent-tool-service";
import {
	BrowserToolCoordinator,
	BrowserToolInputError,
	type BrowserToolName,
	type BrowserToolParams,
} from "./browser-tool-handler";
import { BrowserUsePlaywrightDriver } from "./browser-use-playwright-driver";
import type { Job } from "./job";
import {
	NavigationPolicyError,
	SubmissionNotAuthorizedError,
	SubmissionResultUncertainError,
} from "./restricted-browser";

const AGENT_TOOL_HOST = "agent-tools.internal";
const OPENAI_HOST = "api.openai.com";
const MAX_PROVIDER_BODY_BYTES = 128 * 1_024;
const MAX_BROWSER_TOOL_BODY_BYTES = 16 * 1_024;
const MAX_PROVIDER_REQUESTS_LIMIT = 32;
const MAX_PROVIDER_OUTPUT_TOKENS_LIMIT = 8_192;

interface OpenAiScope extends AgentToolScope {
	model: string;
	maxRequests: number;
	maxOutputTokens: number;
}

export interface FormAgentSandboxEnv {
	DB: D1Database;
	SANDBOX: DurableObjectNamespace<FormAgentSandbox>;
	OPENAI_API_KEY?: string;
	BROWSER_USE_API_KEY?: string;
}

export class FormAgentSandbox extends Sandbox<FormAgentSandboxEnv> {
	#browserTools: BrowserToolCoordinator | undefined;

	enableInternet = false;
	interceptHttps = true;
	allowedHosts = [AGENT_TOOL_HOST, OPENAI_HOST];
	sleepAfter = "1m";

	executeBrowserTool(
		jobId: string,
		runToken: string,
		tool: BrowserToolName,
		params: BrowserToolParams,
	): Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }> {
		if (!this.env.BROWSER_USE_API_KEY) {
			throw new Error("Browser Use is not configured");
		}
		this.#browserTools ??= new BrowserToolCoordinator(this.env.DB, (job) =>
			BrowserUsePlaywrightDriver.connect(
				this.env.BROWSER_USE_API_KEY ?? "",
				job,
			),
		);
		return this.#browserTools.execute(jobId, runToken, tool, params);
	}

	async closeBrowser(): Promise<void> {
		const browserTools = this.#browserTools;
		this.#browserTools = undefined;
		await browserTools?.close();
	}
}

FormAgentSandbox.outboundHandlers = {
	agentTools: (request, env, context) => {
		const scope = parseBrowserToolScope(context.params);
		return scope
			? handleAgentToolRequest(
					request,
					new AgentToolGateway((env as FormAgentSandboxEnv).DB),
					scope,
					(tool, params) =>
						getSandbox(
							(env as FormAgentSandboxEnv).SANDBOX,
							scope.sandboxId,
						).executeBrowserTool(scope.jobId, scope.runToken, tool, params),
				)
			: toolJson({ error: "INVALID_SCOPE" }, 403);
	},
	openai: (request, env, context) => {
		const scope = parseOpenAiScope(context.params);
		return scope
			? proxyOpenAiRequest(
					request,
					(env as FormAgentSandboxEnv).OPENAI_API_KEY,
					scope,
					() =>
						new AgentToolGateway(
							(env as FormAgentSandboxEnv).DB,
						).claimProviderRequest(
							scope.jobId,
							scope.runToken,
							scope.maxRequests,
						),
				)
			: toolJson({ error: "INVALID_SCOPE" }, 403);
	},
};

export { ContainerProxy };
export const FORM_AGENT_TOOL_HOST = AGENT_TOOL_HOST;
export const FORM_AGENT_OPENAI_HOST = OPENAI_HOST;

export async function handleAgentToolRequest(
	request: Request,
	tools: AgentToolGateway,
	scope: AgentToolScope,
	browserTool?: (
		tool: BrowserToolName,
		params: BrowserToolParams,
	) => Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }>,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/job") {
			return toolResult(await tools.find(scope.jobId, scope.runToken), 404);
		}
		const browserToolName = browserToolNameFor(request.method, url.pathname);
		if (browserToolName && browserTool) {
			const params =
				request.method === "GET"
					? {}
					: await readJsonObject(request, MAX_BROWSER_TOOL_BODY_BYTES);
			return toolJson(await browserTool(browserToolName, params), 200);
		}
		return toolJson({ error: "NOT_FOUND" }, 404);
	} catch (error) {
		if (error instanceof RequestTooLargeError) {
			return toolJson({ error: "REQUEST_TOO_LARGE" }, 413);
		}
		if (
			error instanceof AgentToolInputError ||
			error instanceof BrowserToolInputError ||
			error instanceof NavigationPolicyError ||
			error instanceof SyntaxError
		) {
			return toolJson({ error: "INVALID_REQUEST" }, 400);
		}
		if (
			error instanceof SubmissionNotAuthorizedError ||
			error instanceof SubmissionResultUncertainError
		) {
			return toolJson({ error: "JOB_STATE_CONFLICT" }, 409);
		}
		return toolJson({ error: "TOOL_UNAVAILABLE" }, 503);
	}
}

interface BrowserToolScope extends AgentToolScope {
	sandboxId: string;
}

function parseBrowserToolScope(value: unknown): BrowserToolScope | null {
	const scope = parseToolScope(value);
	if (
		!scope ||
		typeof value !== "object" ||
		value === null ||
		!("sandboxId" in value) ||
		typeof value.sandboxId !== "string" ||
		!/^job-[a-f0-9]{48}$/.test(value.sandboxId)
	) {
		return null;
	}
	return { ...scope, sandboxId: value.sandboxId };
}

function browserToolNameFor(
	method: string,
	path: string,
): BrowserToolName | null {
	const routes: Record<string, { method: string; tool: BrowserToolName }> = {
		"/browser/navigate": { method: "POST", tool: "navigate" },
		"/browser/observe": { method: "GET", tool: "observe" },
		"/browser/click": { method: "POST", tool: "click" },
		"/browser/fill": { method: "POST", tool: "fill" },
		"/browser/select": { method: "POST", tool: "select" },
		"/browser/submit": { method: "POST", tool: "submit" },
	};
	const route = routes[path];
	return route?.method === method ? route.tool : null;
}

export async function proxyOpenAiRequest(
	request: Request,
	apiKey: string | undefined,
	scope: OpenAiScope,
	claimRequest: () => Promise<boolean>,
	upstreamFetch: typeof fetch = fetch,
): Promise<Response> {
	const url = new URL(request.url);
	if (
		request.method !== "POST" ||
		url.hostname !== OPENAI_HOST ||
		(url.pathname !== "/v1/responses" &&
			url.pathname !== "/v1/chat/completions")
	) {
		return toolJson({ error: "PROVIDER_REQUEST_DENIED" }, 403);
	}
	if (!apiKey) {
		return toolJson({ error: "PROVIDER_NOT_CONFIGURED" }, 503);
	}
	if (!isOpenAiScope(scope)) {
		return toolJson({ error: "INVALID_SCOPE" }, 403);
	}

	let body: Record<string, unknown>;
	try {
		body = await readJsonObject(request, MAX_PROVIDER_BODY_BYTES);
	} catch (error) {
		return toolJson(
			{
				error:
					error instanceof RequestTooLargeError
						? "REQUEST_TOO_LARGE"
						: "PROVIDER_REQUEST_INVALID",
			},
			error instanceof RequestTooLargeError ? 413 : 400,
		);
	}
	if (body.model !== scope.model || !hasOnlyFunctionTools(body.tools)) {
		return toolJson({ error: "PROVIDER_REQUEST_DENIED" }, 403);
	}
	if (url.pathname === "/v1/responses") {
		if (
			!validOptionalTokenLimit(body.max_output_tokens, scope.maxOutputTokens)
		) {
			return toolJson({ error: "PROVIDER_REQUEST_DENIED" }, 403);
		}
		body.max_output_tokens =
			typeof body.max_output_tokens === "number"
				? body.max_output_tokens
				: scope.maxOutputTokens;
	} else {
		if (
			(body.n !== undefined && body.n !== 1) ||
			!validOptionalTokenLimit(
				body.max_completion_tokens,
				scope.maxOutputTokens,
			) ||
			!validOptionalTokenLimit(body.max_tokens, scope.maxOutputTokens)
		) {
			return toolJson({ error: "PROVIDER_REQUEST_DENIED" }, 403);
		}
		const requestedLimit =
			typeof body.max_completion_tokens === "number"
				? body.max_completion_tokens
				: body.max_tokens;
		delete body.max_tokens;
		body.n = 1;
		body.max_completion_tokens =
			typeof requestedLimit === "number"
				? requestedLimit
				: scope.maxOutputTokens;
	}
	if (!(await claimRequest())) {
		return toolJson({ error: "PROVIDER_REQUEST_LIMIT_REACHED" }, 429);
	}

	url.protocol = "https:";
	url.port = "";
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${apiKey}`);
	headers.set("content-type", "application/json");
	headers.delete("cookie");
	headers.delete("proxy-authorization");
	headers.delete("content-length");
	return upstreamFetch(
		new Request(url, {
			method: request.method,
			headers,
			body: JSON.stringify(body),
			redirect: "manual",
			signal: request.signal,
		}),
	);
}

function parseOpenAiScope(value: unknown): OpenAiScope | null {
	return isOpenAiScope(value) ? value : null;
}

function isOpenAiScope(value: unknown): value is OpenAiScope {
	return (
		typeof value === "object" &&
		value !== null &&
		"jobId" in value &&
		typeof value.jobId === "string" &&
		value.jobId.length > 0 &&
		value.jobId.length <= 128 &&
		"runToken" in value &&
		typeof value.runToken === "string" &&
		value.runToken.length > 0 &&
		value.runToken.length <= 128 &&
		"model" in value &&
		typeof value.model === "string" &&
		value.model.length > 0 &&
		value.model.length <= 128 &&
		"maxRequests" in value &&
		Number.isInteger(value.maxRequests) &&
		(value.maxRequests as number) >= 1 &&
		(value.maxRequests as number) <= MAX_PROVIDER_REQUESTS_LIMIT &&
		"maxOutputTokens" in value &&
		Number.isInteger(value.maxOutputTokens) &&
		(value.maxOutputTokens as number) >= 1 &&
		(value.maxOutputTokens as number) <= MAX_PROVIDER_OUTPUT_TOKENS_LIMIT
	);
}

function parseToolScope(value: unknown): AgentToolScope | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("jobId" in value) ||
		!("runToken" in value) ||
		typeof value.jobId !== "string" ||
		typeof value.runToken !== "string"
	) {
		return null;
	}
	return { jobId: value.jobId, runToken: value.runToken };
}

async function readJsonObject(
	request: Request,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	if (!request.headers.get("content-type")?.startsWith("application/json")) {
		throw new SyntaxError();
	}
	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new RequestTooLargeError();
	}
	if (!request.body) {
		throw new SyntaxError();
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new RequestTooLargeError();
		}
		chunks.push(value);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SyntaxError();
	}
	return parsed as Record<string, unknown>;
}

function hasOnlyFunctionTools(value: unknown): boolean {
	if (value === undefined) {
		return true;
	}
	return (
		Array.isArray(value) &&
		value.length <= 16 &&
		value.every(
			(tool) =>
				typeof tool === "object" &&
				tool !== null &&
				"type" in tool &&
				tool.type === "function",
		)
	);
}

function validOptionalTokenLimit(value: unknown, maximum: number): boolean {
	return (
		value === undefined ||
		(Number.isInteger(value) &&
			(value as number) >= 1 &&
			(value as number) <= maximum)
	);
}

function toolResult(value: Job | null, missingStatus: number): Response {
	if (!value) {
		return toolJson({ error: "JOB_STATE_CONFLICT" }, missingStatus);
	}
	const { runToken: _, ...safeJob } = value;
	return toolJson({ job: safeJob }, 200);
}

function toolJson(value: unknown, status: number): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

class RequestTooLargeError extends Error {}
