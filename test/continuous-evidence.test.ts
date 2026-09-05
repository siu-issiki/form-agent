import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertEvidenceAgreement,
	assertEvidenceHash,
	parseTerminalJournal,
	runBounded,
	verifyTerminalEntry,
} from "../tools/continuous-evidence";

const evidence = {
	stage: "before_submit",
	objectKey: "jobs/example-job/before_submit/example.jpg",
	contentType: "image/jpeg",
};
const entry = {
	event: "terminal" as const,
	at: "2026-09-05T00:00:00Z",
	jobId: "example-job",
	sourceRow: 109,
	domain: "example.com",
	status: "sent",
	reasonCode: "NO_REASON",
	evidence: [evidence],
};
test("waits for a complete journal line and deduplicates identical terminal records", () => {
	expect(parseTerminalJournal(JSON.stringify(entry))).toEqual([]);
	expect(
		parseTerminalJournal(
			`${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`,
		),
	).toEqual([entry]);
});
test("rejects conflicting terminal state and SQL/path injection IDs", () => {
	expect(() =>
		parseTerminalJournal(
			`${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, status: "uncertain" })}\n`,
		),
	).toThrow("CONFLICTING_TERMINAL_ENTRY");
	expect(() =>
		parseTerminalJournal(
			`${JSON.stringify({ ...entry, jobId: "bad' OR 1=1" })}\n`,
		),
	).toThrow("INVALID_JOURNAL_ENTRY");
	expect(() =>
		parseTerminalJournal(`${JSON.stringify({ ...entry, jobId: undefined })}\n`),
	).toThrow("INVALID_JOURNAL_ENTRY");
});
test("requires exact API, D1, and journal evidence sets, with valid hashes", () => {
	const captured = { ...evidence, sha256: "a".repeat(64) };
	expect(() =>
		assertEvidenceAgreement([evidence], [evidence], [captured], entry.jobId),
	).not.toThrow();
	expect(() =>
		assertEvidenceAgreement([evidence], [], [captured], entry.jobId),
	).toThrow("EVIDENCE_SET_MISMATCH");
	expect(() =>
		assertEvidenceAgreement([evidence], [evidence], [], entry.jobId),
	).toThrow("EVIDENCE_SET_MISMATCH");
	expect(() =>
		assertEvidenceAgreement(
			[evidence],
			[evidence],
			[captured, captured],
			entry.jobId,
		),
	).toThrow("DUPLICATE_EVIDENCE");
});
test("rejects corrupted R2 bytes and size mismatch", () => {
	const bytes = new TextEncoder().encode("evidence");
	const captured = {
		...evidence,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		byteLength: bytes.length,
	};
	expect(assertEvidenceHash(bytes, captured)).toBe(captured.sha256);
	expect(() =>
		assertEvidenceHash(new TextEncoder().encode("modified"), captured),
	).toThrow("EVIDENCE_HASH_MISMATCH");
	expect(() =>
		assertEvidenceHash(bytes, { ...captured, byteLength: 1 }),
	).toThrow("EVIDENCE_HASH_MISMATCH");
});
test("caps active reads at four and drains every item", async () => {
	let active = 0,
		peak = 0;
	const completed: number[] = [];
	await runBounded(
		Array.from({ length: 20 }, (_, i) => i),
		4,
		async (item) => {
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep(1);
			completed.push(item);
			active--;
		},
	);
	expect(peak).toBe(4);
	expect(completed).toHaveLength(20);
	expect(active).toBe(0);
});

test("continues collecting after a dead-lettered job instead of rejecting the entire journal", () => {
	const dead = {
		...entry,
		jobId: "dead-job",
		status: "dead_lettered",
		reasonCode: "NO_REASON",
		evidence: [],
	};
	const journal = `${JSON.stringify(dead)}\n${JSON.stringify(entry)}\n`;
	expect(parseTerminalJournal(journal)).toEqual([dead, entry]);
});
test("does not treat pending, running or submitting jobs as terminal", () => {
	for (const status of ["pending", "running", "submitting"])
		expect(() =>
			parseTerminalJournal(`${JSON.stringify({ ...entry, status })}\n`),
		).toThrow("INVALID_JOURNAL_ENTRY");
});

test("verifies a dead-lettered terminal through D1, API, and R2 without storing its payload", async () => {
	const output = await mkdtemp(join(tmpdir(), "collector-dead-lettered-"));
	await mkdir(join(output, "evidence"));
	const bytes = new TextEncoder().encode("managed evidence");
	const captured = {
		...evidence,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		byteLength: bytes.length,
	};
	const dead = { ...entry, status: "dead_lettered", reasonCode: "NO_REASON" };
	let d1Reads = 0,
		apiReads = 0,
		r2Reads = 0;
	try {
		const verified = await verifyTerminalEntry(
			dead,
			output,
			output,
			"test-token",
			async (_repo, args) => {
				if (args[0] === "d1") {
					d1Reads++;
					return JSON.stringify([
						{
							results: [
								{
									id: dead.jobId,
									target_domain: dead.domain,
									status: dead.status,
									source_row: dead.sourceRow,
									reason_code: null,
								},
							],
						},
						{
							results: [
								{
									type: "evidence.captured",
									data_json: JSON.stringify(captured),
								},
							],
						},
					]);
				}
				r2Reads++;
				const path = args[args.indexOf("--file") + 1];
				if (!path) throw new Error("MISSING_TEST_PATH");
				await Bun.write(path, bytes);
				return "";
			},
			async () => {
				apiReads++;
				return Response.json({
					job: {
						id: dead.jobId,
						status: dead.status,
						targetDomain: dead.domain,
						payload: {
							sourceRow: dead.sourceRow,
							privateBody: "must not be persisted",
						},
						result: null,
					},
					evidence: [evidence],
				});
			},
		);
		expect(verified.status).toBe("dead_lettered");
		expect(verified.evidence[0]?.sha256).toBe(captured.sha256);
		expect(JSON.stringify(verified)).not.toContain("must not be persisted");
		expect([d1Reads, apiReads, r2Reads]).toEqual([1, 1, 1]);
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});
