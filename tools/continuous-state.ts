import type { JobInput, JobStatus } from "../src/job";
import { TERMINAL_JOB_STATUSES } from "../src/job";

export class CandidateExcludedError extends Error {}

export interface Entry {
	sourceRow: number;
	domain: string;
	jobId: string;
	targetUrl: string;
	contentFingerprint: string;
	exclusion?: string;
}
export interface Control {
	revision: string;
	pauseNewAdmissions: boolean;
	releaseVersion: string;
	clearHalt?: boolean;
}
export interface EvidenceRef {
	stage: string;
	objectKey: string;
	contentType: string;
}
export interface JournalEvent {
	event:
		| "registration_intent"
		| "registered"
		| "terminal"
		| "excluded"
		| "lookup_error"
		| "halt"
		| "halt_cleared";
	at: string;
	jobId?: string;
	sourceRow?: number;
	domain?: string;
	status?: JobStatus;
	reasonCode?: string;
	evidence?: EvidenceRef[];
	releaseVersion?: string;
	controlRevision?: string;
}
export interface Tracked {
	entry: Entry;
	phase: "waiting" | "active" | "terminal" | "excluded";
	status?: JobStatus;
	admittedAt?: number;
	lookupFailures: number;
}
export type Lookup =
	| {
			kind: "found";
			status: JobStatus;
			reasonCode: string | null;
			evidence: EvidenceRef[];
			attemptCount: number;
	  }
	| { kind: "missing" | "unknown" | "mismatched" };
export type Registration = "accepted" | "rejected" | "unknown";
export interface RunnerIO {
	now(): number;
	control(): Promise<Control>;
	verifyRelease(version: string): Promise<boolean>;
	lookup(entry: Entry): Promise<Lookup>;
	prepare(entry: Entry): Promise<JobInput>;
	priorDomains(): Promise<Set<string>>;
	register(job: JobInput): Promise<Registration>;
	append(event: JournalEvent): Promise<void>;
}

/** Journal is authoritative; intent is durable before any POST and occupies a slot. */
export class ContinuousState {
	readonly rows: Tracked[];
	haltReason: string | null = null;
	observedControl: Control | null = null;
	#clearedRevision: string | null = null;
	readonly #io: RunnerIO;
	readonly #maxInflight: number;
	readonly #timeoutMs: number;
	constructor(
		entries: Entry[],
		events: JournalEvent[],
		io: RunnerIO,
		maxInflight = 20,
		timeoutMs = 20 * 60_000,
	) {
		if (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 20)
			throw new Error("Invalid inflight limit");
		this.rows = entries.map((entry) => ({
			entry,
			phase: entry.exclusion ? "excluded" : "waiting",
			lookupFailures: 0,
		}));
		this.#io = io;
		this.#maxInflight = maxInflight;
		this.#timeoutMs = timeoutMs;
		for (const event of events) this.#apply(event);
	}
	get active(): Tracked[] {
		return this.rows.filter((row) => row.phase === "active");
	}
	get waiting(): Tracked[] {
		return this.rows.filter((row) => row.phase === "waiting");
	}
	get finished(): boolean {
		return this.active.length === 0 && this.waiting.length === 0;
	}
	get drained(): boolean {
		return (
			this.observedControl?.pauseNewAdmissions === true &&
			this.active.length === 0
		);
	}
	async #record(event: Omit<JournalEvent, "at">): Promise<void> {
		const record = { ...event, at: new Date(this.#io.now()).toISOString() };
		await this.#io.append(record);
		this.#apply(record);
	}
	#apply(event: JournalEvent): void {
		if (event.event === "halt") {
			this.haltReason = event.reasonCode ?? "UNKNOWN_HALT";
			return;
		}
		if (event.event === "halt_cleared") {
			this.haltReason = null;
			this.#clearedRevision = event.controlRevision ?? null;
			return;
		}
		const row = this.rows.find(
			(item) => item.entry.jobId === event.jobId && !item.entry.exclusion,
		);
		if (!row) throw new Error("Journal refers to an unknown job");
		if (
			event.sourceRow !== row.entry.sourceRow ||
			event.domain !== row.entry.domain
		)
			throw new Error("Journal row identity mismatch");
		if (event.event === "registration_intent" && row.phase !== "waiting")
			throw new Error("Repeated registration intent");
		if (
			["registered", "terminal", "lookup_error"].includes(event.event) &&
			row.phase !== "active"
		)
			throw new Error("Invalid journal phase");
		if (
			event.event === "terminal" &&
			(!event.status || !TERMINAL_JOB_STATUSES.includes(event.status))
		)
			throw new Error("Nonterminal journal result");
		if (event.event === "registration_intent") {
			row.phase = "active";
			row.admittedAt = Date.parse(event.at);
		}
		if (event.event === "registered") {
			row.phase = "active";
			row.lookupFailures = 0;
			if (event.status) row.status = event.status;
		}
		if (event.event === "terminal") {
			row.phase = "terminal";
			if (event.status) row.status = event.status;
		}
		if (event.event === "excluded") row.phase = "excluded";
		if (event.event === "lookup_error") row.lookupFailures += 1;
	}
	async #halt(reason: string): Promise<void> {
		if (!this.haltReason)
			await this.#record({ event: "halt", reasonCode: reason });
	}
	async #control(allowClear = false): Promise<Control> {
		const control = await this.#io.control();
		this.observedControl = control;
		if (
			allowClear &&
			control.clearHalt &&
			control.revision !== this.#clearedRevision
		) {
			await this.#record({
				event: "halt_cleared",
				controlRevision: control.revision,
			});
			for (const row of this.active) row.lookupFailures = 0;
		}
		return control;
	}
	/** Polls all active jobs concurrently, then fills one available slot immediately. */
	async tick(): Promise<void> {
		let control: Control | undefined;
		try {
			control = await this.#control(true);
		} catch {
			this.observedControl = null;
			await this.#halt("CONTROL_UNAVAILABLE");
		}
		const active = this.active;
		const observations = await Promise.all(
			active.map(async (row) => {
				try {
					return { row, result: await this.#io.lookup(row.entry) };
				} catch {
					return { row, result: { kind: "unknown" } as Lookup };
				}
			}),
		);
		for (const { row, result } of observations) {
			const metadata = {
				jobId: row.entry.jobId,
				sourceRow: row.entry.sourceRow,
				domain: row.entry.domain,
			};
			if (result.kind === "found") {
				row.lookupFailures = 0;
				if (result.attemptCount > 1)
					await this.#halt("JOB_ATTEMPT_LIMIT_EXCEEDED");
				if (TERMINAL_JOB_STATUSES.includes(result.status)) {
					await this.#record({
						event: "terminal",
						...metadata,
						status: result.status,
						reasonCode:
							result.status === "sent"
								? "SENT"
								: (result.reasonCode ?? "NO_REASON"),
						evidence: result.evidence,
					});
				} else if (row.status !== result.status) {
					await this.#record({
						event: "registered",
						...metadata,
						status: result.status,
					});
				}
			} else {
				await this.#record({
					event: "lookup_error",
					...metadata,
					reasonCode: result.kind.toUpperCase(),
				});
				if (result.kind === "mismatched" || row.lookupFailures >= 3)
					await this.#halt("REGISTRATION_LOOKUP_UNRESOLVED");
			}
			if (
				row.phase === "active" &&
				this.#io.now() - (row.admittedAt ?? 0) > this.#timeoutMs
			)
				await this.#halt("ACTIVE_JOB_TIMEOUT");
		}
		if (!control) return;
		if (
			control.pauseNewAdmissions ||
			this.haltReason ||
			this.active.length >= this.#maxInflight
		)
			return;
		const row = this.waiting[0];
		if (!row) return;
		let verified = false;
		try {
			verified = await this.#io.verifyRelease(control.releaseVersion);
		} catch {
			/* fail closed */
		}
		if (!verified) {
			await this.#halt("RELEASE_NOT_VERIFIED");
			return;
		}
		let job: JobInput;
		try {
			job = await this.#io.prepare(row.entry);
		} catch (error) {
			if (error instanceof CandidateExcludedError)
				await this.#record({
					event: "excluded",
					jobId: row.entry.jobId,
					sourceRow: row.entry.sourceRow,
					domain: row.entry.domain,
					reasonCode: error.message,
				});
			else await this.#halt("PREPARATION_FAILED");
			return;
		}
		let domains: Set<string>;
		try {
			domains = await this.#io.priorDomains();
		} catch {
			await this.#halt("D1_HISTORY_UNAVAILABLE");
			return;
		}
		if (domains.has(row.entry.domain)) {
			await this.#record({
				event: "excluded",
				jobId: row.entry.jobId,
				sourceRow: row.entry.sourceRow,
				domain: row.entry.domain,
				reasonCode: "PRIOR_REAL_SEND_DOMAIN",
			});
			return;
		}
		// A pause/version change during preflight is acknowledged before any new POST.
		let latest: Control;
		try {
			latest = await this.#control();
		} catch {
			this.observedControl = null;
			await this.#halt("CONTROL_UNAVAILABLE");
			return;
		}
		if (
			latest.pauseNewAdmissions ||
			latest.revision !== control.revision ||
			latest.releaseVersion !== control.releaseVersion ||
			this.haltReason
		)
			return;
		await this.#record({
			event: "registration_intent",
			jobId: row.entry.jobId,
			sourceRow: row.entry.sourceRow,
			domain: row.entry.domain,
			releaseVersion: control.releaseVersion,
		});
		let outcome: Registration = "unknown";
		try {
			outcome = await this.#io.register(job);
		} catch {
			/* intent remains active */
		}
		if (outcome === "rejected") {
			await this.#record({
				event: "excluded",
				jobId: row.entry.jobId,
				sourceRow: row.entry.sourceRow,
				domain: row.entry.domain,
				reasonCode: "REGISTRATION_REJECTED",
			});
			await this.#halt("REGISTRATION_REJECTED");
		}
		// Accepted and unknown responses are both reconciled by exact-ID GET next tick.
	}
}
