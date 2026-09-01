import { getSandbox } from "@cloudflare/sandbox";
import { AgentExecutionError, type AgentExecutor } from "./agent-executor";
import type { AgentRunInput, AgentRunResult } from "./agent-runtime";
import {
	FORM_AGENT_OPENAI_HOST,
	FORM_AGENT_TOOL_HOST,
	type FormAgentSandbox,
} from "./form-agent-sandbox";
import { assertAllowedTargetUrl } from "./restricted-browser";

const RUNNER_PATH = "/app/runner/index.ts";
const MAX_RUNNER_OUTPUT_BYTES = 64 * 1_024;
const MAX_PROVIDER_REQUESTS = 16;
const MAX_PROVIDER_OUTPUT_TOKENS = 4_096;

interface SandboxProcessLike {
	output(options: {
		encoding: "utf8";
		maxBytes: number;
		signal: AbortSignal;
	}): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
		timedOut: boolean;
		truncated: boolean;
	}>;
	kill(signal?: number): Promise<void>;
}

export interface AgentSandboxLike {
	closeBrowser?(): Promise<void>;
	setAllowedHosts(hosts: string[]): Promise<void>;
	setOutboundByHost(
		host: string,
		handler: string,
		params?: Record<string, unknown>,
	): Promise<void>;
	exec(
		command: [string, ...string[]],
		options: {
			env: Record<string, string>;
			timeout: number;
		},
	): Promise<SandboxProcessLike>;
	destroy(): Promise<void>;
}

type SandboxFactory = (jobId: string) => AgentSandboxLike;

export class SandboxAgentExecutor implements AgentExecutor {
	readonly terminationGraceMs = 30_000;

	constructor(
		private readonly sandboxFor: SandboxFactory,
		private readonly model: string,
	) {
		if (!model || model.length > 128) {
			throw new Error("Invalid agent model");
		}
	}

	async execute(
		input: AgentRunInput,
		signal: AbortSignal,
	): Promise<AgentRunResult> {
		let sandbox: AgentSandboxLike | undefined;
		let process: SandboxProcessLike | undefined;
		let killPromise: Promise<void> | undefined;
		let needsTermination = false;
		let result: AgentRunResult | undefined;
		let executionError: AgentExecutionError | undefined;
		let terminationError: AgentExecutionError | undefined;
		const kill = () => {
			if (process && !killPromise) {
				killPromise = process.kill(9);
			}
			return killPromise;
		};
		const abort = () => {
			needsTermination = true;
			void kill()?.catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });

		try {
			const sandboxId = await sandboxIdForJob(input.job.id);
			if (signal.aborted) {
				throw timeoutError();
			}
			sandbox = this.sandboxFor(sandboxId);
			await sandbox.setAllowedHosts([
				FORM_AGENT_TOOL_HOST,
				FORM_AGENT_OPENAI_HOST,
			]);
			await sandbox.setOutboundByHost(FORM_AGENT_TOOL_HOST, "agentTools", {
				jobId: input.job.id,
				runToken: input.runToken,
				sandboxId,
			});
			await sandbox.setOutboundByHost(FORM_AGENT_OPENAI_HOST, "openai", {
				jobId: input.job.id,
				runToken: input.runToken,
				model: this.model,
				maxRequests: MAX_PROVIDER_REQUESTS,
				maxOutputTokens: MAX_PROVIDER_OUTPUT_TOKENS,
			});
			process = await sandbox.exec(["bun", "run", RUNNER_PATH], {
				env: {
					FORM_AGENT_MODEL: this.model,
					FORM_AGENT_MAX_OUTPUT_TOKENS: String(MAX_PROVIDER_OUTPUT_TOKENS),
					FORM_AGENT_TOOL_BASE_URL: `http://${FORM_AGENT_TOOL_HOST}`,
					OPENAI_API_KEY: "injected-by-worker-outbound-handler",
				},
				timeout: input.maxDurationMs,
			});
			if (signal.aborted) {
				needsTermination = true;
				void kill()?.catch(() => undefined);
				throw timeoutError();
			}
			const output = await process.output({
				encoding: "utf8",
				maxBytes: MAX_RUNNER_OUTPUT_BYTES,
				signal,
			});
			if (output.timedOut || signal.aborted) {
				needsTermination = true;
				void kill()?.catch(() => undefined);
				throw timeoutError();
			}
			if (output.exitCode !== 0) {
				throw new AgentExecutionError(
					"AGENT_RUNNER_EXITED",
					"The isolated agent runner exited unexpectedly.",
					true,
				);
			}
			if (output.truncated) {
				throw invalidResult();
			}
			result = parseRunnerResult(output.stdout, input.job.targetDomain);
		} catch (error) {
			if (error instanceof AgentExecutionError) {
				executionError = error;
			} else {
				executionError = new AgentExecutionError(
					signal.aborted ? "AGENT_TIMEOUT" : "AGENT_SANDBOX_FAILED",
					signal.aborted
						? "The isolated agent runner exceeded its time limit."
						: "The isolated agent runner could not be executed.",
					true,
				);
			}
		} finally {
			signal.removeEventListener("abort", abort);
			if ((needsTermination || signal.aborted) && process) {
				try {
					await kill();
				} catch {
					terminationError = new AgentExecutionError(
						"AGENT_TERMINATION_UNCONFIRMED",
						"The isolated agent runner could not be confirmed stopped.",
						false,
					);
				}
			}
			await sandbox?.closeBrowser?.().catch(() => undefined);
			await sandbox?.destroy().catch(() => undefined);
		}
		if (terminationError) {
			throw terminationError;
		}
		if (executionError) {
			throw executionError;
		}
		if (!result) {
			throw invalidResult();
		}
		return result;
	}
}

export function createSandboxAgentExecutor(
	namespace: DurableObjectNamespace<FormAgentSandbox>,
	model: string,
): AgentExecutor {
	return new SandboxAgentExecutor(
		(jobId) => getSandbox(namespace, jobId, { sleepAfter: "1m" }),
		model,
	);
}

export async function sandboxIdForJob(jobId: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(jobId),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `job-${hex.slice(0, 48)}`;
}

export function parseRunnerResult(
	stdout: string,
	targetDomain: string,
): AgentRunResult {
	let value: unknown;
	try {
		value = JSON.parse(stdout.trim());
	} catch {
		throw invalidResult();
	}
	if (!isRecord(value) || typeof value.outcome !== "string") {
		throw invalidResult();
	}

	switch (value.outcome) {
		case "sent": {
			const formUrl = requiredString(value.formUrl, 2_048);
			assertAllowedResultUrl(formUrl, targetDomain);
			return { outcome: "sent", formUrl };
		}
		case "prohibited": {
			const formUrl = optionalUrl(value.formUrl, targetDomain);
			return {
				outcome: "prohibited",
				formUrl,
				reasonCode: reasonCode(value.reasonCode),
				reason: requiredString(value.reason, 1_000),
			};
		}
		case "uncertain":
			return {
				outcome: "uncertain",
				reasonCode: reasonCode(value.reasonCode),
				reason: requiredString(value.reason, 1_000),
			};
		case "failed":
			if (typeof value.retryable !== "boolean") {
				throw invalidResult();
			}
			return {
				outcome: "failed",
				reasonCode: reasonCode(value.reasonCode),
				reason: requiredString(value.reason, 1_000),
				retryable: value.retryable,
			};
		default:
			throw invalidResult();
	}
}

function optionalUrl(value: unknown, targetDomain: string): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const url = requiredString(value, 2_048);
	assertAllowedResultUrl(url, targetDomain);
	return url;
}

function assertAllowedResultUrl(value: string, targetDomain: string): void {
	try {
		assertAllowedTargetUrl(value, targetDomain);
	} catch {
		throw invalidResult();
	}
}

function reasonCode(value: unknown): string {
	const code = requiredString(value, 64);
	if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
		throw invalidResult();
	}
	return code;
}

function requiredString(value: unknown, maxLength: number): string {
	if (typeof value !== "string" || !value || value.length > maxLength) {
		throw invalidResult();
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResult(): AgentExecutionError {
	return new AgentExecutionError(
		"AGENT_RESULT_INVALID",
		"The isolated agent runner returned an invalid result.",
		false,
	);
}

function timeoutError(): AgentExecutionError {
	return new AgentExecutionError(
		"AGENT_TIMEOUT",
		"The isolated agent runner exceeded its time limit.",
		true,
	);
}
