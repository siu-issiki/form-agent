import { describe, expect, test } from "bun:test";
import {
	BrowserUseApiError,
	BrowserUseClient,
	BrowserUseResponseError,
} from "../src/browser-use-client";

const activeSession = {
	id: "session-001",
	status: "active",
	cdpUrl: "wss://connect.browser-use.com/session-001",
	liveUrl: "https://live.browser-use.com/session-001",
	timeoutAt: "2026-08-28T01:00:00.000Z",
	startedAt: "2026-08-28T00:00:00.000Z",
	finishedAt: null,
};

describe("BrowserUseClient", () => {
	test("creates a standalone browser with bounded defaults", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const client = new BrowserUseClient("secret-key", async (url, init) => {
			requests.push({ url, init });
			return Response.json(activeSession, { status: 201 });
		});

		const session = await client.createBrowser();
		const request = requests[0];
		const headers = new Headers(request?.init?.headers);
		const body = JSON.parse(String(request?.init?.body));

		expect(session.cdpUrl).toBe(activeSession.cdpUrl);
		expect(request?.url).toBe("https://api.browser-use.com/api/v3/browsers");
		expect(request?.init?.method).toBe("POST");
		expect(headers.get("X-Browser-Use-API-Key")).toBe("secret-key");
		expect(body).toEqual({
			timeout: 15,
			proxyCountryCode: null,
			profileId: null,
			enableRecording: false,
			allowResizing: false,
		});
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

		const session = await client.stopBrowser("session/001");

		expect(session.status).toBe("stopped");
		expect(requests[0]?.url).toBe(
			"https://api.browser-use.com/api/v3/browsers/session%2F001",
		);
		expect(requests[0]?.init?.method).toBe("PATCH");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			action: "stop",
		});
	});

	test("reports only the status for an API failure", async () => {
		const client = new BrowserUseClient("secret-key", async () =>
			Response.json({ detail: "sensitive provider detail" }, { status: 429 }),
		);

		const error = await client.createBrowser().catch((caught) => caught);

		expect(error).toBeInstanceOf(BrowserUseApiError);
		expect(error.message).toBe(
			"Browser Use create request failed with status 429",
		);
		expect(error.message).not.toContain("sensitive provider detail");
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
