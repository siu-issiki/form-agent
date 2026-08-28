import type { RunnerJob } from "./contracts";

const MAX_TOOL_RESPONSE_BYTES = 512 * 1_024;

export class AgentToolHttpError extends Error {
	constructor(readonly status: number) {
		super(`Agent tool request failed with status ${status}`);
		this.name = "AgentToolHttpError";
	}
}

export class AgentToolClient {
	readonly #baseUrl: URL;

	constructor(
		baseUrl: string,
		private readonly request: typeof fetch = fetch,
	) {
		this.#baseUrl = new URL(baseUrl);
		if (
			this.#baseUrl.protocol !== "http:" ||
			this.#baseUrl.hostname !== "agent-tools.internal" ||
			this.#baseUrl.pathname !== "/" ||
			this.#baseUrl.search ||
			this.#baseUrl.hash
		) {
			throw new Error("Invalid agent tool base URL");
		}
	}

	getJob(signal?: AbortSignal): Promise<RunnerJob> {
		return this.#call("/job", signal ? { signal } : {});
	}

	navigate(url: string, signal?: AbortSignal): Promise<unknown> {
		return this.#post("/browser/navigate", { url }, signal);
	}

	observe(signal?: AbortSignal): Promise<unknown> {
		return this.#call("/browser/observe", signal ? { signal } : {});
	}

	click(elementId: string, signal?: AbortSignal): Promise<unknown> {
		return this.#post("/browser/click", { elementId }, signal);
	}

	fill(
		elementId: string,
		value: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.#post("/browser/fill", { elementId, value }, signal);
	}

	select(
		elementId: string,
		value: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.#post("/browser/select", { elementId, value }, signal);
	}

	submit(elementId: string, signal?: AbortSignal): Promise<RunnerJob> {
		return this.#post("/browser/submit", { elementId }, signal);
	}

	#post<T>(
		path: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		const init: RequestInit = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		};
		if (signal) {
			init.signal = signal;
		}
		return this.#call(path, init);
	}

	async #call<T>(path: string, init: RequestInit): Promise<T> {
		const response = await this.request(new URL(path, this.#baseUrl), init);
		if (!response.ok) {
			await response.body?.cancel();
			throw new AgentToolHttpError(response.status);
		}

		const text = await readBoundedText(response);
		const envelope: unknown = JSON.parse(text);
		if (
			typeof envelope !== "object" ||
			envelope === null ||
			!("job" in envelope || "result" in envelope)
		) {
			throw new AgentToolHttpError(502);
		}
		return ("job" in envelope ? envelope.job : envelope.result) as T;
	}
}

async function readBoundedText(response: Response): Promise<string> {
	if (!response.body) {
		throw new AgentToolHttpError(502);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let output = "";
	let totalBytes = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			return output + decoder.decode();
		}
		totalBytes += value.byteLength;
		if (totalBytes > MAX_TOOL_RESPONSE_BYTES) {
			await reader.cancel();
			throw new AgentToolHttpError(502);
		}
		output += decoder.decode(value, { stream: true });
	}
}
