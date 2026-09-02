const CDP_COMMAND_TIMEOUT_MS = 15_000;
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

	private constructor(private readonly webSocket: WebSocket) {
		webSocket.addEventListener("message", (event) => this.#onMessage(event));
		webSocket.addEventListener("close", (event) => this.#onClose(event));
		webSocket.addEventListener("error", () => this.#onError());
	}

	static async connect(
		webSocketUrl: string,
		fetchImpl: typeof fetch = fetch,
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
			});
		} catch {
			throw new Error("Browser Use CDP connection failed");
		}
		if (response.status !== 101 || !response.webSocket) {
			await response.body?.cancel();
			throw new BrowserUseCdpUpgradeRejectedError(response.status);
		}
		response.webSocket.accept();
		return new BrowserUseCdpConnection(response.webSocket);
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
				pending.reject(new Error("Browser Use CDP command failed"));
			else pending.resolve(message.result);
			return;
		}
		if (!message.method) return;
		for (const listener of this.#listeners.get(message.method) ?? []) {
			listener(message.params, message.sessionId);
		}
	}

	#onClose(event: CloseEvent): void {
		if (!this.#closeRequested && !this.#closeLogged) {
			this.#closeLogged = true;
			const reason = event.reason ?? "";
			console.warn(
				JSON.stringify({
					event: "browser_use_cdp_closed",
					code: event.code,
					reasonLength: reason.length,
					reasonHint: classifyCdpCloseReason(reason),
					wasClean: event.wasClean,
					pending: this.#pending.size,
				}),
			);
		}
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectPending();
	}

	#onError(): void {
		if (this.#closed) return;
		console.warn(JSON.stringify({ event: "browser_use_cdp_error" }));
		this.#closed = true;
		this.#rejectPending();
	}

	#rejectPending(
		error: Error = new Error("Browser Use CDP connection closed"),
	): void {
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

export class BrowserUseCdpUpgradeRejectedError extends Error {
	constructor(readonly status: number) {
		super("Browser Use CDP connection failed");
		this.name = "BrowserUseCdpUpgradeRejectedError";
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
