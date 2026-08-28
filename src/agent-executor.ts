import type { AgentRunInput, AgentRunResult } from "./agent-runtime";

export interface AgentExecutor {
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
	const timeout = new Promise<never>((_, reject) => {
		onAbort = () => {
			reject(
				new AgentExecutionError(
					"AGENT_TIMEOUT",
					"The agent execution exceeded its time limit.",
					true,
				),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});

	try {
		return await Promise.race([executor.execute(input, signal), timeout]);
	} finally {
		clearTimeout(timeoutId);
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}
