import type { AgentRunInput, AgentRunResult } from "./agent-runtime";

const MAX_RESULT_BYTES = 16 * 1024;

export interface AgentExecutor {
	execute(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface AgentRunnerBinding {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class AgentExecutionError extends Error {
	constructor(
		readonly reasonCode: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "AgentExecutionError";
	}
}

export class ServiceBindingAgentExecutor implements AgentExecutor {
	constructor(private readonly runner: AgentRunnerBinding) {}

	async execute(input: AgentRunInput): Promise<AgentRunResult> {
		let response: Response;
		try {
			response = await this.runner.fetch("https://agent-runner.internal/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
		} catch {
			throw new AgentExecutionError(
				"AGENT_RUNNER_UNAVAILABLE",
				"The agent runner could not be reached.",
				true,
			);
		}

		if (!response.ok) {
			throw new AgentExecutionError(
				"AGENT_RUNNER_REJECTED",
				`The agent runner returned status ${response.status}.`,
				response.status === 429 || response.status >= 500,
			);
		}
		const contentLength = Number(response.headers.get("Content-Length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_RESULT_BYTES) {
			throw invalidResult();
		}

		let rawResult: string;
		try {
			rawResult = await response.text();
		} catch {
			throw invalidResult();
		}
		if (new TextEncoder().encode(rawResult).byteLength > MAX_RESULT_BYTES) {
			throw invalidResult();
		}

		let value: unknown;
		try {
			value = JSON.parse(rawResult);
		} catch {
			throw invalidResult();
		}

		return parseAgentRunResult(value);
	}
}

export function parseAgentRunResult(value: unknown): AgentRunResult {
	if (!isRecord(value) || typeof value.outcome !== "string") {
		throw invalidResult();
	}

	switch (value.outcome) {
		case "sent":
			return { outcome: "sent", formUrl: requireString(value.formUrl, 2_048) };
		case "prohibited":
			return {
				outcome: "prohibited",
				formUrl:
					value.formUrl === null ? null : requireString(value.formUrl, 2_048),
				reasonCode: requireReasonCode(value.reasonCode),
				reason: requireString(value.reason, 1_000),
			};
		case "uncertain":
			return {
				outcome: "uncertain",
				reasonCode: requireReasonCode(value.reasonCode),
				reason: requireString(value.reason, 1_000),
			};
		case "failed":
			if (typeof value.retryable !== "boolean") {
				throw invalidResult();
			}
			return {
				outcome: "failed",
				reasonCode: requireReasonCode(value.reasonCode),
				reason: requireString(value.reason, 1_000),
				retryable: value.retryable,
			};
		default:
			throw invalidResult();
	}
}

function invalidResult(): AgentExecutionError {
	return new AgentExecutionError(
		"AGENT_RESULT_INVALID",
		"The agent runner returned an invalid result.",
		false,
	);
}

function requireString(value: unknown, maxLength: number): string {
	if (typeof value !== "string" || !value || value.length > maxLength) {
		throw invalidResult();
	}
	return value;
}

function requireReasonCode(value: unknown): string {
	const reasonCode = requireString(value, 64);
	if (!/^[A-Z][A-Z0-9_]*$/.test(reasonCode)) {
		throw invalidResult();
	}
	return reasonCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
