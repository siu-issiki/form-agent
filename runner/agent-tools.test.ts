import { describe, expect, test } from "bun:test";
import { createAgentTools } from "./agent-tools";
import type { RunnerJob, RunnerResult } from "./contracts";
import { AgentToolClient } from "./tool-client";

const sentJob: RunnerJob = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://form-agent.dev/contact",
	targetDomain: "form-agent.dev",
	payload: {},
	status: "sent",
	result: {
		outcome: "sent",
		formUrl: "https://form-agent.dev/contact",
		reasonCode: null,
		reason: null,
	},
};

describe("Pi agent tools", () => {
	test("reports sent only from the persisted submit result", async () => {
		const client = clientReturning({ job: sentJob });
		let finalResult: RunnerResult | undefined;
		const submit = createAgentTools(client, (result) => {
			finalResult = result;
		}).find((tool) => tool.name === "submit");

		const toolResult = await submit?.execute("call-1", {});

		expect(finalResult).toEqual({
			outcome: "sent",
			formUrl: "https://form-agent.dev/contact",
		});
		expect(toolResult?.terminate).toBe(true);
	});

	test("rejects a submit response without a terminal persisted state", async () => {
		const client = clientReturning({
			job: { ...sentJob, status: "submitting", result: null },
		});
		let finalResult: RunnerResult | undefined;
		const submit = createAgentTools(client, (result) => {
			finalResult = result;
		}).find((tool) => tool.name === "submit");

		const error = await submit?.execute("call-1", {}).catch((caught) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(finalResult).toBeUndefined();
	});
});

function clientReturning(envelope: unknown): AgentToolClient {
	return new AgentToolClient("http://agent-tools.internal", (async () =>
		Response.json(envelope)) as unknown as typeof fetch);
}
