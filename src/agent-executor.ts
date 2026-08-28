import type { AgentRunInput, AgentRunResult } from "./agent-runtime";

export interface AgentExecutor {
	terminationGraceMs?: number;
	execute(input: AgentRunInput, signal: AbortSignal): Promise<AgentRunResult>;
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

export async function executeAgent(
	executor: AgentExecutor,
	input: AgentRunInput,
): Promise<AgentRunResult> {
	const controller = new AbortController();
	const signal = controller.signal;
	const timeoutId = setTimeout(() => controller.abort(), input.maxDurationMs);
	let onAbort: (() => void) | undefined;
	let graceTimeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		onAbort = () => {
			graceTimeoutId = setTimeout(
				() =>
					reject(
						new AgentExecutionError(
							"AGENT_TIMEOUT",
							"The agent execution exceeded its time limit.",
							true,
						),
					),
				executor.terminationGraceMs ?? 0,
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});

	try {
		return await Promise.race([executor.execute(input, signal), timeout]);
	} finally {
		clearTimeout(timeoutId);
		if (graceTimeoutId) {
			clearTimeout(graceTimeoutId);
		}
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}
