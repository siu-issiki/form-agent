const CDP_COMMAND_TIMEOUT_MS = 15_000;
const ERROR_CLOSE_FALLBACK_MS = 1_000;
export const MAX_CDP_MESSAGE_CHARACTERS = 4 * 1024 * 1024;

interface CdpMessage {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
	sessionId?: string;
}

interface PendingCommand {
	method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

type CdpEventListener = (
	params: unknown,
	sessionId: string | undefined,
) => void;

export class BrowserUseCdpConnection {
	#nextId = 1;
	#pending = new Map<number, PendingCommand>();
	#listeners = new Map<string, Set<CdpEventListener>>();
	#lastResponseCharacters = new Map<string, number>();
	#closed = false;
	#closeRequested = false;
	#closeLogged = false;
	#pendingAtFailure: number | undefined;
	#errorFallback: ReturnType<typeof setTimeout> | undefined;

	private constructor(
		private readonly webSocket: WebSocket,
		private readonly errorCloseFallbackMs: number,
	) {
		webSocket.addEventListener("message", (event) => this.#onMessage(event));
		webSocket.addEventListener("close", (event) => this.#onClose(event));
		webSocket.addEventListener("error", () => this.#onError());
	}

	static async connect(
		webSocketUrl: string,
		fetchImpl: typeof fetch = fetch,
		errorCloseFallbackMs = ERROR_CLOSE_FALLBACK_MS,
		signal?: AbortSignal,
	): Promise<BrowserUseCdpConnection> {
		const url = new URL(webSocketUrl);
		if (url.protocol !== "wss:") {
			throw new Error("A secure CDP WebSocket endpoint is required");
		}
		url.protocol = "https:";
		let response: Response;
		try {
			response = await fetchImpl(url, {
				headers: { Upgrade: "websocket" },
				...(signal ? { signal } : {}),
			});
		} catch {
			// An aborted upgrade is the run ending, not a provider failure, so it
			// must not be reported as a retryable connection error.
			if (signal?.aborted) {
				throw new Error("Browser Use CDP connection aborted");
			}
			throw new Error("Browser Use CDP connection failed");
		}
		if (response.status !== 101 || !response.webSocket) {
			await response.body?.cancel();
			throw new BrowserUseCdpUpgradeRejectedError(response.status);
		}
		response.webSocket.accept();
		return new BrowserUseCdpConnection(
			response.webSocket,
			errorCloseFallbackMs,
		);
	}

	/** True once the socket is gone, so a caller can stop retrying. */
	get closed(): boolean {
		return this.#closed;
	}

	send<TResult>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<TResult> {
		if (this.#closed) {
			return Promise.reject(new Error("Browser Use CDP connection is closed"));
		}
		const id = this.#nextId++;
		const message: CdpMessage = { id, method, params };
		if (sessionId) {
			message.sessionId = sessionId;
		}
		return new Promise<TResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Browser Use CDP command timed out"));
			}, CDP_COMMAND_TIMEOUT_MS);
			this.#pending.set(id, {
				method,
				resolve: (value) => resolve(value as TResult),
				reject,
				timeout,
			});
			try {
				this.webSocket.send(JSON.stringify(message));
			} catch {
				clearTimeout(timeout);
				this.#pending.delete(id);
				reject(new Error("Browser Use CDP command could not be sent"));
			}
		});
	}

	on(method: string, listener: CdpEventListener): () => void {
		const listeners =
			this.#listeners.get(method) ?? new Set<CdpEventListener>();
		listeners.add(listener);
		this.#listeners.set(method, listeners);
		return () => listeners.delete(listener);
	}

	lastResponseCharacters(method: string): number | undefined {
		return this.#lastResponseCharacters.get(method);
	}

	close(): void {
		if (this.#closed) return;
		this.#closeRequested = true;
		this.#closed = true;
		this.webSocket.close(1000, "Form Agent run complete");
		this.#rejectPending();
	}

	#onMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") return;
		try {
			assertCdpMessageWithinLimit(event.data);
		} catch (caught) {
			const error =
				caught instanceof BrowserUseCdpPayloadTooLargeError
					? caught
					: new BrowserUseCdpPayloadTooLargeError();
			this.#closeRequested = true;
			this.#closed = true;
			this.webSocket.close(1009, "CDP message is too large");
			this.#rejectPending(error);
			return;
		}
		let message: CdpMessage;
		try {
			message = JSON.parse(event.data) as CdpMessage;
		} catch {
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.#pending.delete(message.id);
			this.#lastResponseCharacters.set(pending.method, event.data.length);
			if (message.error)
				pending.reject(createCdpCommandError(pending.method, message.error));
			else pending.resolve(message.result);
			return;
		}
		if (!message.method) return;
		for (const listener of this.#listeners.get(message.method) ?? []) {
			listener(message.params, message.sessionId);
		}
	}

	#onClose(event: CloseEvent): void {
		const reason = event.reason ?? "";
		const reasonHint = classifyCdpCloseReason(reason);
		if (!this.#closeRequested && !this.#closeLogged) {
			this.#closeLogged = true;
			console.warn(
				JSON.stringify({
					event: "browser_use_cdp_closed",
					code: event.code,
					reasonLength: reason.length,
					reasonHint,
					wasClean: event.wasClean,
					pending: this.#pendingAtFailure ?? this.#pending.size,
				}),
			);
		}
		if (this.#closeRequested) return;
		this.#closed = true;
		this.#rejectPending(new BrowserUseCdpClosedError(event.code, reasonHint));
	}

	/**
	 * The close event carries the diagnosis, so an error only records what it
	 * saw and waits for it. The timer only covers a close that never arrives.
	 */
	#onError(): void {
		if (this.#closed) return;
		this.#pendingAtFailure = this.#pending.size;
		console.warn(JSON.stringify({ event: "browser_use_cdp_error" }));
		this.#closed = true;
		this.#errorFallback = setTimeout(() => {
			this.#errorFallback = undefined;
			this.#rejectPending();
		}, this.errorCloseFallbackMs);
	}

	#rejectPending(
		error: Error = new Error("Browser Use CDP connection closed"),
	): void {
		if (this.#errorFallback !== undefined) {
			clearTimeout(this.#errorFallback);
			this.#errorFallback = undefined;
		}
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

export type CdpCloseReasonHint =
	| "NONE"
	| "LIMIT"
	| "AUTH"
	| "TIMEOUT"
	| "OTHER";

const CLOSE_REASON_HINT_PATTERNS: ReadonlyArray<
	readonly [CdpCloseReasonHint, readonly string[]]
> = [
	["LIMIT", ["limit", "concurren", "rate", "quota"]],
	["AUTH", ["unauthori", "forbidden", "api key"]],
	["TIMEOUT", ["timeout", "timed out"]],
];

export function classifyCdpCloseReason(reason: string): CdpCloseReasonHint {
	const normalized = reason.trim().toLowerCase();
	if (!normalized) return "NONE";
	for (const [hint, needles] of CLOSE_REASON_HINT_PATTERNS) {
		if (needles.some((needle) => normalized.includes(needle))) return hint;
	}
	return "OTHER";
}

export type CdpCommandErrorKind =
	| "NODE_NOT_FOUND"
	| "NODE_DETACHED"
	| "NO_BOX_MODEL"
	| "NOT_FOCUSABLE"
	| "NO_EXECUTION_CONTEXT"
	| "NO_NODE_AT_LOCATION"
	| "OTHER";

/**
 * A CDP error message can quote page-derived text, so only these fixed
 * patterns are read from it and the message itself is never kept.
 */
const COMMAND_ERROR_KIND_PATTERNS: ReadonlyArray<
	readonly [CdpCommandErrorKind, readonly string[]]
> = [
	[
		"NODE_NOT_FOUND",
		[
			"could not find node",
			"no node with given id",
			"node with given id does not belong",
		],
	],
	["NODE_DETACHED", ["not attached", "detached"]],
	["NO_BOX_MODEL", ["box model", "layout object", "could not compute"]],
	["NOT_FOCUSABLE", ["not focusable"]],
	["NO_EXECUTION_CONTEXT", ["execution context", "cannot find context"]],
	// DOM.getNodeForLocation when the computed point is outside the viewport or
	// the layout has not settled after scrolling.
	[
		"NO_NODE_AT_LOCATION",
		["no node found at given location", "no node at given location"],
	],
];

export function classifyCdpCommandError(message: unknown): CdpCommandErrorKind {
	if (typeof message !== "string") return "OTHER";
	const normalized = message.trim().toLowerCase();
	if (!normalized) return "OTHER";
	for (const [kind, needles] of COMMAND_ERROR_KIND_PATTERNS) {
		if (needles.some((needle) => normalized.includes(needle))) return kind;
	}
	return "OTHER";
}

/**
 * A per-command CDP error response. The message stays the fixed string every
 * caller already classifies on, and the failing method, the numeric code and
 * the fixed kind ride alongside it so the cause is visible in a log without
 * recording page-derived text.
 */
export class BrowserUseCdpCommandError extends Error {
	constructor(
		readonly method: string,
		readonly code: number | null,
		readonly kind: CdpCommandErrorKind,
	) {
		super("Browser Use CDP command failed");
		this.name = "BrowserUseCdpCommandError";
	}
}

function createCdpCommandError(
	method: string,
	error: unknown,
): BrowserUseCdpCommandError {
	const detail =
		typeof error === "object" && error !== null
			? (error as { code?: unknown; message?: unknown })
			: {};
	return new BrowserUseCdpCommandError(
		method,
		typeof detail.code === "number" ? detail.code : null,
		classifyCdpCommandError(detail.message),
	);
}

export class BrowserUseCdpClosedError extends Error {
	constructor(
		readonly code: number,
		readonly reasonHint: CdpCloseReasonHint,
	) {
		super("Browser Use CDP connection closed");
		this.name = "BrowserUseCdpClosedError";
	}

	/**
	 * A policy violation or an authentication reason will not succeed on a
	 * second connection, so those closures end the run instead of retrying.
	 */
	get retryable(): boolean {
		return this.code !== 1008 && this.reasonHint !== "AUTH";
	}
}

export class BrowserUseCdpUpgradeRejectedError extends Error {
	constructor(readonly status: number) {
		super("Browser Use CDP connection failed");
		this.name = "BrowserUseCdpUpgradeRejectedError";
	}

	get retryable(): boolean {
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

export class BrowserUseCdpPayloadTooLargeError extends Error {
	constructor() {
		super("Browser Use CDP payload exceeded the safe Worker limit");
		this.name = "BrowserUseCdpPayloadTooLargeError";
	}
}

export function assertCdpMessageWithinLimit(data: string): void {
	if (data.length > MAX_CDP_MESSAGE_CHARACTERS) {
		throw new BrowserUseCdpPayloadTooLargeError();
	}
}
