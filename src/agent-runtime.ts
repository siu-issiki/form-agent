import type { Job } from "./job";
import type {
	BrowserObservation,
	SubmitActivationStrategy,
	SubmitStagePending,
} from "./restricted-browser";

export interface AgentRunInput {
	job: Job;
	runToken: string;
	maxDurationMs: number;
}

export type AgentRunResult =
	| { outcome: "sent"; formUrl: string }
	| {
			outcome: "prohibited";
			formUrl: string | null;
			reasonCode: string;
			reason: string;
	  }
	| { outcome: "uncertain"; reasonCode: string; reason: string }
	| {
			outcome: "failed";
			reasonCode: string;
			reason: string;
			retryable: boolean;
	  };

export interface AgentTools {
	navigate(url: string): Promise<void>;
	observe(): Promise<BrowserObservation>;
	click(elementId: string): Promise<void>;
	fill(elementId: string, value: string): Promise<void>;
	select(elementId: string, candidates: readonly string[]): Promise<void>;
	submit(
		elementId: string,
		activationStrategy: SubmitActivationStrategy,
	): Promise<Job | SubmitStagePending>;
}

export interface AgentRuntime {
	run(
		input: AgentRunInput,
		tools: AgentTools,
		signal?: AbortSignal,
	): Promise<AgentRunResult>;
}
