import { describe, expect, test } from "bun:test";
import { AgentToolClient, AgentToolHttpError } from "./tool-client";

describe("AgentToolClient", () => {
	test("does not send job or run identifiers from the sandbox", async () => {
		let captured: Request | undefined;
		const client = new AgentToolClient("http://agent-tools.internal", (async (
			input,
			init,
		) => {
			captured = new Request(input, init);
			return Response.json({ result: { ok: true } });
		}) as typeof fetch);

		await client.navigate("https://form-agent.dev/contact");

		expect(captured?.url).toBe("http://agent-tools.internal/browser/navigate");
		expect(await captured?.json()).toEqual({
			url: "https://form-agent.dev/contact",
		});
	});

	test("rejects a non-internal tool base URL", () => {
		expect(() => new AgentToolClient("https://evil.test")).toThrow();
	});

	test("does not expose tool error bodies", async () => {
		const client = new AgentToolClient(
			"http://agent-tools.internal",
			(async () =>
				new Response("sensitive upstream detail", {
					status: 503,
				})) as unknown as typeof fetch,
		);

		const error = await client.getJob().catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentToolHttpError);
		expect(error.message).not.toContain("sensitive");
	});
});
