import { Agent } from "@earendil-works/pi-agent-core";
import { getModels } from "@earendil-works/pi-ai";
import { createAgentTools } from "./agent-tools";
import type { RunnerResult } from "./contracts";
import { capProviderOutputTokens } from "./provider-payload";
import { AgentToolClient, AgentToolHttpError } from "./tool-client";

const MAX_TURNS = 12;
const MAX_JOB_PROMPT_LENGTH = 64_000;

async function run(): Promise<RunnerResult> {
	const modelId = requiredEnv("FORM_AGENT_MODEL");
	const maxOutputTokens = requiredIntegerEnv(
		"FORM_AGENT_MAX_OUTPUT_TOKENS",
		8_192,
	);
	const model = getModels("openai").find(
		(candidate) => candidate.id === modelId,
	);
	if (!model) {
		return failed("MODEL_NOT_SUPPORTED", false);
	}
	process.env.OPENAI_API_KEY ||= "injected-by-worker-outbound-handler";

	const client = new AgentToolClient(requiredEnv("FORM_AGENT_TOOL_BASE_URL"));
	let result: RunnerResult | undefined;
	const tools = createAgentTools(client, (nextResult) => {
		if (result) {
			throw new Error("Agent already returned a final result");
		}
		result = nextResult;
	});
	const job = await client.getJob();
	const jobJson = JSON.stringify(job);
	if (jobJson.length > MAX_JOB_PROMPT_LENGTH) {
		return failed("JOB_INPUT_TOO_LARGE", false);
	}

	let turns = 0;
	let turnLimitReached = false;
	const agent = new Agent({
		initialState: {
			systemPrompt: systemPrompt(),
			model,
			thinkingLevel: "low",
			tools,
		},
		toolExecution: "sequential",
		maxRetryDelayMs: 30_000,
		onPayload: (payload) => capProviderOutputTokens(payload, maxOutputTokens),
	});
	agent.subscribe((event) => {
		if (event.type === "turn_end" && ++turns >= MAX_TURNS && !result) {
			turnLimitReached = true;
			agent.abort();
		}
	});

	try {
		await agent.prompt(
			`Process exactly this one form outreach job. Never process another company.\n${jobJson}`,
		);
	} catch {
		if (!result) {
			return failed(
				turnLimitReached ? "AGENT_TURN_LIMIT" : "AGENT_RUNTIME_FAILED",
				!turnLimitReached,
			);
		}
	}
	if (result) return result;
	return agent.state.errorMessage
		? failed("AGENT_RUNTIME_FAILED", true)
		: failed("AGENT_DID_NOT_FINISH", false);
}

function systemPrompt(): string {
	return [
		"You operate one company's inquiry form using only the provided tools.",
		"Stay on the persisted target domain. Never use another company or arbitrary URL.",
		"Observe the page before acting and check for sales, solicitation, or purpose restrictions.",
		"If outreach is prohibited or the form purpose is incompatible, do not submit; call finish with prohibited.",
		"Fill only values present in the job payload. Never invent required personal or company data.",
		"Before submit, re-observe and verify the target, all values, required fields, and that submit has not been attempted.",
		"Use submit exactly once. Only submit can report sent.",
		"If meaning or submission outcome is unclear, call finish with uncertain. For technical failures, call finish with failed.",
	].join(" ");
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}

function requiredIntegerEnv(name: string, maximum: number): number {
	const value = Number(requiredEnv(name));
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new Error(`Invalid ${name}`);
	}
	return value;
}

function failed(reasonCode: string, retryable: boolean): RunnerResult {
	return {
		outcome: "failed",
		reasonCode,
		reason: "The isolated agent runner could not complete the job.",
		retryable,
	};
}

run()
	.catch((error: unknown) =>
		failed(
			error instanceof AgentToolHttpError &&
				error.status >= 400 &&
				error.status < 500
				? "AGENT_TOOL_ACCESS_DENIED"
				: "AGENT_RUNNER_START_FAILED",
			!(error instanceof AgentToolHttpError) || error.status >= 500,
		),
	)
	.then((result) => console.log(JSON.stringify(result)));
