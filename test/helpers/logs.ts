/**
 * Console log capture and structured-log-event extraction shared by both the
 * bun and the vitest/workers test suites. Deliberately free of any
 * test-runner import so the same file can be loaded under `bun:test` and
 * under `vitest`.
 */

export function captureLogs(): { logs: string[]; restore: () => void } {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (message: unknown) => {
		logs.push(String(message));
	};
	return {
		logs,
		restore: () => {
			console.log = originalLog;
		},
	};
}

export function captureWarnings(): {
	warnings: string[];
	restore: () => void;
} {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message: unknown) => {
		warnings.push(String(message));
	};
	return {
		warnings,
		restore: () => {
			console.warn = originalWarn;
		},
	};
}

/** Parses every captured log line as a structured log event. */
export function logEvents(logs: readonly string[]): Record<string, unknown>[] {
	return logs.map((entry) => JSON.parse(entry));
}

/** Parses captured log lines and keeps only the events named `event`. */
export function logEventsNamed(
	logs: readonly string[],
	event: string,
): Record<string, unknown>[] {
	return logEvents(logs).filter((entry) => entry.event === event);
}
