import { AgentExecutionError } from "./agent-executor";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1_024;

export type JsonObject = Record<string, unknown>;

/** Token counts of one provider response. Missing fields count as zero. */
export interface ProviderUsage {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cachedTokens: number;
}

export function providerRequestByteLength(body: string): number {
	return new TextEncoder().encode(body).byteLength;
}

export function readProviderUsage(response: JsonObject): ProviderUsage {
	const usage = isRecord(response.usage) ? response.usage : {};
	const inputDetails = isRecord(usage.input_tokens_details)
		? usage.input_tokens_details
		: {};
	const outputDetails = isRecord(usage.output_tokens_details)
		? usage.output_tokens_details
		: {};
	return {
		inputTokens: tokenCount(usage.input_tokens),
		outputTokens: tokenCount(usage.output_tokens),
		reasoningTokens: tokenCount(outputDetails.reasoning_tokens),
		cachedTokens: tokenCount(inputDetails.cached_tokens),
	};
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.trunc(value)
		: 0;
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
		throw invalidProviderResponse("not_object");
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
		throw invalidProviderResponse("response_too_large");
	}
	if (!response.body) throw invalidProviderResponse("body_missing");

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
				throw invalidProviderResponse("response_too_large");
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
		throw invalidProviderResponse("invalid_json");
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

export function invalidProviderResponse(detail?: string): AgentExecutionError {
	return new AgentExecutionError(
		"PROVIDER_RESPONSE_INVALID",
		"The model provider returned an invalid response.",
		true,
		undefined,
		undefined,
		detail,
	);
}

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduces a provider-supplied string to a fixed-shape token so a status or
 * incompleteness reason can be logged without carrying free text.
 */
function sanitiseDetailToken(value: string): string {
	const token = value
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "")
		.slice(0, 32);
	return token.length > 0 ? token : "other";
}

export function readResponseOutput(value: JsonObject): JsonObject[] {
	if (value.status !== "completed") {
		const incompleteReason =
			value.status === "incomplete" &&
			isRecord(value.incomplete_details) &&
			typeof value.incomplete_details.reason === "string"
				? value.incomplete_details.reason
				: undefined;
		throw invalidProviderResponse(
			incompleteReason !== undefined
				? `incomplete_${sanitiseDetailToken(incompleteReason)}`
				: `status_${sanitiseDetailToken(String(value.status))}`,
		);
	}
	if (!Array.isArray(value.output)) {
		throw invalidProviderResponse("output_missing");
	}
	if (!value.output.every(isRecord)) {
		throw invalidProviderResponse("output_item_invalid");
	}
	return value.output;
}
