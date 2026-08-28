import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { AgentExecutor } from "../src/agent-executor";
import { AgentToolGateway } from "../src/agent-tool-service";
import { D1JobStore } from "../src/d1-job-store";
import type { JobInput } from "../src/job";
import worker, {
	consumeJobBatch,
	type JobMessage,
	registerJob,
} from "../src/worker";

const input: JobInput = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://form-agent.dev/contact",
	targetDomain: "form-agent.dev",
	payload: { message: "Hello" },
};

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM events"),
		env.DB.prepare("DELETE FROM results"),
		env.DB.prepare("DELETE FROM jobs"),
	]);
});

describe("D1JobStore", () => {
	test("allows only one concurrent run claim", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");

		const claims = await Promise.all([
			store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z"),
			store.claimRun(input.id, "run-token-2", "2026-08-28T00:00:01.000Z"),
		]);

		expect(claims.filter((job) => job !== null)).toHaveLength(1);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("running");
		expect(persisted?.attemptCount).toBe(1);
	});

	test("persists an uncertain result and blocks another submission", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:02.000Z",
		);

		const uncertain = await store.recordUncertain(
			input.id,
			"run-token-1",
			"SUBMIT_RESULT_UNKNOWN",
			"The response was lost after submission.",
			"2026-08-28T00:00:03.000Z",
		);
		const repeatedResult = await store.recordUncertain(
			input.id,
			"run-token-1",
			"SUBMIT_RESULT_UNKNOWN",
			"The response was lost after submission.",
			"2026-08-28T00:00:04.000Z",
		);
		const duplicate = await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:04.000Z",
		);

		expect(uncertain?.status).toBe("uncertain");
		expect(uncertain?.result?.reasonCode).toBe("SUBMIT_RESULT_UNKNOWN");
		expect(repeatedResult).toBeNull();
		expect(duplicate).toBeNull();
	});
});

describe("AgentToolGateway", () => {
	const toolNow = () => "2026-08-28T00:00:02.000Z";

	test("scopes job access and submission permission to the current run token", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB, toolNow);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const stale = await gateway.find(input.id, "run-token-2");
		const running = await gateway.find(input.id, "run-token-1");
		const submitting = await gateway.claimSubmission(input.id, "run-token-1");

		expect(stale).toBeNull();
		expect(running?.status).toBe("running");
		expect(submitting?.status).toBe("submitting");
	});

	test("records a sent result only for the persisted target domain", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB, toolNow);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		await gateway.claimSubmission(input.id, "run-token-1");

		await expect(
			gateway.recordSent(input.id, "run-token-1", "https://evil.test/collect"),
		).rejects.toThrow();
		const sent = await gateway.recordSent(
			input.id,
			"run-token-1",
			input.targetUrl,
		);

		expect(sent?.status).toBe("sent");
		expect(sent?.result?.formUrl).toBe(input.targetUrl);
	});

	test("rejects stale tokens and unbounded uncertain reasons", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB, toolNow);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const stale = await gateway.recordUncertain(
			input.id,
			"run-token-2",
			"FORM_UNCLEAR",
			"The form purpose could not be confirmed.",
		);
		await expect(
			gateway.recordUncertain(
				input.id,
				"run-token-1",
				"invalid-code",
				"x".repeat(1_001),
			),
		).rejects.toThrow();

		expect(stale).toBeNull();
	});
});

describe("Queue orchestration", () => {
	test("registers a pending job before enqueueing it", async () => {
		const sent: JobMessage[] = [];
		const queue = {
			async send(message: JobMessage) {
				sent.push(message);
			},
		};

		const registered = await registerJob(
			env.DB,
			queue,
			input,
			"2026-08-28T00:00:00.000Z",
		);

		expect(registered.created).toBe(true);
		expect(registered.job.status).toBe("pending");
		expect(sent).toEqual([{ jobId: input.id }]);
	});

	test("fails closed before acknowledging duplicate deliveries", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
			{
				id: "message-2",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();

		await worker.queue?.(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1", "message-2"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("failed");
		expect(persisted?.attemptCount).toBe(1);
		expect(persisted?.result?.reasonCode).toBe("EXECUTOR_NOT_CONFIGURED");
	});

	test("resumes a run claimed by the same queue message", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "message-1", "2026-08-28T00:00:01.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:02.000Z"),
				body: { jobId: input.id },
				attempts: 2,
			},
		]);
		const ctx = createExecutionContext();

		await worker.queue?.(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("failed");
		expect(persisted?.attemptCount).toBe(2);
	});

	test("persists a prohibited agent decision and acknowledges the message", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute() {
				return {
					outcome: "prohibited",
					formUrl: input.targetUrl,
					reasonCode: "SALES_PROHIBITED",
					reason: "Sales messages are prohibited.",
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("prohibited");
		expect(persisted?.result?.reasonCode).toBe("SALES_PROHIBITED");
	});

	test("retries a retryable agent failure without releasing the run claim", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute() {
				return {
					outcome: "failed",
					reasonCode: "PROVIDER_RATE_LIMITED",
					reason: "The provider rate limit was reached.",
					retryable: true,
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual([]);
		expect(result.retryMessages).toHaveLength(1);
		expect(persisted?.status).toBe("running");
		expect(persisted?.runToken).toBe("message-1");
	});

	test("fails closed when the agent reports sent without a D1 sent result", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute() {
				return { outcome: "sent", formUrl: input.targetUrl };
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SENT_RESULT_NOT_PERSISTED");
	});

	test("does not retry a retryable failure after submission permission", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute(agentInput) {
				await store.claimSubmission(
					agentInput.job.id,
					agentInput.runToken,
					"2026-08-28T00:00:02.000Z",
				);
				return {
					outcome: "failed",
					reasonCode: "BROWSER_CONNECTION_LOST",
					reason: "The browser connection was lost.",
					retryable: true,
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("AGENT_RESULT_CONFLICT");
	});

	test("marks a safe job state as dead-lettered", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs-dlq", [
			{
				id: "dlq-message-1",
				timestamp: new Date("2026-08-28T00:00:03.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();

		await worker.queue?.(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);
		const event = await env.DB.prepare(
			"SELECT type, data_json FROM events WHERE job_id = ?",
		)
			.bind(input.id)
			.first<{ type: string; data_json: string }>();

		expect(result.explicitAcks).toEqual(["dlq-message-1"]);
		expect(persisted?.status).toBe("dead_lettered");
		expect(event?.type).toBe("job.dead_lettered");
		expect(JSON.parse(event?.data_json ?? "{}")).toEqual({
			reason: "QUEUE_RETRY_EXHAUSTED",
		});
	});
});
