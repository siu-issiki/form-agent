import { BrowserUseClient } from "../src/browser-use-client";

const apiKey = process.env.BROWSER_USE_API_KEY;
if (!apiKey) {
	throw new Error("BROWSER_USE_API_KEY is required");
}

const client = new BrowserUseClient(apiKey);
const [command = "list", argument] = Bun.argv.slice(2);

switch (command) {
	case "list": {
		await listActiveSessions();
		break;
	}
	case "stop": {
		if (!argument) throw new Error("stop requires a session id");
		await stopSession(argument);
		break;
	}
	case "stop-all": {
		const sessions = await client.listBrowsers("active");
		for (const session of sessions) {
			await stopSession(session.id);
		}
		console.log(
			JSON.stringify({
				event: "browser_use_sessions_stop_all",
				stopped: sessions.length,
			}),
		);
		break;
	}
	default:
		throw new Error("Usage: browser-use-sessions.ts [list|stop <id>|stop-all]");
}

/**
 * The live view and CDP URLs grant control of the session, so the listing only
 * reports what is needed to decide whether a session should be stopped.
 */
async function listActiveSessions(): Promise<void> {
	const sessions = await client.listBrowsers("active");
	console.log(["ID", "STARTED_AT", "TIMEOUT_AT", "JOB_ID"].join("\t"));
	for (const session of sessions) {
		console.log(
			[
				session.id,
				session.startedAt,
				session.timeoutAt,
				session.metadata.jobId ?? "-",
			].join("\t"),
		);
	}
	console.log(
		JSON.stringify({
			event: "browser_use_sessions_listed",
			activeCount: sessions.length,
		}),
	);
}

async function stopSession(sessionId: string): Promise<void> {
	const session = await client.stopBrowser(sessionId);
	console.log(
		JSON.stringify({
			event: "browser_use_session_stop_requested",
			status: session.status,
		}),
	);
}
