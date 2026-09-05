import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	truncate,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	buildCampaignJob,
	campaignApiHeaders,
	DEFAULT_CHOICE_CANDIDATES,
	jobContentFingerprint,
	jobInputFingerprint,
	mapRegistrationValues,
	mergeChoiceCandidates,
	readChoiceCandidates,
	resolveRedirectHosts,
} from "../src/campaign-import";
import {
	EFFECTIVE_DRY_RUN_KEY,
	JOB_STATUSES,
	type JobInput,
	type JobStatus,
} from "../src/job";
import { isRecord } from "../src/json-record";
import {
	PRODUCTION_BASE_URL,
	readCampaignRows,
	readRegistration,
	requiredOption,
} from "./campaign-common";
import {
	CandidateExcludedError,
	ContinuousState,
	type Control,
	type Entry,
	type EvidenceRef,
	type JournalEvent,
	type Lookup,
} from "./continuous-state";

interface Manifest {
	version: 1;
	runId: string;
	campaign: string;
	startRow: number;
	totalRows: number;
	approvedBy: string;
	approvedAt: string;
	sourceHashes: Record<string, string>;
	entries: Entry[];
}
const PRIVATE_FILES = [
	"campaign.csv",
	"registration.json",
	"choices.json",
] as const;
const VERSION_PATTERN = /^[a-f0-9-]{36}$/;
const digest = (value: Uint8Array | string) =>
	createHash("sha256").update(value).digest("hex");

/** Atomic replacement, with both bytes and rename synced before returning. */
export async function durableJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.tmp-${randomUUID()}`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/** Single writer. A crashed PID is reclaimed under a separate atomic mutex. */
export async function acquireLock(
	stateDir: string,
): Promise<() => Promise<void>> {
	const lock = `${stateDir}/runner.lock`;
	const owner = { pid: process.pid, token: randomUUID() };
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return !isRecord(error) || error.code !== "ESRCH";
		}
	};
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const reclaim = `${stateDir}/runner.reclaim`;
		await mkdir(reclaim, { mode: 0o700 });
		try {
			const previous: unknown = JSON.parse(
				await readFile(`${lock}/owner.json`, "utf8"),
			);
			if (
				!isRecord(previous) ||
				!Number.isInteger(previous.pid) ||
				alive(Number(previous.pid))
			)
				throw new Error("RUNNER_ALREADY_ACTIVE_OR_LOCK_UNVERIFIED");
			const stale = `${stateDir}/runner.stale-${randomUUID()}`;
			await rename(lock, stale);
			await rm(stale, { recursive: true });
			await mkdir(lock, { mode: 0o700 });
		} finally {
			await rm(reclaim, { recursive: true });
		}
	}
	await durableJson(`${lock}/owner.json`, owner);
	return async () => {
		const current: unknown = JSON.parse(
			await readFile(`${lock}/owner.json`, "utf8"),
		);
		if (isRecord(current) && current.token === owner.token)
			await rm(lock, { recursive: true });
	};
}

export async function readJournal(path: string): Promise<JournalEvent[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
	// An incomplete final append cannot precede a POST: intent append is synced first.
	const end = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1;
	if (end !== text.length)
		await truncate(path, Buffer.byteLength(text.slice(0, end)));
	text = text.slice(0, end);
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (
				!isRecord(value) ||
				typeof value.event !== "string" ||
				typeof value.at !== "string"
			)
				throw new Error("INVALID_JOURNAL");
			return value as unknown as JournalEvent;
		});
}

export function excludedUrl(value: string): string | undefined {
	const url = new URL(value);
	let path: string;
	try {
		path = decodeURIComponent(`${url.pathname}${url.search}`);
	} catch {
		return "INVALID_URL_ENCODING";
	}
	if (
		/(?:document|download|brochure|catalog|資料請求|資料ダウンロード)/i.test(
			path,
		)
	)
		return "DOCUMENT_REQUEST_URL";
	if (
		/(?:^|[/?=&_-])(?:career(?:s)?|recruit(?:ment)?|jobs?|採用|求人)(?:[/?=&_-]|$)/i.test(
			path,
		)
	)
		return "RECRUITMENT_URL";
	return undefined;
}

async function prepareManifest(
	stateDir: string,
	options: Map<string, string>,
): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	await chmod(stateDir, 0o700);
	const unlock = await acquireLock(stateDir);
	try {
		if (await Bun.file(`${stateDir}/manifest.json`).exists())
			throw new Error("MANIFEST_ALREADY_EXISTS");
		const startRow = Number(options.get("start-row") ?? "109");
		const campaign = requiredOption(options, "campaign");
		const approvedBy = requiredOption(options, "approved-by");
		const releaseVersion = requiredOption(options, "release");
		if (
			!Number.isInteger(startRow) ||
			startRow < 2 ||
			!VERSION_PATTERN.test(releaseVersion)
		)
			throw new Error("INVALID_PREPARATION_OPTIONS");
		if (
			!/^[a-z0-9][a-z0-9-]{0,80}$/.test(campaign) ||
			approvedBy.length < 1 ||
			approvedBy.length > 64
		)
			throw new Error("INVALID_APPROVAL");
		await mkdir(`${stateDir}/private`, { mode: 0o700 });
		await mkdir(`${stateDir}/prepared`, { mode: 0o700 });
		const sources = [
			[requiredOption(options, "csv"), "campaign.csv"],
			[requiredOption(options, "registration"), "registration.json"],
		] as const;
		for (const [source, name] of sources) {
			const bytes = await readFile(source);
			const file = await open(`${stateDir}/private/${name}`, "wx", 0o600);
			try {
				await file.writeFile(bytes);
				await file.sync();
			} finally {
				await file.close();
			}
		}
		const choices = mergeChoiceCandidates(
			DEFAULT_CHOICE_CANDIDATES,
			options.has("choices")
				? readChoiceCandidates(
						await Bun.file(requiredOption(options, "choices")).json(),
					)
				: {},
		);
		await durableJson(`${stateDir}/private/choices.json`, choices);
		const sourceHashes: Record<string, string> = {};
		for (const name of PRIVATE_FILES)
			sourceHashes[name] = digest(
				await readFile(`${stateDir}/private/${name}`),
			);
		const { rows, filtered } = await readCampaignRows(
			`${stateDir}/private/campaign.csv`,
		);
		const values = mapRegistrationValues(
			await readRegistration(`${stateDir}/private/registration.json`),
		);
		const entries: Entry[] = [];
		const seen = new Set<string>();
		for (const candidate of filtered.eligible.filter(
			(row) => row.rowNumber >= startRow,
		)) {
			const job = await buildCampaignJob(
				candidate,
				values,
				campaign,
				{ finalUrl: candidate.targetUrl, allowedHosts: [] },
				choices,
			);
			const exclusion =
				excludedUrl(candidate.targetUrl) ??
				(seen.has(candidate.companyDomain)
					? "DUPLICATE_SOURCE_DOMAIN"
					: undefined);
			seen.add(candidate.companyDomain);
			entries.push({
				sourceRow: candidate.rowNumber,
				domain: candidate.companyDomain,
				targetUrl: candidate.targetUrl,
				jobId: job.id,
				contentFingerprint: await jobContentFingerprint(
					job.targetUrl,
					job.companyId,
					job.payload,
				),
				...(exclusion ? { exclusion } : {}),
			});
		}
		if (!entries.length) throw new Error("NO_REMAINING_ROWS");
		const manifest: Manifest = {
			version: 1,
			runId: campaign,
			campaign,
			approvedBy,
			approvedAt: new Date().toISOString(),
			startRow,
			totalRows: rows.length,
			sourceHashes,
			entries,
		};
		await durableJson(`${stateDir}/manifest.json`, manifest);
		await durableJson(`${stateDir}/control.json`, {
			revision: randomUUID(),
			pauseNewAdmissions: true,
			releaseVersion,
		} satisfies Control);
		console.log(
			JSON.stringify({
				event: "prepared",
				runId: campaign,
				startRow,
				dataRows: rows.length,
				lastSourceRow: rows.length + 1,
				entries: entries.length,
				excluded: entries.filter((row) => row.exclusion).length,
				registered: 0,
			}),
		);
	} finally {
		await unlock();
	}
}

async function readControl(path: string): Promise<Control> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (
		!isRecord(value) ||
		typeof value.revision !== "string" ||
		!value.revision ||
		typeof value.pauseNewAdmissions !== "boolean" ||
		typeof value.releaseVersion !== "string" ||
		!VERSION_PATTERN.test(value.releaseVersion) ||
		(value.clearHalt !== undefined && typeof value.clearHalt !== "boolean")
	)
		throw new Error("INVALID_CONTROL");
	return value as unknown as Control;
}
async function wranglerJson(args: string[]): Promise<unknown> {
	const child = Bun.spawn(
		[`${resolve(import.meta.dir, "../node_modules/.bin/wrangler")}`, ...args],
		{ cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
	);
	const timer = setTimeout(() => child.kill(), 30_000);
	try {
		const [stdout] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if ((await child.exited) !== 0) throw new Error("CLOUDFLARE_READ_FAILED");
		return JSON.parse(stdout);
	} finally {
		clearTimeout(timer);
	}
}
async function verifyRelease(version: string): Promise<boolean> {
	const value = await wranglerJson(["deployments", "list", "--json"]);
	if (!Array.isArray(value)) return false;
	const newest = value
		.filter(isRecord)
		.sort((a, b) =>
			String(b.created_on).localeCompare(String(a.created_on)),
		)[0];
	if (
		!newest ||
		!Array.isArray(newest.versions) ||
		newest.versions.length !== 1
	)
		return false;
	const active: unknown = newest.versions[0];
	return (
		isRecord(active) &&
		active.version_id === version &&
		active.percentage === 100
	);
}
async function priorDomains(): Promise<Set<string>> {
	const value = await wranglerJson([
		"d1",
		"execute",
		"DB",
		"--remote",
		"--command",
		"SELECT DISTINCT target_domain FROM jobs WHERE real_send=1",
		"--json",
	]);
	const first: unknown = Array.isArray(value) ? value[0] : undefined;
	if (
		!isRecord(first) ||
		first.success !== true ||
		!Array.isArray(first.results)
	)
		throw new Error("INVALID_D1_HISTORY");
	const domains = new Set<string>();
	for (const row of first.results) {
		if (!isRecord(row) || typeof row.target_domain !== "string")
			throw new Error("INVALID_D1_DOMAIN");
		domains.add(row.target_domain);
	}
	return domains;
}

/** Exact-ID reconciliation; malformed/mismatched reads never free a slot. */
export async function lookupRegisteredJob(
	expected: JobInput,
	token: string,
	fetcher: typeof fetch = fetch,
): Promise<Lookup> {
	const headers = campaignApiHeaders(token);
	const response = await fetcher(`${PRODUCTION_BASE_URL}/jobs/${expected.id}`, {
		headers,
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		return { kind: response.status === 404 ? "missing" : "unknown" };
	}
	const body: unknown = await response.json();
	if (!isRecord(body) || !isRecord(body.job)) return { kind: "unknown" };
	const job = body.job;
	if (
		!isRecord(job.payload) ||
		job.payload[EFFECTIVE_DRY_RUN_KEY] !== false ||
		job.payload._formAgentRealSendGuardExempt === true ||
		job.id !== expected.id ||
		job.companyId !== expected.companyId ||
		job.targetDomain !== expected.targetDomain ||
		JSON.stringify(job.allowedHosts) !==
			JSON.stringify(expected.allowedHosts) ||
		(await jobInputFingerprint(job.targetUrl, job.payload, true)) !==
			(await jobInputFingerprint(expected.targetUrl, expected.payload, true))
	)
		return { kind: "mismatched" };
	if (
		typeof job.status !== "string" ||
		!JOB_STATUSES.includes(job.status as JobStatus) ||
		!Number.isInteger(job.attemptCount)
	)
		return { kind: "unknown" };
	const evidence: EvidenceRef[] = [];
	if (!Array.isArray(body.evidence)) return { kind: "unknown" };
	for (const item of body.evidence) {
		if (
			!isRecord(item) ||
			typeof item.stage !== "string" ||
			typeof item.objectKey !== "string" ||
			!item.objectKey.startsWith(`jobs/${expected.id}/`) ||
			typeof item.contentType !== "string"
		)
			return { kind: "unknown" };
		evidence.push({
			stage: item.stage,
			objectKey: item.objectKey,
			contentType: item.contentType,
		});
	}
	const reasonCode =
		isRecord(job.result) && typeof job.result.reasonCode === "string"
			? job.result.reasonCode
			: null;
	return {
		kind: "found",
		status: job.status as JobStatus,
		reasonCode,
		evidence,
		attemptCount: job.attemptCount as number,
	};
}

async function run(stateDir: string): Promise<void> {
	const token =
		process.env.JOB_API_TOKEN ?? process.env.FORM_AGENT_JOB_API_TOKEN;
	if (!token) throw new Error("JOB_API_TOKEN_REQUIRED");
	const unlock = await acquireLock(stateDir);
	let journal: Awaited<ReturnType<typeof open>> | undefined;
	let stopRequested = false;
	const requestStop = () => {
		stopRequested = true;
	};
	process.on("SIGTERM", requestStop);
	process.on("SIGINT", requestStop);
	try {
		const manifest = JSON.parse(
			await readFile(`${stateDir}/manifest.json`, "utf8"),
		) as Manifest;
		if (
			manifest.version !== 1 ||
			manifest.entries.some(
				(row) => !Number.isInteger(row.sourceRow) || !row.jobId || !row.domain,
			) ||
			new Set(
				manifest.entries
					.filter((row) => !row.exclusion)
					.map((row) => row.jobId),
			).size !== manifest.entries.filter((row) => !row.exclusion).length
		)
			throw new Error("INVALID_MANIFEST");
		for (const name of PRIVATE_FILES)
			if (
				digest(await readFile(`${stateDir}/private/${name}`)) !==
				manifest.sourceHashes[name]
			)
				throw new Error("SOURCE_HASH_MISMATCH");
		const { filtered } = await readCampaignRows(
			`${stateDir}/private/campaign.csv`,
		);
		const candidates = new Map(
			filtered.eligible.map((row) => [row.rowNumber, row]),
		);
		const values = mapRegistrationValues(
			await readRegistration(`${stateDir}/private/registration.json`),
		);
		const choices = await Bun.file(`${stateDir}/private/choices.json`).json();
		const events = await readJournal(`${stateDir}/journal.jsonl`);
		journal = await open(`${stateDir}/journal.jsonl`, "a", 0o600);
		// Persist the new journal directory entry before any registration intent.
		const stateDirectory = await open(stateDir, "r");
		try {
			await stateDirectory.sync();
		} finally {
			await stateDirectory.close();
		}
		const prepared = new Map<string, JobInput>();
		const readPrepared = async (entry: Entry): Promise<JobInput> => {
			let job = prepared.get(entry.jobId);
			if (!job) {
				const record: unknown = await Bun.file(
					`${stateDir}/prepared/${entry.jobId}.json`,
				).json();
				if (
					!isRecord(record) ||
					!isRecord(record.job) ||
					record.sha256 !== digest(JSON.stringify(record.job))
				)
					throw new Error("PREPARED_HASH_MISMATCH");
				job = record.job as unknown as JobInput;
				prepared.set(entry.jobId, job);
			}
			if (
				job.id !== entry.jobId ||
				job.targetUrl !== entry.targetUrl ||
				(await jobContentFingerprint(
					job.targetUrl,
					job.companyId,
					job.payload,
				)) !== entry.contentFingerprint
			)
				throw new Error("PREPARED_CONTENT_MISMATCH");
			return job;
		};
		const headers = campaignApiHeaders(token);
		const state = new ContinuousState(manifest.entries, events, {
			now: Date.now,
			control: async () => {
				const control = await readControl(`${stateDir}/control.json`);
				return stopRequested
					? { ...control, pauseNewAdmissions: true }
					: control;
			},
			verifyRelease,
			priorDomains,
			append: async (event) => {
				if (!journal) throw new Error("JOURNAL_CLOSED");
				await journal.writeFile(`${JSON.stringify(event)}\n`);
				await journal.sync();
			},
			prepare: async (entry) => {
				if (await Bun.file(`${stateDir}/prepared/${entry.jobId}.json`).exists())
					return readPrepared(entry);
				const candidate = candidates.get(entry.sourceRow);
				if (
					!candidate ||
					candidate.targetUrl !== entry.targetUrl ||
					candidate.companyDomain !== entry.domain
				)
					throw new Error("ROW_IDENTITY_MISMATCH");
				let resolution: Awaited<ReturnType<typeof resolveRedirectHosts>>;
				try {
					resolution = await resolveRedirectHosts(candidate.targetUrl);
				} catch {
					throw new CandidateExcludedError("REDIRECT_PREFLIGHT_FAILED");
				}
				const exclusion = excludedUrl(resolution.finalUrl);
				if (exclusion) throw new CandidateExcludedError(exclusion);
				const job = await buildCampaignJob(
					candidate,
					values,
					manifest.campaign,
					resolution,
					choices,
					{
						dryRun: false,
						approval: {
							approvedBy: manifest.approvedBy,
							approvedAt: manifest.approvedAt,
							mode: "direct",
							contentFingerprint: entry.contentFingerprint,
							note: "全残候補の継続送信依頼を継承。資料請求・既送ドメイン除外、ジョブ内入力・画像・用途審査を維持。",
						},
					},
				);
				if (
					job.id !== entry.jobId ||
					(await jobContentFingerprint(
						job.targetUrl,
						job.companyId,
						job.payload,
					)) !== entry.contentFingerprint
				)
					throw new Error("FROZEN_CONTENT_MISMATCH");
				const path = `${stateDir}/prepared/${entry.jobId}.json`;
				await durableJson(path, { job, sha256: digest(JSON.stringify(job)) });
				prepared.set(entry.jobId, job);
				return job;
			},
			lookup: async (entry) =>
				lookupRegisteredJob(await readPrepared(entry), token),
			register: async (job) => {
				const response = await fetch(`${PRODUCTION_BASE_URL}/jobs`, {
					method: "POST",
					headers,
					body: JSON.stringify(job),
					redirect: "manual",
					signal: AbortSignal.timeout(15_000),
				});
				await response.body?.cancel();
				if (response.status === 200 || response.status === 201)
					return "accepted";
				return [400, 401, 403, 409].includes(response.status)
					? "rejected"
					: "unknown";
			},
		});
		const writeStatus = async () =>
			durableJson(`${stateDir}/status.json`, {
				pid: process.pid,
				runId: manifest.runId,
				updatedAt: new Date().toISOString(),
				observedControlRevision: state.observedControl?.revision ?? null,
				releaseVersion: state.observedControl?.releaseVersion ?? null,
				pauseNewAdmissions: state.observedControl?.pauseNewAdmissions ?? true,
				activeCount: state.active.length,
				maxInflight: 20,
				sourceRowsTotal: manifest.entries.length,
				registrationUnknownCount: state.active.filter(
					(row) => row.status === undefined,
				).length,
				drained: state.drained,
				remaining: state.waiting.length,
				terminalCount: state.rows.filter((row) => row.phase === "terminal")
					.length,
				excludedCount: state.rows.filter((row) => row.phase === "excluded")
					.length,
				haltReason: state.haltReason,
				finished: state.finished,
				stopRequested,
				active: state.active.map((row) => ({
					jobId: row.entry.jobId,
					sourceRow: row.entry.sourceRow,
					domain: row.entry.domain,
					status: row.status ?? "registration_unknown",
				})),
			});
		await writeStatus();
		while (!state.finished) {
			await state.tick();
			await writeStatus();
			if (stopRequested && state.active.length === 0) break;
			if (
				state.active.length >= 20 ||
				!state.waiting.length ||
				state.haltReason ||
				state.observedControl?.pauseNewAdmissions
			)
				await Bun.sleep(2_000);
		}
		await writeStatus();
	} finally {
		process.off("SIGTERM", requestStop);
		process.off("SIGINT", requestStop);
		await journal?.close();
		await unlock();
	}
}

async function main(): Promise<void> {
	const [command, ...args] = Bun.argv.slice(2);
	const options = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const name = args[index];
		if (name === "--confirm-real-send" || name === "--clear-halt") {
			flags.add(name);
			continue;
		}
		if (
			!name?.startsWith("--") ||
			!args[index + 1] ||
			args[index + 1]?.startsWith("--")
		)
			throw new Error("INVALID_OPTIONS");
		options.set(name.slice(2), args[++index] as string);
	}
	const stateDir = resolve(requiredOption(options, "state"));
	if (command === "prepare") return prepareManifest(stateDir, options);
	if (command === "run") {
		if (!flags.has("--confirm-real-send"))
			throw new Error("CONFIRM_REAL_SEND_REQUIRED");
		return run(stateDir);
	}
	if (command === "status") {
		console.log(await readFile(`${stateDir}/status.json`, "utf8"));
		return;
	}
	if (command === "pause" || command === "resume") {
		const current = await readControl(`${stateDir}/control.json`);
		const releaseVersion =
			command === "resume"
				? requiredOption(options, "release")
				: current.releaseVersion;
		if (!VERSION_PATTERN.test(releaseVersion))
			throw new Error("INVALID_RELEASE");
		const next: Control = {
			revision: randomUUID(),
			pauseNewAdmissions: command === "pause",
			releaseVersion,
			...(flags.has("--clear-halt") ? { clearHalt: true } : {}),
		};
		await durableJson(`${stateDir}/control.json`, next);
		console.log(JSON.stringify(next));
		return;
	}
	throw new Error("Expected prepare, run, pause, resume or status");
}
if (import.meta.main) {
	main().catch(() => {
		console.error(
			JSON.stringify({
				event: "runner_fatal",
				reasonCode: "RUNNER_STOPPED_REVIEW_REQUIRED",
			}),
		);
		process.exitCode = 1;
	});
}
