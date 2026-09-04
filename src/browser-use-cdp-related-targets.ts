/**
 * The policy for the browser targets a run does not own: every related target
 * is closed, except the out-of-process iframe of a verification widget, which
 * is only released under the page's own restrictions and otherwise stopped.
 */

import {
	isVerificationProviderRequest,
	isVerificationProviderUrl,
} from "./browser-network-policy";
import {
	BrowserUseCdpCommandError,
	type BrowserUseCdpConnection,
} from "./browser-use-cdp";
import type { PausedRequest } from "./browser-use-cdp-driver";
import { BLOCK_BROWSER_ESCAPE_EXPRESSION } from "./browser-use-cdp-page-scripts";

export interface TargetInfo {
	targetId: string;
	type: string;
	url?: string;
}

export interface AttachedTarget {
	sessionId: string;
	targetInfo: TargetInfo;
	waitingForDebugger: boolean;
}

/** Counters the driver keeps for the targets this policy let through. */
export interface RelatedBrowserTargetHooks {
	/** A verification widget iframe target was kept open. */
	readonly onVerificationFrame?: () => void;
	/** A request inside such an iframe was continued. */
	readonly onVerificationRequest?: () => void;
}

const AUTO_ATTACH_PARAMS = {
	autoAttach: true,
	waitForDebuggerOnStart: true,
	flatten: true,
};

/**
 * Closes every browser target the run does not need, and keeps the one kind it
 * does: the out-of-process iframe Chrome creates for a verification widget.
 * Site isolation puts `https://www.google.com/recaptcha/api2/anchor` and the
 * hCaptcha / Turnstile equivalents in their own target, so closing them made
 * the widget report "cannot connect" even with the host allowlist in place.
 *
 * A kept target is policed the same way the page is: `Fetch` intercepts every
 * request in it and only the allowlist passes, nested targets auto-attach into
 * this same handler, and the escape blocker runs before the widget's own
 * scripts so `WebSocket` / `Worker` cannot route around `Fetch`. The iframe is
 * cross-origin, so it can neither read the page's DOM nor read back what it
 * posts to its own origin; a `window.top.location` navigation from inside it is
 * still a top-frame `Document` request and stays blocked by the request policy.
 *
 * An iframe target is never closed. `Target.closeTarget` on an out-of-process
 * iframe closes the page that owns it, which took the run's own session with
 * it: every following command answered "Session with given id not found". Only
 * a target of another type (a popup page, a worker) is closed, since it owns no
 * page the run needs.
 *
 * The rule for an iframe is instead: run it only under the whole restriction
 * set, and stop its content when the set does not land. Detaching alone is not
 * a stop. The `waitForDebuggerOnStart` pause is a browser-side hold on the
 * frame's navigation, and Chrome releases such a hold when the session that
 * owns it goes away, so a detached frame would go on to run unrestricted. See
 * `stopVerificationProviderFrame` for what a stop actually does.
 */
export async function denyRelatedBrowserTargets(
	connection: Pick<BrowserUseCdpConnection, "on" | "send">,
	parentSessionId: string,
	onPolicyFailure: (error: Error) => void,
	hooks: RelatedBrowserTargetHooks = {},
): Promise<void> {
	// Sessions of the verification iframes kept open, so their paused requests
	// are told apart from the page's own and judged by the allowlist alone.
	const verificationSessions = new Set<string>();
	// Sessions whose frame is on its way out. Nothing is continued for them, so
	// a frame being stopped makes no further request even while the stop is in
	// flight and even when the URL is on the allowlist.
	const stoppedSessions = new Set<string>();
	const stopFrame = (
		sessionId: string,
		reason: VerificationFrameStopReason,
		paused: boolean,
	) => {
		stoppedSessions.add(sessionId);
		void stopVerificationProviderFrame(connection, sessionId, reason, paused);
	};
	const closeTarget = (targetId: string) => {
		void connection
			.send<{ success: boolean }>("Target.closeTarget", { targetId })
			.then((result) => {
				if (!result.success) {
					onPolicyFailure(
						new Error("A related browser target could not be closed"),
					);
				}
			})
			.catch(() => {
				onPolicyFailure(
					new Error("A related browser target could not be closed"),
				);
			});
	};

	connection.on("Fetch.requestPaused", (params, sessionId) => {
		if (
			sessionId === undefined ||
			!(verificationSessions.has(sessionId) || stoppedSessions.has(sessionId))
		) {
			return;
		}
		const paused = params as PausedRequest;
		// Inside the widget's own frame a `Document` request is the widget, not a
		// page navigation, so subframe `Document` requests may pass the allowlist.
		const allowed =
			!stoppedSessions.has(sessionId) &&
			isVerificationProviderRequest(
				paused.request.url,
				paused.request.method,
				paused.resourceType,
				true,
			);
		if (!allowed) {
			void connection
				.send(
					"Fetch.failRequest",
					{ requestId: paused.requestId, errorReason: "BlockedByClient" },
					sessionId,
				)
				.catch(() => undefined);
			return;
		}
		void connection
			.send("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
			.then(() => {
				hooks.onVerificationRequest?.();
			})
			.catch(() => undefined);
	});

	connection.on("Target.attachedToTarget", (params, sessionId) => {
		if (
			sessionId !== parentSessionId &&
			(sessionId === undefined || !verificationSessions.has(sessionId))
		) {
			return;
		}
		const attached = params as AttachedTarget;
		const paused = attached.waitingForDebugger;
		if (attached.targetInfo.type !== "iframe") {
			// A popup page or a worker owns no page the run needs, so closing it is
			// both the stop and the denial.
			if (!paused) {
				onPolicyFailure(new Error("A related browser target was not paused"));
			}
			closeTarget(attached.targetInfo.targetId);
			return;
		}
		if (!paused) {
			// Interception could not be installed before this frame started, so the
			// run is failed either way. The restrictions are still attempted, since
			// a frame under them is better than one running loose until the run ends.
			onPolicyFailure(new Error("A related browser target was not paused"));
		}
		// The allowlist decides on its own, whether or not the frame was paused:
		// a frame that started early is no more trusted than one that did not.
		if (!isVerificationProviderUrl(attached.targetInfo.url ?? "")) {
			// The page's own request policy blocks a subframe `Document` outside the
			// allowlist, so no such target should appear. Stopped, not trusted.
			stopFrame(attached.sessionId, "NOT_ALLOWLISTED", paused);
			return;
		}
		// Registered before the first command so that any request this session
		// pauses is judged by the allowlist, including during a stop.
		verificationSessions.add(attached.sessionId);
		void runVerificationProviderFrame(connection, attached.sessionId, paused)
			// Every command is judged on its own, so a rejection here is not
			// expected; it is read as "not running" rather than left unhandled.
			.catch(() => false)
			.then((running) => {
				if (!running) {
					stopFrame(
						attached.sessionId,
						paused ? "RESTRICTION_FAILED" : "NOT_PAUSED",
						paused,
					);
					return;
				}
				// Counted only for a frame that was released under the full
				// restriction set, so the log matches what the widget got.
				if (paused) hooks.onVerificationFrame?.();
			});
	});
	await connection.send(
		"Target.setAutoAttach",
		AUTO_ATTACH_PARAMS,
		parentSessionId,
	);
}

/**
 * The reason a verification frame's content was stopped. Fixed values only.
 */
export type VerificationFrameStopReason =
	/** One of the restrictions the frame may only run under did not land. */
	| "RESTRICTION_FAILED"
	/** The frame was already running when it attached. */
	| "NOT_PAUSED"
	/** The frame's URL is not on the verification provider allowlist. */
	| "NOT_ALLOWLISTED";

/**
 * The restrictions applied to a verification widget frame, in the order they
 * are sent. The three required ones are what the frame may only run under:
 * `Fetch` holds it to the allowlist, the auto-attach setting puts the targets
 * it spawns (a nested out-of-process iframe, a worker, a popup) under this same
 * handler, and the escape blocker closes the `WebSocket` / `Worker` /
 * `window.open` routes `Fetch` cannot see. Missing any one of them leaves a way
 * around the request policy, so a frame that cannot take all three is stopped.
 * `Page.enable` only turns on events and no restriction rides on it.
 */
function verificationFrameRestrictions(): ReadonlyArray<{
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly required: boolean;
}> {
	return [
		{
			method: "Fetch.enable",
			params: { patterns: [{ urlPattern: "*" }] },
			required: true,
		},
		{
			method: "Target.setAutoAttach",
			params: AUTO_ATTACH_PARAMS,
			required: true,
		},
		{ method: "Page.enable", params: {}, required: false },
		{
			method: "Page.addScriptToEvaluateOnNewDocument",
			params: { source: BLOCK_BROWSER_ESCAPE_EXPRESSION },
			required: true,
		},
	];
}

/**
 * Applies the page's own restrictions to a verification widget frame and, when
 * the frame is still paused, releases it. Answers whether the frame ended up
 * running under the whole restriction set; the caller stops it when not.
 *
 * Each command is sent on its own so a failure is attributable, and a required
 * one that fails ends the sequence: there is nothing to gain from the rest once
 * the frame is going to be stopped. `Runtime.runIfWaitingForDebugger` is always
 * the last command sent, so nothing runs before the set is complete. A frame
 * that was already running takes the restrictions without being released.
 */
async function runVerificationProviderFrame(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	paused: boolean,
): Promise<boolean> {
	for (const { method, params, required } of verificationFrameRestrictions()) {
		const applied = await sendVerificationFrameRestriction(
			connection,
			sessionId,
			method,
			params,
		);
		if (!applied && required) return false;
	}
	if (!paused) return true;
	return await sendVerificationFrameRestriction(
		connection,
		sessionId,
		"Runtime.runIfWaitingForDebugger",
		{},
	);
}

/**
 * Stops what a verification frame would run and drops its session, without
 * closing the target: closing an out-of-process iframe closes the page that
 * owns it and takes the run's own session with it.
 *
 * The stop is a navigation to `about:blank`. `Page.navigate` on a frame target
 * is carried out by the browser process, so it does not wait on the frame's own
 * paused renderer, and it supersedes the navigation the frame is held on, which
 * is why the widget document never gets to commit. Only then is the debugger
 * pause released, and only if the navigation was accepted: releasing first
 * would let the widget run, and releasing after a refused navigation would let
 * it run too. A refusal arrives as `errorText` on a resolved answer as often as
 * it does as a rejection, so both count as refused. The pause is a browser-side
 * hold that Chrome frees when the session owning it goes away, so detaching is
 * the last step and never the stop by itself. A frame whose `about:blank`
 * navigation is refused is the one case left where detaching may let the
 * original document run.
 */
async function stopVerificationProviderFrame(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	reason: VerificationFrameStopReason,
	paused: boolean,
): Promise<void> {
	console.log(
		JSON.stringify({ event: "browser_verification_frame_stopped", reason }),
	);
	const navigated = await navigateVerificationFrameToBlank(
		connection,
		sessionId,
	);
	if (navigated && paused) {
		await sendVerificationFrameStopCommand(
			connection,
			sessionId,
			"Runtime.runIfWaitingForDebugger",
			{},
		);
	}
	// Sent without a session: the browser session owns the detach.
	await connection
		.send("Target.detachFromTarget", { sessionId })
		.catch(() => undefined);
}

/**
 * Sends the emptying navigation, reporting whether the frame took it.
 * `Page.navigate` reports a refusal in `errorText` rather than by rejecting, so
 * a resolved answer is not on its own proof that the widget document is gone.
 */
async function navigateVerificationFrameToBlank(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
): Promise<boolean> {
	try {
		const result = await connection.send<{ errorText?: string }>(
			"Page.navigate",
			{ url: "about:blank" },
			sessionId,
		);
		return !result?.errorText;
	} catch {
		return false;
	}
}

/** Sends one stop command, reporting whether it landed and never throwing. */
async function sendVerificationFrameStopCommand(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	method: string,
	params: Record<string, unknown>,
): Promise<boolean> {
	try {
		await connection.send(method, params, sessionId);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sends one restriction command to a verification widget session and reports
 * whether it landed. A failure is logged with the fixed method name and the
 * fixed error kind only, so no page-derived text reaches the log.
 */
async function sendVerificationFrameRestriction(
	connection: Pick<BrowserUseCdpConnection, "send">,
	sessionId: string,
	method: string,
	params: Record<string, unknown>,
): Promise<boolean> {
	try {
		await connection.send(method, params, sessionId);
		return true;
	} catch (error) {
		console.log(
			JSON.stringify({
				event: "browser_verification_frame_restrict_failed",
				method,
				kind: error instanceof BrowserUseCdpCommandError ? error.kind : "OTHER",
			}),
		);
		return false;
	}
}
