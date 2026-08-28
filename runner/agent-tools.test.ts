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

	test("blocks submit after finish in the same tool batch", async () => {
		let requestCount = 0;
		const client = new AgentToolClient(
			"http://agent-tools.internal",
			(async () => {
				requestCount += 1;
				return Response.json({ job: sentJob });
			}) as unknown as typeof fetch,
		);
		let finalResult: RunnerResult | undefined;
		const tools = createAgentTools(client, (result) => {
			finalResult = result;
		});
		const finish = tools.find((tool) => tool.name === "finish");
		const submit = tools.find((tool) => tool.name === "submit");

		await finish?.execute("call-1", {
			outcome: "prohibited",
			reasonCode: "SALES_PROHIBITED",
			reason: "Sales messages are prohibited.",
		});
		const error = await submit?.execute("call-2", {}).catch((caught) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(requestCount).toBe(0);
		expect(finalResult).toEqual({
			outcome: "prohibited",
			formUrl: null,
			reasonCode: "SALES_PROHIBITED",
			reason: "Sales messages are prohibited.",
		});
	});
});

function clientReturning(envelope: unknown): AgentToolClient {
	return new AgentToolClient("http://agent-tools.internal", (async () =>
		Response.json(envelope)) as unknown as typeof fetch);
}
