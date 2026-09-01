import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { hasNewSubmissionConfirmation } from "../src/browser-submit-confirmation";
import {
	assertCdpMessageWithinLimit,
	BrowserUseCdpPayloadTooLargeError,
	MAX_CDP_MESSAGE_CHARACTERS,
} from "../src/browser-use-cdp";
import { discoverCdpForms } from "../src/browser-use-cdp-dom";
import {
	BLOCK_BROWSER_ESCAPE_EXPRESSION,
	denyRelatedBrowserTargets,
} from "../src/browser-use-cdp-driver";

describe("BrowserUse CDP payload and DOM discovery", () => {
	test("discovers controls inside a closed shadow root", () => {
		const discovery = discoverCdpForms(
			{
				backendNodeId: 1,
				nodeName: "#document",
				children: [
					{
						backendNodeId: 2,
						nodeName: "FORM",
						attributes: ["id", "contact", "action", "/send", "method", "post"],
						children: [
							{ backendNodeId: 3, nodeName: "INPUT" },
							{
								backendNodeId: 4,
								nodeName: "CONTACT-FIELDS",
								shadowRoots: [
									{
										backendNodeId: 5,
										nodeName: "#document-fragment",
										shadowRootType: "closed",
										children: [
											{ backendNodeId: 6, nodeName: "TEXTAREA" },
											{ backendNodeId: 7, nodeName: "BUTTON" },
										],
									},
								],
							},
						],
					},
					{
						backendNodeId: 8,
						nodeName: "INPUT",
						attributes: ["form", "contact"],
					},
				],
			},
			"https://example.com/contact",
		);

		expect(discovery.closedShadowRootCount).toBe(1);
		expect(discovery.shadowRootCount).toBe(1);
		expect(discovery.forms).toEqual([
			{
				backendNodeId: 2,
				action: "https://example.com/send",
				method: "post",
				fields: [
					{ backendNodeId: 3, tag: "input" },
					{ backendNodeId: 6, tag: "textarea" },
					{ backendNodeId: 7, tag: "button" },
					{ backendNodeId: 8, tag: "input" },
				],
			},
		]);
	});

	test("rejects a CDP message before parsing beyond the Worker-safe cap", () => {
		expect(() =>
			assertCdpMessageWithinLimit("x".repeat(MAX_CDP_MESSAGE_CHARACTERS)),
		).not.toThrow();
		expect(() =>
			assertCdpMessageWithinLimit("x".repeat(MAX_CDP_MESSAGE_CHARACTERS + 1)),
		).toThrow(BrowserUseCdpPayloadTooLargeError);
	});
});

describe("BrowserUseCdpDriver child target policy", () => {
	test("pauses and closes related worker and popup targets", async () => {
		const calls: Array<{
			method: string;
			params: Record<string, unknown>;
			sessionId?: string;
		}> = [];
		let attachedListener:
			| ((params: unknown, sessionId: string | undefined) => void)
			| undefined;
		const failures: Error[] = [];
		const connection = {
			on(method: string, listener: typeof attachedListener) {
				expect(method).toBe("Target.attachedToTarget");
				attachedListener = listener;
				return () => undefined;
			},
			async send<TResult>(
				method: string,
				params: Record<string, unknown> = {},
				sessionId?: string,
			): Promise<TResult> {
				calls.push({ method, params, sessionId });
				return { success: true } as TResult;
			},
		};

		await denyRelatedBrowserTargets(connection, "primary", (error) =>
			failures.push(error),
		);
		expect(calls[0]).toEqual({
			method: "Target.setAutoAttach",
			params: {
				autoAttach: true,
				waitForDebuggerOnStart: true,
				flatten: true,
			},
			sessionId: "primary",
		});

		for (const [targetId, type] of [
			["worker-1", "worker"],
			["popup-1", "page"],
		] as const) {
			attachedListener?.(
				{
					sessionId: `${targetId}-session`,
					targetInfo: { targetId, type },
					waitingForDebugger: true,
				},
				"primary",
			);
		}
		await Promise.resolve();

		expect(calls.slice(1)).toEqual([
			{
				method: "Target.closeTarget",
				params: { targetId: "worker-1" },
				sessionId: undefined,
			},
			{
				method: "Target.closeTarget",
				params: { targetId: "popup-1" },
				sessionId: undefined,
			},
		]);
		expect(failures).toEqual([]);
	});

	test("blocks page-realm socket, peer, worker, popup, and service worker escapes", async () => {
		const context = {
			WebSocket: class {},
			WebSocketStream: class {},
			WebTransport: class {},
			RTCPeerConnection: class {},
			webkitRTCPeerConnection: class {},
			Worker: class {},
			SharedWorker: class {},
			open: () => ({ opened: true }),
			navigator: { serviceWorker: { register: () => Promise.resolve() } },
		};
		runInNewContext(BLOCK_BROWSER_ESCAPE_EXPRESSION, context);

		for (const constructorName of [
			"WebSocket",
			"WebSocketStream",
			"WebTransport",
			"RTCPeerConnection",
			"webkitRTCPeerConnection",
			"Worker",
			"SharedWorker",
		]) {
			expect(() =>
				runInNewContext(
					`new ${constructorName}("https://example.com")`,
					context,
				),
			).toThrow("Browser network escape is disabled");
		}
		expect(runInNewContext('open("https://example.com")', context)).toBeNull();
		await expect(context.navigator.serviceWorker.register()).rejects.toThrow(
			"Service workers are disabled",
		);
	});

	test("fails the policy when a related target was not paused", async () => {
		let attachedListener:
			| ((params: unknown, sessionId: string | undefined) => void)
			| undefined;
		const failures: Error[] = [];
		const connection = {
			on(_method: string, listener: typeof attachedListener) {
				attachedListener = listener;
				return () => undefined;
			},
			async send<TResult>(): Promise<TResult> {
				return { success: true } as TResult;
			},
		};

		await denyRelatedBrowserTargets(connection, "primary", (error) =>
			failures.push(error),
		);
		attachedListener?.(
			{
				sessionId: "worker-session",
				targetInfo: { targetId: "worker-1", type: "worker" },
				waitingForDebugger: false,
			},
			"primary",
		);

		expect(failures.map((error) => error.message)).toEqual([
			"A related browser target was not paused",
		]);
	});
});

describe("BrowserUseCdpDriver submission confirmation", () => {
	test("accepts a confirmation that appears after submit", () => {
		expect(
			hasNewSubmissionConfirmation(
				"お問い合わせフォーム",
				"送信が完了しました。ありがとうございました。",
			),
		).toBe(true);
	});

	test("does not accept confirmation text that already existed", () => {
		expect(
			hasNewSubmissionConfirmation(
				"Thank you for visiting our website.",
				"Thank you for visiting our website.",
			),
		).toBe(false);
	});

	test("does not accept a negative submitted message", () => {
		expect(
			hasNewSubmissionConfirmation(
				"Contact form",
				"The form was not submitted. Please correct the errors.",
			),
		).toBe(false);
	});
});
