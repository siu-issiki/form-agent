import { describe, expect, test } from "bun:test";
import {
	AgentExecutionError,
	ServiceBindingAgentExecutor,
} from "../src/agent-executor";
import type { AgentRunInput } from "../src/agent-runtime";

const input: AgentRunInput = {
	job: {
		id: "job-001",
		companyId: "company-001",
		companyName: "Example Inc.",
		targetUrl: "https://example.com/contact",
		targetDomain: "example.com",
		payload: { message: "Hello" },
		status: "running",
		attemptCount: 1,
		runToken: "run-token-1",
		result: null,
		createdAt: "2026-08-28T00:00:00.000Z",
		updatedAt: "2026-08-28T00:00:01.000Z",
	},
	runToken: "run-token-1",
	maxDurationMs: 600_000,
};

describe("ServiceBindingAgentExecutor", () => {
	test("sends one structured job to the internal runner", async () => {
		const requests: Request[] = [];
		const executor = new ServiceBindingAgentExecutor({
			async fetch(url, init) {
				requests.push(new Request(url, init));
				return Response.json({
					outcome: "prohibited",
					formUrl: input.job.targetUrl,
					reasonCode: "SALES_PROHIBITED",
					reason: "Sales messages are prohibited.",
				});
			},
		});

		const result = await executor.execute(input);
		const request = requests[0];

		expect(result.outcome).toBe("prohibited");
		expect(request?.url).toBe("https://agent-runner.internal/run");
		expect(request?.method).toBe("POST");
		expect(await request?.json()).toEqual(input);
	});

	test("classifies runner unavailability as retryable without exposing details", async () => {
		const executor = new ServiceBindingAgentExecutor({
			async fetch() {
				throw new Error("secret network detail");
			},
		});

		const error = await executor.execute(input).catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.retryable).toBe(true);
		expect(error.message).not.toContain("secret network detail");
	});

	test("rejects an invalid runner result as non-retryable", async () => {
		const executor = new ServiceBindingAgentExecutor({
			async fetch() {
				return Response.json({ outcome: "sent" });
			},
		});

		const error = await executor.execute(input).catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("AGENT_RESULT_INVALID");
		expect(error.retryable).toBe(false);
	});

	test("rejects an oversized runner result", async () => {
		const executor = new ServiceBindingAgentExecutor({
			async fetch() {
				return Response.json({
					outcome: "uncertain",
					reasonCode: "FORM_UNCLEAR",
					reason: "x".repeat(17 * 1024),
				});
			},
		});

		const error = await executor.execute(input).catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("AGENT_RESULT_INVALID");
	});
});
