import { describe, expect, test } from "bun:test";
import {
	type AgentRunMetrics,
	DuplicateJobError,
	type JobInput,
} from "../src/job";
import { InMemoryJobStore } from "./helpers/in-memory-job-store";

const input: JobInput = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://example.com/contact",
	targetDomain: "example.com",
	allowedHosts: [],
	payload: { message: "Hello" },
};

describe("job submission guard", () => {
	test("creates a pending job and rejects a duplicate id", async () => {
		const store = new InMemoryJobStore();
		const created = await store.create(input, "2026-08-28T00:00:00.000Z");

		expect(created.status).toBe("pending");
		expect(created.attemptCount).toBe(0);
		await expect(
			store.create(input, "2026-08-28T00:00:01.000Z"),
		).rejects.toBeInstanceOf(DuplicateJobError);
	});

	test("only one consumer can claim a pending job", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");

		const first = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		const duplicate = await store.claimRun(
			input.id,
			"run-token-2",
			"2026-08-28T00:00:01.000Z",
		);

		expect(first?.status).toBe("running");
		expect(first?.attemptCount).toBe(1);
		expect(duplicate).toBeNull();
	});

	test("only the current run token can acquire submission permission", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const staleRun = await store.claimSubmission(
			input.id,
			"run-token-2",
			"2026-08-28T00:00:02.000Z",
		);
		const currentRun = await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:02.000Z",
		);
		const duplicate = await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:03.000Z",
		);

		expect(staleRun).toBeNull();
		expect(currentRun?.status).toBe("submitting");
		expect(duplicate).toBeNull();
	});

	test("records a sent result only after submission permission", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const premature = await store.recordSent(
			input.id,
			"run-token-1",
			input.targetUrl,
			"2026-08-28T00:00:02.000Z",
		);
		await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:03.000Z",
		);
		const sent = await store.recordSent(
			input.id,
			"run-token-1",
			input.targetUrl,
			"2026-08-28T00:00:04.000Z",
		);

		expect(premature).toBeNull();
		expect(sent?.status).toBe("sent");
		expect(sent?.result?.outcome).toBe("sent");
	});

	test("does not allow an uncertain submission to be claimed again", async () => {
		const store = new InMemoryJobStore();
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

		const retriedRun = await store.claimRun(
			input.id,
			"run-token-2",
			"2026-08-28T00:00:04.000Z",
		);
		const retriedSubmission = await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:04.000Z",
		);

		expect(uncertain?.status).toBe("uncertain");
		expect(retriedRun).toBeNull();
		expect(retriedSubmission).toBeNull();
	});

	test("records a prohibited decision before submission", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const prohibited = await store.recordProhibited(
			input.id,
			"run-token-1",
			input.targetUrl,
			"SALES_PROHIBITED",
			"Sales messages are prohibited.",
			"2026-08-28T00:00:02.000Z",
		);

		expect(prohibited?.status).toBe("prohibited");
		expect(prohibited?.result?.reasonCode).toBe("SALES_PROHIBITED");
	});

	test("records an uncertain decision before submission and blocks retry", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const uncertain = await store.recordUncertain(
			input.id,
			"run-token-1",
			"FORM_UNCLEAR",
			"The form purpose could not be confirmed.",
			"2026-08-28T00:00:02.000Z",
		);
		const retried = await store.claimRun(
			input.id,
			"run-token-2",
			"2026-08-28T00:00:03.000Z",
		);

		expect(uncertain?.status).toBe("uncertain");
		expect(retried).toBeNull();
	});

	test("records the run metrics only for the current run token", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const metrics: AgentRunMetrics = {
			turns: 2,
			providerRequests: 2,
			reviewRequests: 1,
			inputTokens: 1_000,
			outputTokens: 200,
			reasoningTokens: 64,
			cachedTokens: 32,
			browserConnectMs: 900,
			browserConnected: true,
			submitReviewAllow: 1,
			submitReviewDeny: 0,
			durationMs: 5_000,
			outcome: "sent",
		};

		const recorded = await store.recordAgentRunMetrics(
			input.id,
			"run-token-1",
			1,
			metrics,
			"2026-08-28T00:00:02.000Z",
		);
		const otherRun = await store.recordAgentRunMetrics(
			input.id,
			"run-token-2",
			1,
			metrics,
			"2026-08-28T00:00:03.000Z",
		);

		expect(recorded).toBe(true);
		expect(otherRun).toBe(false);
		expect(store.events).toEqual([
			{
				jobId: input.id,
				attempt: 1,
				type: "agent.run_metrics",
				data: { ...metrics },
			},
		]);
	});

	test("tracks redelivery attempts for the current run token", async () => {
		const store = new InMemoryJobStore();
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const redelivered = await store.recordRunAttempt(
			input.id,
			"run-token-1",
			3,
			"2026-08-28T00:00:02.000Z",
		);
		const stale = await store.recordRunAttempt(
			input.id,
			"run-token-2",
			4,
			"2026-08-28T00:00:03.000Z",
		);

		expect(redelivered?.attemptCount).toBe(3);
		expect(stale).toBeNull();
	});
});
