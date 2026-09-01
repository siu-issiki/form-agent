import { describe, expect, test } from "bun:test";
import {
	AgentExecutionError,
	type AgentExecutor,
	executeAgent,
} from "../src/agent-executor";
import type { AgentRunInput } from "../src/agent-runtime";

const input: AgentRunInput = {
	job: {
		id: "job-001",
		companyId: "company-001",
		companyName: "Example Inc.",
		targetUrl: "https://example.com/contact",
		targetDomain: "example.com",
		allowedHosts: [],
		payload: { message: "Hello" },
		status: "running",
		attemptCount: 1,
		runToken: "run-token-1",
		result: null,
		createdAt: "2026-08-28T00:00:00.000Z",
		updatedAt: "2026-08-28T00:00:01.000Z",
	},
	runToken: "run-token-1",
	maxDurationMs: 10,
};

describe("executeAgent", () => {
	test("passes a deadline signal to the executor", async () => {
		let receivedSignal: AbortSignal | undefined;
		const executor: AgentExecutor = {
			async execute(_input, signal) {
				receivedSignal = signal;
				return {
					outcome: "failed",
					reasonCode: "TEST_STOP",
					reason: "Stopped by the test.",
					retryable: false,
				};
			},
		};

		await executeAgent(executor, input);

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);
	});

	test("rejects an executor that ignores the deadline", async () => {
		const executor: AgentExecutor = {
			async execute() {
				return await new Promise(() => {});
			},
		};

		const error = await executeAgent(executor, input).catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("AGENT_TIMEOUT");
		expect(error.retryable).toBe(true);
	});

	test("allows a bounded grace period for executor termination", async () => {
		let cleanupFinished = false;
		const executor: AgentExecutor = {
			terminationGraceMs: 100,
			async execute(_input, signal) {
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				cleanupFinished = true;
				throw new AgentExecutionError(
					"AGENT_TIMEOUT",
					"The executor stopped after cleanup.",
					true,
				);
			},
		};

		const error = await executeAgent(executor, input).catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(cleanupFinished).toBe(true);
	});

	test("does not retry when termination cannot be confirmed within grace", async () => {
		const executor: AgentExecutor = {
			terminationGraceMs: 5,
			async execute() {
				return await new Promise(() => {});
			},
		};

		const error = await executeAgent(executor, input).catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("AGENT_TERMINATION_UNCONFIRMED");
		expect(error.retryable).toBe(false);
	});
});
