const CDP_COMMAND_TIMEOUT_MS = 15_000;

interface CdpMessage {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
	sessionId?: string;
}

interface PendingCommand {
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
	#closed = false;

	private constructor(private readonly webSocket: WebSocket) {
		webSocket.addEventListener("message", (event) => this.#onMessage(event));
		webSocket.addEventListener("close", () => this.#onClose());
		webSocket.addEventListener("error", () => this.#onClose());
	}

	static async connect(webSocketUrl: string): Promise<BrowserUseCdpConnection> {
		const url = new URL(webSocketUrl);
		if (url.protocol !== "wss:") {
			throw new Error("A secure CDP WebSocket endpoint is required");
		}
		url.protocol = "https:";
		const response = await fetch(url, {
			headers: { Upgrade: "websocket" },
		});
		if (response.status !== 101 || !response.webSocket) {
			await response.body?.cancel();
			throw new Error("Browser Use CDP connection failed");
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

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.webSocket.close(1000, "Form Agent run complete");
		this.#rejectPending();
	}

	#onMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") return;
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

	#onClose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectPending();
	}

	#rejectPending(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Browser Use CDP connection closed"));
		}
		this.#pending.clear();
	}
}
