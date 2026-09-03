import {
	BrowserUseApiError,
	type BrowserUseClient,
	BrowserUseResponseError,
	SESSION_STILL_ACTIVE_MESSAGE,
} from "./browser-use-client";

/** Marks sessions created by this client so provider counts can separate them from other API-key users. */
export const SESSION_SOURCE_TAG = "form-agent";
export const SESSION_STOP_TIMEOUT_MS = 10_000;

export interface BrowserSessionHandle {
	client: BrowserUseClient;
	id: string;
}
type StopFailureReason = "STILL_ACTIVE" | "API_ERROR" | "TIMEOUT";

/**
 * Stopping is best effort: the provider keeps the session alive until its own
 * timeout when the stop fails, so the outcome is recorded and the caller keeps
 * its original error. A provider response that still reports an active session
 * counts as a failure, because the concurrency slot is still held.
 */
export async function stopBrowserSession(
	session: BrowserSessionHandle,
): Promise<{ ok: boolean; reason?: StopFailureReason }> {
	const startedAt = Date.now();
	const timeout = AbortSignal.timeout(SESSION_STOP_TIMEOUT_MS);
	let reason: StopFailureReason | undefined;
	let status: number | undefined;
	try {
		await session.client.stopBrowser(session.id, timeout);
	} catch (error) {
		if (
			error instanceof BrowserUseResponseError &&
			error.message === SESSION_STILL_ACTIVE_MESSAGE
		) {
			reason = "STILL_ACTIVE";
		} else if (timeout.aborted) {
			reason = "TIMEOUT";
		} else {
			reason = "API_ERROR";
			if (error instanceof BrowserUseApiError) status = error.status;
		}
	}
	console.log(
		JSON.stringify({
			event: "browser_use_session_stopped",
			ok: reason === undefined,
			...(reason === undefined ? {} : { reason }),
			...(status === undefined ? {} : { status }),
			durationMs: Date.now() - startedAt,
		}),
	);
	return reason === undefined ? { ok: true } : { ok: false, reason };
}

/** Best-effort provider snapshot at the moment of a concurrency rejection. Counts only. */
export async function sampleActiveSessions(
	client: BrowserUseClient,
	signal: AbortSignal | undefined,
): Promise<void> {
	let activeTotal: number | null = null;
	let activeTagged: number | null = null;
	try {
		const sessions = await client.listBrowsers(
			"active",
			100,
			signal ?? AbortSignal.timeout(SESSION_STOP_TIMEOUT_MS),
		);
		activeTotal = sessions.length;
		activeTagged = sessions.filter(
			(session) => session.metadata.source === SESSION_SOURCE_TAG,
		).length;
	} catch {
		// The sample is diagnostic only; the retry proceeds either way.
	}
	console.warn(
		JSON.stringify({
			event: "browser_use_session_limit",
			activeTotal,
			activeTagged,
		}),
	);
}

/**
 * A queue retry inherits the sessions of the previous attempt when the Worker
 * was killed before it could stop them. The job identifier is unique per run
 * because claimRun serialises attempts, so every active session tagged with it
 * belongs to an attempt that already ended. The queue consumer calls this on
 * the paths that end a job without creating a driver, so the last attempt of a
 * job releases its slots too.
 */
export async function reclaimJobSessions(
	client: BrowserUseClient,
	jobId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	let matched = 0;
	let stopped = 0;
	let failed = 0;
	let activeTotal = 0;
	let activeTagged = 0;
	let ok = true;
	try {
		const sessions = await client.listBrowsers(
			"active",
			100,
			signal ?? AbortSignal.timeout(SESSION_STOP_TIMEOUT_MS),
		);
		// Counts only: they show whether the provider limit is consumed by this
		// deployment (tagged with a jobId) or by sessions created elsewhere.
		activeTotal = sessions.length;
		activeTagged = sessions.filter(
			(session) => session.metadata.source === SESSION_SOURCE_TAG,
		).length;
		for (const session of sessions) {
			// The source tag keeps a job identifier that another deployment or a
			// local run happens to reuse from stopping that run's session.
			if (
				session.metadata.source !== SESSION_SOURCE_TAG ||
				session.metadata.jobId !== jobId
			) {
				continue;
			}
			matched += 1;
			// Only a confirmed stop is counted, so the record never claims to have
			// released a slot the provider still holds.
			if ((await stopBrowserSession({ client, id: session.id })).ok) {
				stopped += 1;
			} else {
				failed += 1;
				ok = false;
			}
		}
	} catch {
		ok = false;
	}
	console.log(
		JSON.stringify({
			event: "browser_use_session_reclaimed",
			ok,
			activeTotal,
			activeTagged,
			matched,
			stopped,
			failed,
		}),
	);
}
