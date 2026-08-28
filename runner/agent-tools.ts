import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { RunnerResult } from "./contracts";
import type { AgentToolClient } from "./tool-client";

export function createAgentTools(
	client: AgentToolClient,
	finish: (result: RunnerResult) => void,
): AgentTool[] {
	const sequential = "sequential" as const;
	let terminal = false;
	const assertActive = () => {
		if (terminal) {
			throw new Error("Agent already returned a final result");
		}
	};
	const finalize = (result: RunnerResult) => {
		assertActive();
		terminal = true;
		finish(result);
	};
	return [
		defineTool({
			name: "navigate",
			label: "Navigate",
			description: "Navigate within the single allowed company domain.",
			parameters: Type.Object({ url: Type.String({ maxLength: 2_048 }) }),
			executionMode: sequential,
			execute: async (_id, { url }, signal) => {
				assertActive();
				return toolOk(await client.navigate(url, signal));
			},
		}),
		defineTool({
			name: "observe",
			label: "Observe",
			description:
				"Inspect the current page URL, forms, fields, choices, and prohibition text.",
			parameters: Type.Object({}),
			executionMode: sequential,
			execute: async (_id, _params, signal) => {
				assertActive();
				return toolOk(await client.observe(signal));
			},
		}),
		defineTool({
			name: "click",
			label: "Click",
			description: "Click a non-submit element on the current page.",
			parameters: Type.Object({
				elementId: Type.String({ minLength: 1, maxLength: 256 }),
			}),
			executionMode: sequential,
			execute: async (_id, { elementId }, signal) => {
				assertActive();
				return toolOk(await client.click(elementId, signal));
			},
		}),
		defineTool({
			name: "fill",
			label: "Fill",
			description: "Fill one text-like form field.",
			parameters: Type.Object({
				elementId: Type.String({ minLength: 1, maxLength: 256 }),
				value: Type.String({ maxLength: 8_192 }),
			}),
			executionMode: sequential,
			execute: async (_id, { elementId, value }, signal) => {
				assertActive();
				return toolOk(await client.fill(elementId, value, signal));
			},
		}),
		defineTool({
			name: "select",
			label: "Select",
			description: "Select a dropdown, radio, or checkbox value.",
			parameters: Type.Object({
				elementId: Type.String({ minLength: 1, maxLength: 256 }),
				value: Type.String({ maxLength: 2_048 }),
			}),
			executionMode: sequential,
			execute: async (_id, { elementId, value }, signal) => {
				assertActive();
				return toolOk(await client.select(elementId, value, signal));
			},
		}),
		defineTool({
			name: "submit",
			label: "Submit",
			description:
				"Submit once after confirming the target, required fields, values, and absence of sales prohibitions.",
			parameters: Type.Object({
				elementId: Type.String({ minLength: 1, maxLength: 64 }),
			}),
			executionMode: sequential,
			execute: async (_id, { elementId }, signal) => {
				assertActive();
				const job = await client.submit(elementId, signal);
				if (job.status === "sent" && job.result?.formUrl) {
					finalize({ outcome: "sent", formUrl: job.result.formUrl });
				} else if (
					job.status === "uncertain" &&
					job.result?.reasonCode &&
					job.result.reason
				) {
					finalize({
						outcome: "uncertain",
						reasonCode: job.result.reasonCode,
						reason: job.result.reason,
					});
				} else {
					throw new Error("Submit did not persist a terminal result");
				}
				return { ...toolOk({ status: job.status }), terminate: true };
			},
		}),
		defineTool({
			name: "finish",
			label: "Finish",
			description:
				"Finish without sending when prohibited, uncertain, or technically failed. This tool cannot report sent.",
			parameters: Type.Union([
				Type.Object({
					outcome: Type.Literal("prohibited"),
					formUrl: Type.Optional(Type.String({ maxLength: 2_048 })),
					reasonCode: reasonCodeSchema(),
					reason: reasonSchema(),
				}),
				Type.Object({
					outcome: Type.Literal("uncertain"),
					reasonCode: reasonCodeSchema(),
					reason: reasonSchema(),
				}),
				Type.Object({
					outcome: Type.Literal("failed"),
					reasonCode: reasonCodeSchema(),
					reason: reasonSchema(),
					retryable: Type.Boolean(),
				}),
			]),
			executionMode: sequential,
			execute: async (_id, result) => {
				finalize(
					result.outcome === "prohibited"
						? { ...result, formUrl: result.formUrl ?? null }
						: result,
				);
				return { ...toolOk({ outcome: result.outcome }), terminate: true };
			},
		}),
	];
}

function defineTool<TParameters extends TSchema>(
	tool: AgentTool<TParameters>,
): AgentTool<TParameters> {
	return tool;
}

function toolOk(details: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	};
}

function reasonCodeSchema() {
	return Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" });
}

function reasonSchema() {
	return Type.String({ minLength: 1, maxLength: 1_000 });
}
