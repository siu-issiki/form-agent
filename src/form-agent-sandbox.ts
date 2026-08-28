import { ContainerProxy, Sandbox } from "@cloudflare/sandbox";
import {
	AgentToolGateway,
	AgentToolInputError,
	type AgentToolScope,
} from "./agent-tool-service";
import type { Job } from "./job";

const AGENT_TOOL_HOST = "agent-tools.internal";
const OPENAI_HOST = "api.openai.com";
const MAX_PROVIDER_BODY_BYTES = 128 * 1_024;
const MAX_PROVIDER_REQUESTS_LIMIT = 32;
const MAX_PROVIDER_OUTPUT_TOKENS_LIMIT = 8_192;

interface OpenAiScope extends AgentToolScope {
	model: string;
	maxRequests: number;
	maxOutputTokens: number;
}

export interface FormAgentSandboxEnv {
	DB: D1Database;
	OPENAI_API_KEY?: string;
}

export class FormAgentSandbox extends Sandbox<FormAgentSandboxEnv> {
	enableInternet = false;
	interceptHttps = true;
	allowedHosts = [AGENT_TOOL_HOST, OPENAI_HOST];
	sleepAfter = "1m";
}

FormAgentSandbox.outboundHandlers = {
	agentTools: (request, env, context) => {
		const scope = parseToolScope(context.params);
		return scope
			? handleAgentToolRequest(
					request,
					new AgentToolGateway((env as FormAgentSandboxEnv).DB),
					scope,
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
): Promise<Response> {
	try {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/job") {
			return toolResult(await tools.find(scope.jobId, scope.runToken), 404);
		}
		return toolJson({ error: "NOT_FOUND" }, 404);
	} catch (error) {
		if (error instanceof AgentToolInputError) {
			return toolJson({ error: "INVALID_REQUEST" }, 400);
		}
		return toolJson({ error: "TOOL_UNAVAILABLE" }, 503);
	}
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
