export interface RunnerJob {
	id: string;
	companyId: string;
	companyName: string;
	targetUrl: string;
	targetDomain: string;
	payload: Record<string, unknown>;
	status: string;
	result: RunnerJobResult | null;
}

export interface RunnerJobResult {
	outcome: "sent" | "prohibited" | "uncertain" | "failed";
	formUrl: string | null;
	reasonCode: string | null;
	reason: string | null;
}

export type RunnerResult =
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
