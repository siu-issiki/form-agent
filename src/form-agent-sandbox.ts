import { ContainerProxy, Sandbox } from "@cloudflare/sandbox";
import {
	AgentToolGateway,
	AgentToolInputError,
	type AgentToolScope,
} from "./agent-tool-service";
import type { Job } from "./job";
import { NavigationPolicyError } from "./restricted-browser";

const AGENT_TOOL_HOST = "agent-tools.internal";
const OPENAI_HOST = "api.openai.com";
const MAX_TOOL_BODY_BYTES = 4_096;

export interface FormAgentSandboxEnv {
	DB: D1Database;
	OPENAI_API_KEY?: string;
}

export class FormAgentSandbox extends Sandbox<FormAgentSandboxEnv> {
	enableInternet = false;
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
	openai: (request, env) =>
		proxyOpenAiRequest(request, (env as FormAgentSandboxEnv).OPENAI_API_KEY),
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
		if (request.method === "POST" && url.pathname === "/submission/claim") {
			return toolResult(
				await tools.claimSubmission(scope.jobId, scope.runToken),
				409,
			);
		}
		if (request.method === "POST" && url.pathname === "/submission/sent") {
			const body = await readToolBody(request);
			return toolResult(
				await tools.recordSent(
					scope.jobId,
					scope.runToken,
					readString(body, "formUrl", 2_048),
				),
				409,
			);
		}
		if (request.method === "POST" && url.pathname === "/submission/uncertain") {
			const body = await readToolBody(request);
			return toolResult(
				await tools.recordUncertain(
					scope.jobId,
					scope.runToken,
					readString(body, "reasonCode", 64),
					readString(body, "reason", 1_000),
				),
				409,
			);
		}
		return toolJson({ error: "NOT_FOUND" }, 404);
	} catch (error) {
		if (error instanceof ToolBodyTooLargeError) {
			return toolJson({ error: "REQUEST_TOO_LARGE" }, 413);
		}
		if (
			error instanceof AgentToolInputError ||
			error instanceof NavigationPolicyError ||
			error instanceof SyntaxError
		) {
			return toolJson({ error: "INVALID_REQUEST" }, 400);
		}
		return toolJson({ error: "TOOL_UNAVAILABLE" }, 503);
	}
}

export function proxyOpenAiRequest(
	request: Request,
	apiKey: string | undefined,
	upstreamFetch: typeof fetch = fetch,
): Promise<Response> | Response {
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

	url.protocol = "https:";
	url.port = "";
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${apiKey}`);
	headers.delete("cookie");
	headers.delete("proxy-authorization");
	return upstreamFetch(
		new Request(url, {
			method: request.method,
			headers,
			body: request.body,
			redirect: "manual",
			signal: request.signal,
		}),
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

async function readToolBody(
	request: Request,
): Promise<Record<string, unknown>> {
	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_TOOL_BODY_BYTES) {
		throw new ToolBodyTooLargeError();
	}
	if (!request.body) {
		throw new AgentToolInputError();
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
		if (totalBytes > MAX_TOOL_BODY_BYTES) {
			await reader.cancel();
			throw new ToolBodyTooLargeError();
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
		throw new AgentToolInputError();
	}
	return parsed as Record<string, unknown>;
}

function readString(
	body: Record<string, unknown>,
	key: string,
	maxLength: number,
): string {
	const value = body[key];
	if (typeof value !== "string" || !value || value.length > maxLength) {
		throw new AgentToolInputError();
	}
	return value;
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

class ToolBodyTooLargeError extends Error {}
