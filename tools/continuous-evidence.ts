import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { JOB_ID_PATTERN, TERMINAL_JOB_STATUSES } from "../src/job";

const TERMINAL = new Set<string>(TERMINAL_JOB_STATUSES);
const API = "https://form-agent.form-agent.workers.dev";
interface Evidence {
	stage: string;
	objectKey: string;
	contentType: string;
}
export interface TerminalEntry {
	event: "terminal";
	at: string;
	jobId: string;
	sourceRow: number;
	domain: string;
	status: string;
	reasonCode: string | null;
	evidence: Evidence[];
}
interface Captured extends Evidence {
	sha256: string;
	byteLength?: number;
}
interface Verified {
	jobId: string;
	sourceRow: number;
	domain: string;
	status: string;
	reasonCode: string | null;
	verifiedAt: string;
	evidence: Captured[];
	captureFailures: number;
}

/** A partial trailing JSONL line is retried after the sender finishes writing it. */
export function parseTerminalJournal(text: string): TerminalEntry[] {
	const entries = new Map<string, TerminalEntry>();
	const lines = text.split("\n");
	lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		const item = JSON.parse(line) as TerminalEntry;
		if (item.event !== "terminal") continue;
		if (
			typeof item.jobId !== "string" ||
			!JOB_ID_PATTERN.test(item.jobId) ||
			!Number.isInteger(item.sourceRow) ||
			item.sourceRow < 0 ||
			typeof item.domain !== "string" ||
			!TERMINAL.has(item.status) ||
			!(item.reasonCode === null || typeof item.reasonCode === "string") ||
			!Array.isArray(item.evidence)
		)
			throw new Error("INVALID_JOURNAL_ENTRY");
		for (const evidence of item.evidence)
			validateEvidence(evidence, item.jobId);
		const previous = entries.get(item.jobId);
		if (
			previous &&
			JSON.stringify({ ...previous, at: "" }) !==
				JSON.stringify({ ...item, at: "" })
		)
			throw new Error("CONFLICTING_TERMINAL_ENTRY");
		entries.set(item.jobId, item);
	}
	return [...entries.values()];
}
function validateEvidence(item: Evidence, jobId: string): void {
	if (
		typeof item.stage !== "string" ||
		typeof item.contentType !== "string" ||
		typeof item.objectKey !== "string" ||
		!item.objectKey.startsWith(`jobs/${jobId}/`) ||
		item.objectKey.includes("..") ||
		!/^[a-zA-Z0-9_./-]+$/.test(item.objectKey)
	)
		throw new Error("INVALID_EVIDENCE");
}
function reportedReason(status: string, reason: unknown): unknown {
	return status === "sent" ? "SENT" : (reason ?? "NO_REASON");
}
function sortedEvidence(items: Evidence[]): string[] {
	return items
		.map((item) => `${item.objectKey}\t${item.stage}\t${item.contentType}`)
		.sort();
}
export function assertEvidenceAgreement(
	journal: Evidence[],
	api: Evidence[],
	captured: Captured[],
	jobId: string,
): void {
	for (const item of [...journal, ...api, ...captured])
		validateEvidence(item, jobId);
	if (
		new Set(api.map((e) => e.objectKey)).size !== api.length ||
		new Set(captured.map((e) => e.objectKey)).size !== captured.length
	)
		throw new Error("DUPLICATE_EVIDENCE");
	const expected = JSON.stringify(sortedEvidence(journal));
	if (
		expected !== JSON.stringify(sortedEvidence(api)) ||
		expected !== JSON.stringify(sortedEvidence(captured))
	)
		throw new Error("EVIDENCE_SET_MISMATCH");
	if (captured.some((item) => !/^[a-f0-9]{64}$/.test(item.sha256)))
		throw new Error("INVALID_EVIDENCE_HASH");
}
export function assertEvidenceHash(
	bytes: Uint8Array,
	expected: Captured,
): string {
	const hash = createHash("sha256").update(bytes).digest("hex");
	if (
		hash !== expected.sha256 ||
		(expected.byteLength !== undefined && bytes.length !== expected.byteLength)
	)
		throw new Error("EVIDENCE_HASH_MISMATCH");
	return hash;
}
export async function runBounded<T>(
	items: T[],
	concurrency: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				const item = items[next++];
				if (item !== undefined) await run(item);
			}
		}),
	);
}
async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, path);
}
async function acquireLock(path: string): Promise<() => Promise<void>> {
	try {
		const lock = await open(path, "wx", 0o600);
		await lock.writeFile(String(process.pid));
		await lock.close();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const ownerText = await readFile(path, "utf8");
		const owner = Number(ownerText);
		if (!Number.isSafeInteger(owner) || owner <= 0)
			throw new Error("COLLECTOR_LOCK_INVALID");
		try {
			process.kill(owner, 0);
			throw new Error("COLLECTOR_ALREADY_RUNNING");
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code !== "ESRCH") throw caught;
		}
		if ((await readFile(path, "utf8")) !== ownerText)
			throw new Error("COLLECTOR_LOCK_CHANGED");
		await unlink(path);
		return acquireLock(path);
	}
	return async () => {
		if ((await readFile(path, "utf8").catch(() => "")) === String(process.pid))
			await unlink(path);
	};
}
async function command(repo: string, args: string[]): Promise<string> {
	const process = Bun.spawn(
		[join(repo, "node_modules/.bin/wrangler"), ...args],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	const timeout = setTimeout(() => process.kill(), 120_000);
	try {
		const [stdout] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		if ((await process.exited) !== 0) throw new Error("REMOTE_READ_FAILED");
		return stdout;
	} finally {
		clearTimeout(timeout);
	}
}
export async function verifyTerminalEntry(
	entry: TerminalEntry,
	repo: string,
	output: string,
	token: string,
	readCommand: typeof command = command,
	fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Verified> {
	const query = `SELECT j.id,j.target_domain,j.status,json_extract(j.payload_json,'$.sourceRow') AS source_row,r.reason_code FROM jobs j LEFT JOIN results r ON r.job_id=j.id WHERE j.id='${entry.jobId}'; SELECT type,data_json FROM events WHERE job_id='${entry.jobId}' AND type IN ('evidence.captured','evidence.capture_failed');`;
	const parts = JSON.parse(
		await readCommand(repo, [
			"d1",
			"execute",
			"DB",
			"--remote",
			"--command",
			query,
			"--json",
		]),
	) as Array<{ results: Record<string, unknown>[] }>;
	const job = parts[0]?.results[0];
	if (
		!job ||
		parts[0]?.results.length !== 1 ||
		job.id !== entry.jobId ||
		job.status !== entry.status ||
		(job.source_row ?? 0) !== entry.sourceRow ||
		job.target_domain !== entry.domain ||
		reportedReason(entry.status, job.reason_code) !==
			reportedReason(entry.status, entry.reasonCode)
	)
		throw new Error("D1_RESULT_MISMATCH");
	const events = parts[1]?.results;
	if (!events) throw new Error("D1_EVENTS_MISSING");
	const captured = events
		.filter((event) => event.type === "evidence.captured")
		.map((event) => JSON.parse(String(event.data_json)) as Captured);
	const response = await fetchImpl(`${API}/jobs/${entry.jobId}`, {
		headers: { authorization: `Bearer ${token}` },
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error("API_READ_FAILED");
	const api = (await response.json()) as {
		job: {
			id: string;
			status: string;
			targetDomain: string;
			payload: { sourceRow: number };
			result: { reasonCode: string | null } | null;
		};
		evidence: Evidence[];
	};
	if (
		api.job.id !== entry.jobId ||
		api.job.status !== entry.status ||
		api.job.targetDomain !== entry.domain ||
		(api.job.payload.sourceRow ?? 0) !== entry.sourceRow ||
		reportedReason(entry.status, api.job.result?.reasonCode) !==
			reportedReason(entry.status, entry.reasonCode) ||
		(api.job.result?.reasonCode ?? null) !== (job.reason_code ?? null)
	)
		throw new Error("API_RESULT_MISMATCH");
	assertEvidenceAgreement(entry.evidence, api.evidence, captured, entry.jobId);
	for (const item of captured) {
		const keyHash = createHash("sha256").update(item.objectKey).digest("hex");
		const path = join(output, "evidence", keyHash);
		if (!(await Bun.file(path).exists())) {
			const temporary = `${path}.download`;
			await readCommand(repo, [
				"r2",
				"object",
				"get",
				`form-agent-evidence/${item.objectKey}`,
				"--remote",
				"--file",
				temporary,
			]);
			await chmod(temporary, 0o600);
			assertEvidenceHash(await Bun.file(temporary).bytes(), item);
			await rename(temporary, path);
		} else {
			assertEvidenceHash(await Bun.file(path).bytes(), item);
		}
	}
	return {
		jobId: entry.jobId,
		sourceRow: entry.sourceRow,
		domain: entry.domain,
		status: entry.status,
		reasonCode: entry.reasonCode,
		verifiedAt: new Date().toISOString(),
		evidence: captured,
		captureFailures: events.filter((e) => e.type === "evidence.capture_failed")
			.length,
	};
}

async function main(): Promise<void> {
	process.umask(0o077);
	const args = Bun.argv.slice(2);
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const repo = resolve(option("--repo") ?? process.cwd());
	const journal = resolve(
		option("--journal") ??
			join(repo, "artifacts/continuous-20260905/sender/journal.jsonl"),
	);
	const output = resolve(
		option("--output") ?? join(repo, "artifacts/continuous-20260905/collector"),
	);
	const jobIds = option("--job-ids")?.split(",");
	const once = args.includes("--once") || jobIds !== undefined;
	if (
		jobIds &&
		(!option("--output") || jobIds.some((id) => !JOB_ID_PATTERN.test(id)))
	)
		throw new Error("INVALID_JOB_IDS_OPTIONS");
	const token = process.env.FORM_AGENT_JOB_API_TOKEN;
	if (!token) throw new Error("API_TOKEN_REQUIRED");
	for (const path of [
		output,
		join(output, "verified"),
		join(output, "evidence"),
	]) {
		await mkdir(path, { recursive: true, mode: 0o700 });
		await chmod(path, 0o700);
	}
	const release = await acquireLock(join(output, "collector.pid"));
	let stopping = false;
	process.on("SIGTERM", () => {
		stopping = true;
	});
	process.on("SIGINT", () => {
		stopping = true;
	});
	const verified = new Map<string, Verified>();
	const failures = new Map<
		string,
		{ attempts: number; code: string; at: string; retryAt: number }
	>();
	try {
		for (const name of await readdir(join(output, "verified"))) {
			if (!name.endsWith(".json")) continue;
			const item = JSON.parse(
				await readFile(join(output, "verified", name), "utf8"),
			) as Verified;
			if (!JOB_ID_PATTERN.test(item.jobId) || !TERMINAL.has(item.status))
				throw new Error("INVALID_CHECKPOINT");
			verified.set(item.jobId, item);
		}
		console.log(
			JSON.stringify({
				event: "collector_started",
				pid: process.pid,
				resumed: verified.size,
			}),
		);
		do {
			let entries: TerminalEntry[] = [];
			let journalError: string | null = null;
			try {
				if (jobIds) {
					await runBounded(jobIds, 4, async (jobId) => {
						const response = await fetch(`${API}/jobs/${jobId}`, {
							headers: { authorization: `Bearer ${token}` },
							redirect: "manual",
							signal: AbortSignal.timeout(30_000),
						});
						if (!response.ok) throw new Error("API_READ_FAILED");
						const { job, evidence } = (await response.json()) as {
							job: {
								status: string;
								targetDomain: string;
								payload: { sourceRow?: number };
								result: { reasonCode: string | null } | null;
							};
							evidence: Evidence[];
						};
						const line = {
							event: "terminal",
							at: new Date().toISOString(),
							jobId,
							sourceRow: job.payload.sourceRow ?? 0,
							domain: job.targetDomain,
							status: job.status,
							reasonCode:
								job.status === "sent"
									? "SENT"
									: (job.result?.reasonCode ?? "NO_REASON"),
							evidence,
						};
						entries.push(...parseTerminalJournal(`${JSON.stringify(line)}\n`));
					});
				} else entries = parseTerminalJournal(await readFile(journal, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					journalError = "JOURNAL_READ_FAILED";
			}
			for (const entry of entries) {
				const checkpoint = verified.get(entry.jobId);
				if (
					checkpoint &&
					(checkpoint.sourceRow !== entry.sourceRow ||
						checkpoint.domain !== entry.domain ||
						checkpoint.status !== entry.status ||
						checkpoint.reasonCode !== entry.reasonCode ||
						JSON.stringify(sortedEvidence(checkpoint.evidence)) !==
							JSON.stringify(sortedEvidence(entry.evidence)))
				)
					verified.delete(entry.jobId);
			}
			const pending = entries.filter((item) => !verified.has(item.jobId));
			await runBounded(
				pending.filter(
					(item) => (failures.get(item.jobId)?.retryAt ?? 0) <= Date.now(),
				),
				4,
				async (entry) => {
					if (stopping) return;
					try {
						const result = await verifyTerminalEntry(
							entry,
							repo,
							output,
							token,
						);
						await atomicJson(
							join(output, "verified", `${entry.jobId}.json`),
							result,
						);
						verified.set(entry.jobId, result);
						failures.delete(entry.jobId);
						console.log(
							JSON.stringify({
								event: "verified",
								jobId: entry.jobId,
								sourceRow: entry.sourceRow,
								evidenceCount: result.evidence.length,
							}),
						);
					} catch (error) {
						const attempts = (failures.get(entry.jobId)?.attempts ?? 0) + 1;
						const code =
							error instanceof Error && /^[A-Z_]+$/.test(error.message)
								? error.message
								: "VERIFICATION_FAILED";
						failures.set(entry.jobId, {
							attempts,
							code,
							at: new Date().toISOString(),
							retryAt:
								Date.now() +
								Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6)),
						});
					}
				},
			);
			const byReason: Record<
				string,
				{ count: number; rows: number[]; jobIds: string[] }
			> = Object.create(null);
			for (const item of entries) {
				if (item.status === "sent") continue;
				const code = item.reasonCode ?? item.status;
				byReason[code] ??= { count: 0, rows: [], jobIds: [] };
				const bucket = byReason[code];
				bucket.count++;
				bucket.rows.push(item.sourceRow);
				bucket.jobIds.push(item.jobId);
			}
			await atomicJson(join(output, "tracker-candidates.json"), {
				at: new Date().toISOString(),
				note: "Diagnostic candidates only; reason codes do not establish a tool root cause.",
				byReason,
			});
			await atomicJson(join(output, "summary.json"), {
				at: new Date().toISOString(),
				pid: process.pid,
				terminal: entries.length,
				verified: entries.filter((entry) => verified.has(entry.jobId)).length,
				cumulativeVerified: verified.size,
				pending: entries.filter((e) => !verified.has(e.jobId)).length,
				evidenceCount: [...verified.values()].reduce(
					(sum, j) => sum + j.evidence.length,
					0,
				),
				journalError,
				failures: Object.fromEntries(failures),
			});
			if (once) {
				if (journalError || entries.some((entry) => !verified.has(entry.jobId)))
					process.exitCode = 1;
				break;
			}
			if (stopping) break;
			await Bun.sleep(5_000);
		} while (!stopping);
	} finally {
		await release();
	}
}
if (import.meta.main)
	main().catch((error) => {
		console.error(
			error instanceof Error && /^[A-Z_]+$/.test(error.message)
				? error.message
				: "COLLECTOR_FAILED",
		);
		process.exitCode = 1;
	});
