import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { JobInput } from "../src/job";
import {
	acquireLock,
	durableJson,
	excludedUrl,
	lookupRegisteredJob,
	readJournal,
} from "../tools/campaign-continuous";
import {
	CandidateExcludedError,
	ContinuousState,
	type Control,
	type Entry,
	type JournalEvent,
	type Lookup,
	type RunnerIO,
} from "../tools/continuous-state";

function setup(count = 4, maxInflight = 2) {
	const entries: Entry[] = Array.from({ length: count }, (_, i) => ({
		sourceRow: i + 109,
		domain: `c${i}.test`,
		jobId: `job-${i}`,
		targetUrl: `https://c${i}.test/contact`,
		contentFingerprint: "a".repeat(64),
	}));
	const journal: JournalEvent[] = [];
	const posts: string[] = [];
	let control: Control = {
		revision: "one",
		pauseNewAdmissions: false,
		releaseVersion: "release-one",
	};
	const results = new Map<string, Lookup>();
	const io: RunnerIO = {
		now: () => 1000,
		control: async () => control,
		verifyRelease: async () => true,
		lookup: async (entry) =>
			results.get(entry.jobId) ?? {
				kind: "found",
				status: "running",
				reasonCode: null,
				evidence: [],
				attemptCount: 1,
			},
		prepare: async (entry) => ({ id: entry.jobId }) as JobInput,
		priorDomains: async () => new Set(),
		register: async (job) => {
			expect(journal.at(-1)?.event).toBe("registration_intent");
			posts.push(job.id);
			return "accepted";
		},
		append: async (event) => {
			journal.push(event);
		},
	};
	const state = new ContinuousState(entries, [], io, maxInflight);
	return {
		entries,
		journal,
		posts,
		results,
		io,
		state,
		pause: (revision = "two") => {
			control = { ...control, revision, pauseNewAdmissions: true };
		},
		resume: () => {
			control = {
				revision: "three",
				pauseNewAdmissions: false,
				releaseVersion: "release-two",
			};
		},
	};
}

describe("continuous admissions", () => {
	test("fills a free slot when one job ends without waiting for the other nineteen", async () => {
		const f = setup(23, 20);
		for (let i = 0; i < 20; i++) await f.state.tick();
		expect(f.posts).toHaveLength(20);
		f.results.set("job-3", {
			kind: "found",
			status: "sent",
			reasonCode: null,
			evidence: [
				{
					stage: "after_submit",
					objectKey: "jobs/job-3/after_submit/x.jpg",
					contentType: "image/jpeg",
				},
			],
			attemptCount: 1,
		});
		await f.state.tick();
		expect(f.posts).toHaveLength(21);
		expect(f.state.active).toHaveLength(20);
		expect(f.state.rows[3]?.phase).toBe("terminal");
		expect(
			f.journal.find((event) => event.event === "terminal")?.evidence,
		).toHaveLength(1);
	});
	test("pending, running, submitting and unknown registration all retain slots", async () => {
		const f = setup(5, 3);
		f.io.register = async (job) => {
			f.posts.push(job.id);
			return "unknown";
		};
		await f.state.tick();
		await f.state.tick();
		await f.state.tick();
		f.results.set("job-0", {
			kind: "found",
			status: "pending",
			reasonCode: null,
			evidence: [],
			attemptCount: 0,
		});
		f.results.set("job-1", {
			kind: "found",
			status: "submitting",
			reasonCode: null,
			evidence: [],
			attemptCount: 1,
		});
		f.results.set("job-2", { kind: "unknown" });
		await f.state.tick();
		expect(f.posts).toHaveLength(3);
		expect(f.state.active).toHaveLength(3);
	});
	test("resume reconciles durable intent and never repeats a POST after a lost response or crash", async () => {
		const f = setup();
		f.io.register = async (job) => {
			f.posts.push(job.id);
			throw new Error("lost");
		};
		await f.state.tick();
		f.pause();
		f.results.set("job-0", {
			kind: "found",
			status: "uncertain",
			reasonCode: "SUBMIT_CONFIRMATION_NOT_OBSERVED",
			evidence: [],
			attemptCount: 1,
		});
		const resumed = new ContinuousState(f.entries, f.journal, f.io, 2);
		await resumed.tick();
		expect(f.posts).toEqual(["job-0"]);
		expect(resumed.drained).toBe(true);
		expect(resumed.rows[0]?.phase).toBe("terminal");
	});
	test("a crash between durable intent and POST stays occupied and halts after unresolved exact-ID reads", async () => {
		const f = setup();
		const events: JournalEvent[] = [
			{
				event: "registration_intent",
				at: new Date(1000).toISOString(),
				jobId: "job-0",
				sourceRow: 109,
				domain: "c0.test",
			},
		];
		f.io.lookup = async () => ({ kind: "missing" });
		const state = new ContinuousState(f.entries, events, f.io, 1);
		await state.tick();
		await state.tick();
		await state.tick();
		expect(state.active).toHaveLength(1);
		expect(f.posts).toHaveLength(0);
		expect(state.haltReason).toBe("REGISTRATION_LOOKUP_UNRESOLVED");
	});
	test("a mismatch halts admissions and continues monitoring active work", async () => {
		const f = setup();
		await f.state.tick();
		f.results.set("job-0", { kind: "mismatched" });
		await f.state.tick();
		expect(f.posts).toHaveLength(1);
		expect(f.state.haltReason).toBe("REGISTRATION_LOOKUP_UNRESOLVED");
		f.results.set("job-0", {
			kind: "found",
			status: "failed",
			reasonCode: "TEST_FAILED",
			evidence: [],
			attemptCount: 1,
		});
		await f.state.tick();
		expect(f.state.active).toHaveLength(0);
		expect(f.posts).toHaveLength(1);
	});
	test("pause is re-read after preparation; drained acknowledges that revision", async () => {
		const f = setup();
		f.io.prepare = async (entry) => {
			f.pause("pause-during-preflight");
			return { id: entry.jobId } as JobInput;
		};
		await f.state.tick();
		expect(f.posts).toHaveLength(0);
		expect(f.state.observedControl?.revision).toBe("pause-during-preflight");
		expect(f.state.drained).toBe(true);
	});
	test("resume verifies new release and only admits untouched rows", async () => {
		const f = setup();
		await f.state.tick();
		f.pause();
		f.results.set("job-0", {
			kind: "found",
			status: "uncertain",
			reasonCode: "UNKNOWN",
			evidence: [],
			attemptCount: 1,
		});
		await f.state.tick();
		expect(f.state.drained).toBe(true);
		const releases: string[] = [];
		f.io.verifyRelease = async (version) => {
			releases.push(version);
			return true;
		};
		f.resume();
		await f.state.tick();
		expect(releases).toEqual(["release-two"]);
		expect(f.posts).toEqual(["job-0", "job-1"]);
	});
	test("release mismatch, D1 failure and timeout each halt new admissions", async () => {
		const release = setup();
		release.io.verifyRelease = async () => false;
		await release.state.tick();
		expect(release.state.haltReason).toBe("RELEASE_NOT_VERIFIED");
		expect(release.posts).toHaveLength(0);
		const d1 = setup();
		d1.io.priorDomains = async () => {
			throw new Error("offline");
		};
		await d1.state.tick();
		expect(d1.state.haltReason).toBe("D1_HISTORY_UNAVAILABLE");
		expect(d1.posts).toHaveLength(0);
		const age = setup();
		await age.state.tick();
		age.io.now = () => 25 * 60_000;
		await age.state.tick();
		expect(age.state.haltReason).toBe("ACTIVE_JOB_TIMEOUT");
		expect(age.posts).toHaveLength(1);
	});
	test("domain history excludes previous failed/uncertain sends before a POST", async () => {
		const f = setup();
		f.io.priorDomains = async () => new Set(["c0.test"]);
		await f.state.tick();
		expect(f.posts).toHaveLength(0);
		expect(f.state.rows[0]?.phase).toBe("excluded");
		await f.state.tick();
		expect(f.posts).toEqual(["job-1"]);
	});
	test("network preflight failure skips one row; frozen-content failure halts", async () => {
		const f = setup();
		f.io.prepare = async () => {
			throw new CandidateExcludedError("REDIRECT_PREFLIGHT_FAILED");
		};
		await f.state.tick();
		expect(f.state.rows[0]?.phase).toBe("excluded");
		expect(f.state.haltReason).toBeNull();
		f.io.prepare = async () => {
			throw new Error("FROZEN_CONTENT_MISMATCH");
		};
		await f.state.tick();
		expect(f.state.haltReason).toBe("PREPARATION_FAILED");
		expect(f.state.rows[1]?.phase).toBe("waiting");
	});
	test("failure to durably append intent prevents a POST", async () => {
		const f = setup();
		f.io.append = async () => {
			throw new Error("disk full");
		};
		await expect(f.state.tick()).rejects.toThrow("disk full");
		expect(f.posts).toHaveLength(0);
	});
	test("rejected POST halts and is never automatically retried", async () => {
		const f = setup();
		f.io.register = async (job) => {
			f.posts.push(job.id);
			return "rejected";
		};
		await f.state.tick();
		await f.state.tick();
		expect(f.posts).toEqual(["job-0"]);
		expect(f.state.rows[0]?.phase).toBe("excluded");
		expect(f.state.haltReason).toBe("REGISTRATION_REJECTED");
	});
});

describe("durable local state", () => {
	test("single writer excludes another runner and release permits resume", async () => {
		const dir = await mkdtemp("/tmp/continuous-lock-test-");
		try {
			const unlock = await acquireLock(dir);
			await expect(acquireLock(dir)).rejects.toThrow();
			await unlock();
			const second = await acquireLock(dir);
			await second();
		} finally {
			await rm(dir, { recursive: true });
		}
	});
	test("an incomplete journal tail is removed without losing complete intent", async () => {
		const dir = await mkdtemp("/tmp/continuous-journal-test-");
		const event: JournalEvent = {
			event: "registration_intent",
			at: "2026-09-05T00:00:00Z",
			jobId: "job-0",
		};
		try {
			await writeFile(`${dir}/journal`, `${JSON.stringify(event)}\n{"event":`);
			expect(await readJournal(`${dir}/journal`)).toEqual([event]);
			expect(await readFile(`${dir}/journal`, "utf8")).toBe(
				`${JSON.stringify(event)}\n`,
			);
			await durableJson(`${dir}/state`, { ok: true });
			expect(JSON.parse(await readFile(`${dir}/state`, "utf8"))).toEqual({
				ok: true,
			});
		} finally {
			await rm(dir, { recursive: true });
		}
	});
	test.each([
		"https://site.test/recruit/entry",
		"https://site.test/careers",
		"https://site.test/contact?type=document",
		"https://site.test/資料請求",
	])("excludes dedicated URL %s", (url) => {
		expect(excludedUrl(url)).toBeDefined();
	});
	test("keeps ordinary inquiry URL for runtime purpose review", () => {
		expect(excludedUrl("https://site.test/contact")).toBeUndefined();
	});
});

describe("exact production API reconciliation without a network", () => {
	const expected: JobInput = {
		id: "job-1",
		companyId: "company-1",
		companyName: "Synthetic",
		targetUrl: "https://company.test/contact",
		targetDomain: "company.test",
		allowedHosts: [],
		payload: {
			_formAgentDryRun: false,
			_formAgentMaxAttempts: 1,
			formValues: { email: "sender@example.test", message: "Invitation" },
			_formAgentSendApproval: {
				approvedBy: "operator",
				approvedAt: "2026-09-05T00:00:00Z",
				mode: "direct",
				contentFingerprint: "a".repeat(64),
			},
		},
	};
	const stored = () => ({
		...structuredClone(expected),
		payload: {
			...structuredClone(expected.payload),
			_formAgentEffectiveDryRun: false,
		},
		status: "sent",
		attemptCount: 1,
		result: { reasonCode: null },
	});
	const read = (body: unknown, status = 200) =>
		lookupRegisteredJob(expected, "synthetic-test-token", (async (
			url,
			init,
		) => {
			expect(url).toBe("https://form-agent.form-agent.workers.dev/jobs/job-1");
			expect(init?.redirect).toBe("manual");
			expect(init?.method).toBeUndefined();
			return Response.json(body, { status });
		}) as typeof fetch);
	test("accepts only the exact content, approval, effective mode and evidence owner", async () => {
		expect(
			await read({
				job: stored(),
				evidence: [
					{
						stage: "after_submit",
						objectKey: "jobs/job-1/after_submit/test.jpg",
						contentType: "image/jpeg",
					},
				],
			}),
		).toMatchObject({ kind: "found", status: "sent", attemptCount: 1 });
	});
	test.each([
		"id",
		"company",
		"hosts",
		"mode",
		"message",
		"approval",
		"exempt",
	])("does not accept changed %s", async (field) => {
		const job = stored();
		if (field === "id") job.id = "other";
		if (field === "company") job.companyId = "other";
		if (field === "hosts") job.allowedHosts = ["other.test"];
		if (field === "mode") job.payload._formAgentEffectiveDryRun = true;
		if (field === "message")
			(job.payload as Record<string, unknown>).formValues = {
				message: "changed",
			};
		if (field === "approval")
			(job.payload as Record<string, unknown>)._formAgentSendApproval = {
				approvedBy: "other",
			};
		if (field === "exempt")
			(job.payload as Record<string, unknown>)._formAgentRealSendGuardExempt =
				true;
		expect(await read({ job, evidence: [] })).toEqual({ kind: "mismatched" });
	});
	test("keeps 404, non-OK, invalid status and wrong-owner evidence unresolved", async () => {
		expect(await read({}, 404)).toEqual({ kind: "missing" });
		expect(await read({}, 503)).toEqual({ kind: "unknown" });
		expect(
			await read({ job: { ...stored(), status: "complete" }, evidence: [] }),
		).toEqual({ kind: "unknown" });
		expect(
			await read({
				job: stored(),
				evidence: [
					{
						stage: "after_submit",
						objectKey: "jobs/other/after_submit/x.jpg",
						contentType: "image/jpeg",
					},
				],
			}),
		).toEqual({ kind: "unknown" });
	});
});

test("a release value change during preflight cannot evade verification by reusing a revision", async () => {
	const f = setup();
	let reads = 0;
	f.io.control = async () => ({
		revision: "same",
		pauseNewAdmissions: false,
		releaseVersion: ++reads === 1 ? "one" : "two",
	});
	await f.state.tick();
	expect(f.posts).toHaveLength(0);
});

test("clear-halt cannot clear a mismatch found by the current admission tick", async () => {
	const f = setup();
	await f.state.tick();
	f.results.set("job-0", { kind: "mismatched" });
	f.io.control = async () => ({
		revision: "clear",
		pauseNewAdmissions: false,
		releaseVersion: "release-one",
		clearHalt: true,
	});
	await f.state.tick();
	expect(f.posts).toEqual(["job-0"]);
	expect(f.state.haltReason).toBe("REGISTRATION_LOOKUP_UNRESOLVED");
});
test("detects an external deployment change before the next admission", async () => {
	const f = setup();
	await f.state.tick();
	f.io.verifyRelease = async () => false;
	await f.state.tick();
	expect(f.posts).toEqual(["job-0"]);
	expect(f.state.haltReason).toBe("RELEASE_NOT_VERIFIED");
});
