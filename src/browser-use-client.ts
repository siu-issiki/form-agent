export interface BrowserSession {
	id: string;
	status: "active" | "stopped";
	cdpUrl: string | null;
	liveUrl: string | null;
	timeoutAt: string;
	startedAt: string;
	finishedAt: string | null;
}

export interface CreateBrowserOptions {
	timeoutMinutes?: number;
	proxyCountryCode?: string | null;
	profileId?: string;
	enableRecording?: boolean;
}

export type BrowserUseFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

export class BrowserUseApiError extends Error {
	constructor(
		operation: "create" | "stop",
		readonly status: number,
	) {
		super(`Browser Use ${operation} request failed with status ${status}`);
		this.name = "BrowserUseApiError";
	}
}

export class BrowserUseResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowserUseResponseError";
	}
}

export class BrowserUseClient {
	readonly #baseUrl: string;

	constructor(
		private readonly apiKey: string,
		private readonly fetcher: BrowserUseFetch = fetch,
		baseUrl = "https://api.browser-use.com/api/v3",
	) {
		if (!apiKey) {
			throw new Error("Browser Use API key is required");
		}
		this.#baseUrl = baseUrl.replace(/\/$/, "");
	}

	async createBrowser(
		options: CreateBrowserOptions = {},
	): Promise<BrowserSession> {
		const timeout = options.timeoutMinutes ?? 15;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 240) {
			throw new RangeError("Browser timeout must be an integer from 1 to 240");
		}

		const response = await this.fetcher(`${this.#baseUrl}/browsers`, {
			method: "POST",
			headers: this.#headers(),
			body: JSON.stringify({
				timeout,
				proxyCountryCode: options.proxyCountryCode ?? null,
				profileId: options.profileId ?? null,
				enableRecording: options.enableRecording ?? false,
				allowResizing: false,
			}),
		});

		if (!response.ok) {
			throw new BrowserUseApiError("create", response.status);
		}

		const session = parseSession(await readJson(response));
		if (session.status !== "active" || !session.cdpUrl) {
			throw new BrowserUseResponseError(
				"Browser Use did not return an active session with a CDP URL",
			);
		}
		return session;
	}

	async stopBrowser(sessionId: string): Promise<BrowserSession> {
		if (!sessionId) {
			throw new Error("Browser session ID is required");
		}

		const response = await this.fetcher(
			`${this.#baseUrl}/browsers/${encodeURIComponent(sessionId)}`,
			{
				method: "PATCH",
				headers: this.#headers(),
				body: JSON.stringify({ action: "stop" }),
			},
		);

		if (!response.ok) {
			throw new BrowserUseApiError("stop", response.status);
		}

		return parseSession(await readJson(response));
	}

	#headers(): Headers {
		return new Headers({
			"Content-Type": "application/json",
			"X-Browser-Use-API-Key": this.apiKey,
		});
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new BrowserUseResponseError("Browser Use returned invalid JSON");
	}
}

function parseSession(value: unknown): BrowserSession {
	if (!isRecord(value)) {
		throw new BrowserUseResponseError(
			"Browser Use returned an invalid session",
		);
	}

	const status = value.status;
	if (status !== "active" && status !== "stopped") {
		throw new BrowserUseResponseError("Browser Use returned an invalid status");
	}

	return {
		id: requireString(value.id, "id"),
		status,
		cdpUrl: optionalString(value.cdpUrl, "cdpUrl"),
		liveUrl: optionalString(value.liveUrl, "liveUrl"),
		timeoutAt: requireString(value.timeoutAt, "timeoutAt"),
		startedAt: requireString(value.startedAt, "startedAt"),
		finishedAt: optionalString(value.finishedAt, "finishedAt"),
	};
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) {
		throw new BrowserUseResponseError(
			`Browser Use returned an invalid ${field}`,
		);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | null {
	if (value === null) {
		return null;
	}
	return requireString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
