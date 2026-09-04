import { BROWSER_ERROR } from "./browser-error-messages";
import { isRecord } from "./json-record";

export interface BrowserSession {
	id: string;
	status: "active" | "stopped";
	cdpUrl: string | null;
	liveUrl: string | null;
	timeoutAt: string;
	startedAt: string;
	finishedAt: string | null;
	metadata: Record<string, string>;
}

export interface CreateBrowserOptions {
	timeoutMinutes?: number;
	proxyCountryCode?: string | null;
	metadata?: Record<string, string>;
	signal?: AbortSignal;
}

export type BrowserUseFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

export type BrowserUseOperation = "create" | "stop" | "list" | "resolve";

/** A stop the provider accepted without actually ending the session. */
export const SESSION_STILL_ACTIVE_MESSAGE =
	"Browser Use did not stop the session";

export class BrowserUseApiError extends Error {
	constructor(
		readonly operation: BrowserUseOperation,
		readonly status: number,
	) {
		super(`Browser Use ${operation} request failed with status ${status}`);
		this.name = "BrowserUseApiError";
	}

	/**
	 * A rejected request only repeats when the provider reported a transient
	 * condition, so an authentication or validation failure ends the run. A
	 * redirect is never followed, so repeating it would only redirect again.
	 */
	get retryable(): boolean {
		if (this.status >= 300 && this.status < 400) return false;
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

/**
 * The request never reached the provider, so the failure carries no status and
 * is always safe to attempt again.
 */
export class BrowserUseRequestError extends Error {
	constructor() {
		super(BROWSER_ERROR.API_REQUEST_FAILED);
		this.name = "BrowserUseRequestError";
	}
}

export class BrowserUseResponseError extends Error {
	/**
	 * A create call that reached the provider may have started a session even
	 * when the response is unusable. The identifier lets the caller release it.
	 */
	readonly sessionId: string | undefined;

	constructor(message: string, sessionId?: string) {
		super(message);
		this.name = "BrowserUseResponseError";
		this.sessionId = sessionId;
	}
}

export class BrowserUseClient {
	readonly #baseUrl: string;

	readonly #fetcher: BrowserUseFetch;

	constructor(
		private readonly apiKey: string,
		fetcher: BrowserUseFetch = fetch,
		baseUrl = "https://api.browser-use.com/api/v4",
	) {
		// A bare `fetch` reference must not be invoked as a method of this object:
		// Workers throws "Illegal invocation" when `this` is not the global scope.
		this.#fetcher = (url, init) => fetcher(url, init);
		if (!apiKey) {
			throw new Error(BROWSER_ERROR.API_KEY_REQUIRED);
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

		const response = await this.#request(
			"create",
			`${this.#baseUrl}/browsers`,
			{
				method: "POST",
				headers: this.#headers(),
				body: JSON.stringify({
					timeout,
					proxyCountryCode: options.proxyCountryCode ?? null,
					metadata: options.metadata ?? {},
				}),
			},
			options.signal,
		);

		const session = parseSession(await readJson(response));
		if (session.status !== "active" || !session.cdpUrl) {
			throw new BrowserUseResponseError(
				BROWSER_ERROR.SESSION_WITHOUT_CDP_URL,
				session.id,
			);
		}
		return session;
	}

	async stopBrowser(
		sessionId: string,
		signal?: AbortSignal,
	): Promise<BrowserSession> {
		if (!sessionId) {
			throw new Error(BROWSER_ERROR.SESSION_ID_REQUIRED);
		}

		const response = await this.#request(
			"stop",
			`${this.#baseUrl}/browsers/${encodeURIComponent(sessionId)}`,
			{
				method: "PATCH",
				headers: this.#headers(),
				body: JSON.stringify({ action: "stop" }),
			},
			signal,
		);

		const session = parseSession(await readJson(response));
		// An accepted request is not a stopped session, so the caller must be able
		// to tell that the concurrency slot is still held.
		if (session.status !== "stopped") {
			throw new BrowserUseResponseError(
				SESSION_STILL_ACTIVE_MESSAGE,
				session.id,
			);
		}
		return session;
	}

	async listBrowsers(
		status?: "active" | "stopped",
		pageSize = 100,
		signal?: AbortSignal,
	): Promise<BrowserSession[]> {
		const url = new URL(`${this.#baseUrl}/browsers`);
		if (status) {
			url.searchParams.set("filterBy", status);
		}
		url.searchParams.set("pageSize", String(pageSize));

		const response = await this.#request(
			"list",
			url.toString(),
			{ method: "GET", headers: this.#headers() },
			signal,
		);

		const body = await readJson(response);
		if (!isRecord(body) || !Array.isArray(body.items)) {
			logApiDiagnostic("list", "INVALID_LIST", {
				keys: isRecord(body) ? Object.keys(body).sort() : [],
			});
			throw new BrowserUseResponseError(
				"Browser Use returned an invalid session list",
			);
		}
		return body.items.map((item) => parseSession(item));
	}

	async #request(
		operation: BrowserUseOperation,
		url: string,
		init: RequestInit,
		signal: AbortSignal | undefined,
	): Promise<Response> {
		let response: Response;
		try {
			response = await this.#fetcher(url, {
				...init,
				redirect: "manual",
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			logApiDiagnostic(operation, "REQUEST_FAILED", {
				errorName: error instanceof Error ? error.name : typeof error,
			});
			throw new BrowserUseRequestError();
		}
		assertNotRedirected(operation, response);
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			logApiDiagnostic(operation, "HTTP_ERROR", { status: response.status });
			throw new BrowserUseApiError(operation, response.status);
		}
		return response;
	}

	#headers(): Headers {
		return new Headers({
			"Content-Type": "application/json",
			"X-Browser-Use-API-Key": this.apiKey,
		});
	}
}

/**
 * The provider may hand back either a WebSocket endpoint or an HTTP debugging
 * endpoint. Both are checked against the provider host before any credential is
 * attached, so a redirected or tampered endpoint never receives the API key.
 */
export async function resolveCdpWebSocketUrl(
	cdpUrl: string,
	fetcher: BrowserUseFetch,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const url = parseBrowserUseUrl(cdpUrl);
	if (url.protocol === "wss:") {
		return url.toString();
	}
	if (url.protocol !== "https:") {
		throw invalidCdpEndpoint();
	}

	let response: Response;
	try {
		response = await fetcher(
			`${url.toString().replace(/\/$/, "")}/json/version`,
			{
				method: "GET",
				headers: new Headers({ "X-Browser-Use-API-Key": apiKey }),
				redirect: "manual",
				...(signal ? { signal } : {}),
			},
		);
	} catch {
		throw new BrowserUseRequestError();
	}
	assertNotRedirected("resolve", response);
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new BrowserUseApiError("resolve", response.status);
	}

	const body = await readJson(response);
	if (!isRecord(body) || typeof body.webSocketDebuggerUrl !== "string") {
		throw new BrowserUseResponseError(
			"Browser Use returned an invalid CDP endpoint",
		);
	}

	const resolved = parseBrowserUseUrl(body.webSocketDebuggerUrl);
	if (resolved.protocol === "ws:") {
		if (resolved.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
			throw invalidCdpEndpoint();
		}
		resolved.protocol = "wss:";
	}
	if (resolved.protocol !== "wss:") {
		throw invalidCdpEndpoint();
	}
	return resolved.toString();
}

/**
 * Redirects are never followed, because the API key travels in a header and a
 * cross-origin redirect would carry it to whatever host the provider names.
 */
function assertNotRedirected(
	operation: BrowserUseOperation,
	response: Response,
): void {
	const type = (response as { type?: string }).type;
	if (
		type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400)
	) {
		throw new BrowserUseApiError(operation, response.status);
	}
}

export function assertBrowserUseHost(url: URL): void {
	const hostname = url.hostname.toLowerCase();
	if (
		hostname !== "browser-use.com" &&
		!hostname.endsWith(".browser-use.com")
	) {
		throw invalidCdpEndpoint();
	}
}

function parseBrowserUseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidCdpEndpoint();
	}
	assertBrowserUseHost(url);
	return url;
}

function invalidCdpEndpoint(): Error {
	return new Error(BROWSER_ERROR.CDP_ENDPOINT_INVALID);
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		logApiDiagnostic("parse", "INVALID_JSON", { status: response.status });
		throw new BrowserUseResponseError("Browser Use returned invalid JSON");
	}
}

/**
 * Records only fixed classifications, HTTP status codes, error class names,
 * and top-level field names. Values, URLs, and identifiers are never logged.
 */
function logApiDiagnostic(
	operation: BrowserUseOperation | "parse",
	kind:
		| "REQUEST_FAILED"
		| "HTTP_ERROR"
		| "INVALID_JSON"
		| "INVALID_SESSION"
		| "INVALID_LIST",
	detail: Record<string, unknown>,
): void {
	console.warn(
		JSON.stringify({
			event: "browser_use_api_error",
			operation,
			kind,
			...detail,
		}),
	);
}

function parseSession(value: unknown): BrowserSession {
	if (!isRecord(value)) {
		logApiDiagnostic("parse", "INVALID_SESSION", { valueType: typeof value });
		throw new BrowserUseResponseError(
			"Browser Use returned an invalid session",
		);
	}

	const status = value.status;
	if (status !== "active" && status !== "stopped") {
		logApiDiagnostic("parse", "INVALID_SESSION", {
			keys: Object.keys(value).sort(),
			statusType: typeof status,
		});
		throw new BrowserUseResponseError("Browser Use returned an invalid status");
	}
	try {
		return parseSessionFields(value, status);
	} catch (error) {
		logApiDiagnostic("parse", "INVALID_SESSION", {
			keys: Object.keys(value).sort(),
			field:
				error instanceof BrowserUseResponseError
					? error.message.replace(/^Browser Use returned an invalid /, "")
					: "unknown",
		});
		throw error;
	}
}

function parseSessionFields(
	value: Record<string, unknown>,
	status: "active" | "stopped",
): BrowserSession {
	return {
		id: requireString(value.id, "id"),
		status,
		cdpUrl: optionalString(value.cdpUrl, "cdpUrl"),
		liveUrl: optionalString(value.liveUrl, "liveUrl"),
		timeoutAt: requireString(value.timeoutAt, "timeoutAt"),
		startedAt: requireString(value.startedAt, "startedAt"),
		finishedAt: optionalString(value.finishedAt, "finishedAt"),
		metadata: parseMetadata(value.metadata),
	};
}

function parseMetadata(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const metadata: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") metadata[key] = entry;
	}
	return metadata;
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
	if (value === null || value === undefined) {
		return null;
	}
	return requireString(value, field);
}
