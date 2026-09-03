import { describe, expect, test } from "bun:test";
import {
	BrowserUseApiError,
	BrowserUseClient,
	BrowserUseRequestError,
	BrowserUseResponseError,
	resolveCdpWebSocketUrl,
} from "../src/browser-use-client";

const activeSession = {
	id: "session-001",
	status: "active",
	cdpUrl: "wss://connect.browser-use.com/session-001",
	liveUrl: "https://live.browser-use.com/session-001",
	timeoutAt: "2026-08-28T01:00:00.000Z",
	startedAt: "2026-08-28T00:00:00.000Z",
	finishedAt: null,
	metadata: { jobId: "job-1", dryRun: "true", attempts: 3 },
};

describe("BrowserUseClient", () => {
	test("creates a standalone browser with bounded defaults", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const client = new BrowserUseClient("secret-key", async (url, init) => {
			requests.push({ url, init });
			return Response.json(activeSession, { status: 201 });
		});

		const session = await client.createBrowser({
			timeoutMinutes: 12,
			proxyCountryCode: "jp",
			metadata: { jobId: "job-1" },
		});
		const request = requests[0];
		const headers = new Headers(request?.init?.headers);
		const body = JSON.parse(String(request?.init?.body));

		expect(session.cdpUrl).toBe(activeSession.cdpUrl);
		expect(request?.url).toBe("https://api.browser-use.com/api/v4/browsers");
		expect(request?.init?.method).toBe("POST");
		expect(headers.get("X-Browser-Use-API-Key")).toBe("secret-key");
		expect(body).toEqual({
			timeout: 12,
			proxyCountryCode: "jp",
			metadata: { jobId: "job-1" },
		});
	});

	test("keeps only string metadata values from a session response", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json(activeSession, { status: 201 }),
		);

		const session = await client.createBrowser();

		expect(session.metadata).toEqual({ jobId: "job-1", dryRun: "true" });
	});

	test("defaults a missing metadata object to an empty record", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ ...activeSession, metadata: undefined }, { status: 201 }),
		);

		expect((await client.createBrowser()).metadata).toEqual({});
	});

	test("stops a browser without exposing the API response body", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const client = new BrowserUseClient("secret-key", async (url, init) => {
			requests.push({ url, init });
			return Response.json({
				...activeSession,
				status: "stopped",
				cdpUrl: null,
				finishedAt: "2026-08-28T00:01:00.000Z",
			});
		});

		const signal = AbortSignal.timeout(10_000);
		const session = await client.stopBrowser("session/001", signal);

		expect(session.status).toBe("stopped");
		expect(requests[0]?.url).toBe(
			"https://api.browser-use.com/api/v4/browsers/session%2F001",
		);
		expect(requests[0]?.init?.method).toBe("PATCH");
		expect(requests[0]?.init?.signal).toBe(signal);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			action: "stop",
		});
	});

	test("lists the active sessions for a status filter", async () => {
		const requests: string[] = [];
		const client = new BrowserUseClient("secret-key", async (url) => {
			requests.push(url);
			return Response.json({ items: [activeSession] });
		});

		const sessions = await client.listBrowsers("active");

		expect(requests[0]).toBe(
			"https://api.browser-use.com/api/v4/browsers?filterBy=active&pageSize=100",
		);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.metadata.jobId).toBe("job-1");
	});

	test("rejects a session list that is not an array of sessions", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ items: "all" }),
		);

		await expect(client.listBrowsers("active")).rejects.toBeInstanceOf(
			BrowserUseResponseError,
		);
	});

	test("reports only the status for an API failure", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ detail: "sensitive provider detail" }, { status: 429 }),
		);

		const error = await client.createBrowser().catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseApiError);
		expect(error.operation).toBe("create");
		expect(error.status).toBe(429);
		expect(error.retryable).toBe(true);
		expect(error.message).toBe(
			"Browser Use create request failed with status 429",
		);
		expect(error.message).not.toContain("sensitive provider detail");
	});

	test("treats only transient statuses as retryable", async () => {
		expect(new BrowserUseApiError("create", 401).retryable).toBe(false);
		expect(new BrowserUseApiError("create", 404).retryable).toBe(false);
		expect(new BrowserUseApiError("create", 408).retryable).toBe(true);
		expect(new BrowserUseApiError("create", 429).retryable).toBe(true);
		expect(new BrowserUseApiError("resolve", 500).retryable).toBe(true);
		expect(new BrowserUseApiError("list", 503).retryable).toBe(true);
	});

	test("wraps a transport failure without repeating its message", async () => {
		const client = new BrowserUseClient("secret-key", async () => {
			throw new TypeError("Network connection to 10.0.0.1 lost");
		});

		const error = await client.createBrowser().catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseRequestError);
		expect(error.message).toBe("Browser Use request failed");
	});

	test("rejects a create response without a CDP URL", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ ...activeSession, cdpUrl: null }, { status: 201 }),
		);

		await expect(client.createBrowser()).rejects.toBeInstanceOf(
			BrowserUseResponseError,
		);
	});
});

describe("resolveCdpWebSocketUrl", () => {
	function rejectingFetch(): typeof fetch {
		return (async () => {
			throw new Error("The resolver must not call the provider");
		}) as unknown as typeof fetch;
	}

	test("returns a WebSocket endpoint without contacting the provider", async () => {
		const resolved = await resolveCdpWebSocketUrl(
			"wss://connect.browser-use.com/session-001",
			rejectingFetch(),
			"secret-key",
		);

		expect(resolved).toBe("wss://connect.browser-use.com/session-001");
	});

	test("reads the debugger endpoint from an HTTP CDP URL", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const resolved = await resolveCdpWebSocketUrl(
			"https://cdp.browser-use.com/session-001/",
			async (url, init) => {
				requests.push({ url, init });
				return Response.json({
					webSocketDebuggerUrl:
						"wss://cdp.browser-use.com/devtools/browser/abc",
				});
			},
			"secret-key",
		);

		expect(requests[0]?.url).toBe(
			"https://cdp.browser-use.com/session-001/json/version",
		);
		expect(
			new Headers(requests[0]?.init?.headers).get("X-Browser-Use-API-Key"),
		).toBe("secret-key");
		expect(resolved).toBe("wss://cdp.browser-use.com/devtools/browser/abc");
	});

	test("promotes a plaintext debugger endpoint on the same host", async () => {
		const resolved = await resolveCdpWebSocketUrl(
			"https://cdp.browser-use.com/session-001",
			(async () =>
				Response.json({
					webSocketDebuggerUrl: "ws://cdp.browser-use.com/devtools/browser/abc",
				})) as unknown as typeof fetch,
			"secret-key",
		);

		expect(resolved).toBe("wss://cdp.browser-use.com/devtools/browser/abc");
	});

	test("rejects a plaintext debugger endpoint on a different host", async () => {
		await expect(
			resolveCdpWebSocketUrl(
				"https://cdp.browser-use.com/session-001",
				(async () =>
					Response.json({
						webSocketDebuggerUrl: "ws://other.browser-use.com/devtools",
					})) as unknown as typeof fetch,
				"secret-key",
			),
		).rejects.toThrow("Invalid Browser Use CDP endpoint");
	});

	test("rejects a CDP URL outside the provider domain before sending the key", async () => {
		await expect(
			resolveCdpWebSocketUrl(
				"https://cdp.browser-use.com.evil.example/session",
				rejectingFetch(),
				"secret-key",
			),
		).rejects.toThrow("Invalid Browser Use CDP endpoint");
	});

	test("rejects a debugger endpoint outside the provider domain", async () => {
		await expect(
			resolveCdpWebSocketUrl(
				"https://cdp.browser-use.com/session-001",
				(async () =>
					Response.json({
						webSocketDebuggerUrl: "wss://evil.example/devtools",
					})) as unknown as typeof fetch,
				"secret-key",
			),
		).rejects.toThrow("Invalid Browser Use CDP endpoint");
	});

	test("rejects an insecure CDP URL", async () => {
		await expect(
			resolveCdpWebSocketUrl(
				"http://cdp.browser-use.com/session-001",
				rejectingFetch(),
				"secret-key",
			),
		).rejects.toThrow("Invalid Browser Use CDP endpoint");
	});

	test("reports the status when the debugger endpoint cannot be read", async () => {
		const error = await resolveCdpWebSocketUrl(
			"https://cdp.browser-use.com/session-001",
			(async () =>
				new Response("no", { status: 503 })) as unknown as typeof fetch,
			"secret-key",
		).catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseApiError);
		expect(error.operation).toBe("resolve");
		expect(error.status).toBe(503);
	});

	test("rejects a debugger response without a WebSocket URL", async () => {
		await expect(
			resolveCdpWebSocketUrl(
				"https://cdp.browser-use.com/session-001",
				(async () => Response.json({})) as unknown as typeof fetch,
				"secret-key",
			),
		).rejects.toBeInstanceOf(BrowserUseResponseError);
	});

	test("wraps a transport failure while reading the debugger endpoint", async () => {
		await expect(
			resolveCdpWebSocketUrl(
				"https://cdp.browser-use.com/session-001",
				(async () => {
					throw new TypeError("Network connection lost");
				}) as unknown as typeof fetch,
				"secret-key",
			),
		).rejects.toBeInstanceOf(BrowserUseRequestError);
	});
});

describe("BrowserUseClient redirect handling", () => {
	test("never follows a redirect on a request that carries the API key", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const client = new BrowserUseClient("secret-key", async (_url, init) => {
			inits.push(init);
			return Response.json(activeSession, { status: 201 });
		});

		await client.createBrowser();
		await client.stopBrowser("session-001");
		await client.listBrowsers("active").catch(() => undefined);

		expect(inits.map((init) => init?.redirect)).toEqual([
			"manual",
			"manual",
			"manual",
		]);
	});

	test("reports a redirected create as a non-retryable failure", async () => {
		let calls = 0;
		const client = new BrowserUseClient("secret-key", async () => {
			calls += 1;
			return new Response(null, {
				status: 302,
				headers: { Location: "https://evil.example/api/v4/browsers" },
			});
		});

		const error = await client.createBrowser().catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseApiError);
		expect(error.operation).toBe("create");
		expect(error.status).toBe(302);
		expect(error.retryable).toBe(false);
		expect(calls).toBe(1);
	});

	test("reports the session id when the create response is unusable", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ ...activeSession, cdpUrl: null }, { status: 201 }),
		);

		const error = await client.createBrowser().catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseResponseError);
		expect(error.sessionId).toBe("session-001");
	});

	test("reports a stopped create response with its session id", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ ...activeSession, status: "stopped" }, { status: 201 }),
		);

		const error = await client.createBrowser().catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseResponseError);
		expect(error.sessionId).toBe("session-001");
	});

	test("does not resend the API key to a redirected debugger endpoint", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const error = await resolveCdpWebSocketUrl(
			"https://cdp.browser-use.com/session-001",
			async (_url, init) => {
				inits.push(init);
				return new Response(null, {
					status: 302,
					headers: { Location: "https://evil.example/json/version" },
				});
			},
			"secret-key",
		).catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseApiError);
		expect(error.operation).toBe("resolve");
		expect(error.status).toBe(302);
		expect(error.retryable).toBe(false);
		expect(inits).toHaveLength(1);
		expect(inits[0]?.redirect).toBe("manual");
	});
});
