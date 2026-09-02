import { AgentExecutionError } from "./agent-executor";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const MAX_TURNS = 16;

/**
 * One provider request per agent turn, plus at most two pre-submit reviews
 * (the first denial allows exactly one correction). The counter is shared by
 * the executor and the reviewer through D1, so both consume the same budget.
 */
export const MAX_PROVIDER_REQUESTS = MAX_TURNS + 2;

export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1_024;

export type JsonObject = Record<string, unknown>;

export function providerRequestByteLength(body: string): number {
	return new TextEncoder().encode(body).byteLength;
}

export async function requestResponses(
	fetcher: typeof fetch,
	apiKey: string,
	body: string,
	signal: AbortSignal,
	options: { maxResponseBytes?: number } = {},
): Promise<JsonObject> {
	const maxResponseBytes =
		options.maxResponseBytes ?? MAX_PROVIDER_RESPONSE_BYTES;
	let response: Response;
	try {
		response = await fetcher(OPENAI_RESPONSES_URL, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
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

	const value = await readBoundedJson(response, maxResponseBytes);
	if (!isRecord(value)) {
		throw invalidProviderResponse();
	}
	return value;
}

export async function readBoundedJson(
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

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new AgentExecutionError(
			"AGENT_TIMEOUT",
			"The agent execution exceeded its time limit.",
			true,
		);
	}
}

export function invalidProviderResponse(): AgentExecutionError {
	return new AgentExecutionError(
		"PROVIDER_RESPONSE_INVALID",
		"The model provider returned an invalid response.",
		true,
	);
}

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
