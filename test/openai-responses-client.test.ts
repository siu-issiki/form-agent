import { describe, expect, test } from "bun:test";
import { AgentExecutionError } from "../src/agent-executor";
import {
	readBoundedJson,
	readResponseOutput,
} from "../src/openai-responses-client";

/** The AgentExecutionError a rejected provider-response read produced. */
async function rejection(
	promise: Promise<unknown>,
): Promise<AgentExecutionError> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(AgentExecutionError);
	return error as AgentExecutionError;
}

/** The AgentExecutionError a synchronous check threw. */
function thrown(read: () => unknown): AgentExecutionError {
	try {
		read();
	} catch (error) {
		expect(error).toBeInstanceOf(AgentExecutionError);
		return error as AgentExecutionError;
	}
	throw new Error("The read was expected to throw");
}

function streamed(body: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		}),
	);
}

describe("readBoundedJson", () => {
	test("reports a declared length over the cap as too large", async () => {
		const response = new Response("x".repeat(64), {
			headers: { "content-length": "64" },
		});

		const error = await rejection(readBoundedJson(response, 16));

		expect(error.reasonCode).toBe("PROVIDER_RESPONSE_INVALID");
		expect(error.detail).toBe("response_too_large");
	});

	test("reports streamed bytes over the cap as too large", async () => {
		const error = await rejection(
			readBoundedJson(streamed("x".repeat(64)), 16),
		);

		expect(error.reasonCode).toBe("PROVIDER_RESPONSE_INVALID");
		expect(error.detail).toBe("response_too_large");
	});

	test("reports a body that is not JSON", async () => {
		const error = await rejection(readBoundedJson(streamed("not json"), 1_024));

		expect(error.reasonCode).toBe("PROVIDER_RESPONSE_INVALID");
		expect(error.detail).toBe("invalid_json");
	});

	test("returns the parsed value inside the cap", async () => {
		expect(await readBoundedJson(streamed('{"status":"ok"}'), 1_024)).toEqual({
			status: "ok",
		});
	});
});

describe("readResponseOutput", () => {
	test("names the reason an incomplete response gives", () => {
		const error = thrown(() =>
			readResponseOutput({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			}),
		);

		expect(error.reasonCode).toBe("PROVIDER_RESPONSE_INVALID");
		expect(error.detail).toBe("incomplete_max_output_tokens");
	});

	test("names any other status", () => {
		expect(thrown(() => readResponseOutput({ status: "failed" })).detail).toBe(
			"status_failed",
		);
	});

	test("keeps only fixed characters of a provider-supplied reason", () => {
		const error = thrown(() =>
			readResponseOutput({
				status: "incomplete",
				incomplete_details: { reason: "Refused: <script>alert(1)</script>" },
			}),
		);

		expect(error.detail).toBe("incomplete_refusedscriptalert1script");
	});

	test("falls back when the reason holds nothing usable", () => {
		expect(
			thrown(() =>
				readResponseOutput({
					status: "incomplete",
					incomplete_details: { reason: "***" },
				}),
			).detail,
		).toBe("incomplete_other");
	});

	test("separates a missing output list from an invalid item", () => {
		expect(
			thrown(() => readResponseOutput({ status: "completed" })).detail,
		).toBe("output_missing");
		expect(
			thrown(() => readResponseOutput({ status: "completed", output: ["x"] }))
				.detail,
		).toBe("output_item_invalid");
	});

	test("returns the output items of a completed response", () => {
		expect(
			readResponseOutput({
				status: "completed",
				output: [{ type: "message" }],
			}),
		).toEqual([{ type: "message" }]);
	});
});
