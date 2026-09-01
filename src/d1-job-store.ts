import {
	DuplicateJobError,
	type Job,
	type JobInput,
	type JobResult,
	type JobStatus,
	type JobStore,
} from "./job";
import { normalizeAllowedHosts } from "./restricted-browser";

interface StoredJobRow {
	id: string;
	company_id: string;
	company_name: string;
	target_url: string;
	target_domain: string;
	allowed_hosts_json: string;
	payload_json: string;
	status: JobStatus;
	attempt_count: number;
	run_token: string | null;
	created_at: string;
	updated_at: string;
}

interface JobRow extends StoredJobRow {
	outcome: JobResult["outcome"] | null;
	form_url: string | null;
	reason_code: string | null;
	reason: string | null;
	completed_at: string | null;
}

type QuerySource = Pick<D1Database, "prepare">;

export class D1JobStore implements JobStore {
	constructor(private readonly db: D1Database) {}

	async create(input: JobInput, now: string): Promise<Job> {
		const session = this.db.withSession("first-primary");
		const result = await session
			.prepare(
				`INSERT OR IGNORE INTO jobs (
          id, company_id, company_name, target_url, target_domain,
          allowed_hosts_json, payload_json, status, attempt_count, run_token,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
			)
			.bind(
				input.id,
				input.companyId,
				input.companyName,
				input.targetUrl,
				input.targetDomain,
				JSON.stringify(input.allowedHosts),
				JSON.stringify(input.payload),
				now,
				now,
			)
			.run();

		if (result.meta.changes !== 1) {
			throw new DuplicateJobError(input.id);
		}

		return this.#findRequired(session, input.id);
	}

	find(id: string): Promise<Job | null> {
		return this.#find(this.db, id);
	}

	async claimRun(
		id: string,
		runToken: string,
		now: string,
	): Promise<Job | null> {
		const session = this.db.withSession("first-primary");
		const row = await session
			.prepare(
				`UPDATE jobs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             run_token = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
			)
			.bind(runToken, now, id)
			.first<StoredJobRow>();

		return row ? mapStoredJob(row) : null;
	}

	async claimSubmission(
		id: string,
		runToken: string,
		now: string,
	): Promise<Job | null> {
		const session = this.db.withSession("first-primary");
		const row = await session
			.prepare(
				`UPDATE jobs
         SET status = 'submitting', updated_at = ?
         WHERE id = ? AND status = 'running' AND run_token = ?
         RETURNING *`,
			)
			.bind(now, id, runToken)
			.first<StoredJobRow>();

		return row ? mapStoredJob(row) : null;
	}

	async claimProviderRequest(
		id: string,
		runToken: string,
		maxRequests: number,
		now: string,
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				`UPDATE jobs
         SET provider_request_count = provider_request_count + 1,
             updated_at = ?
         WHERE id = ? AND status = 'running' AND run_token = ?
           AND provider_request_count < ?`,
			)
			.bind(now, id, runToken, maxRequests)
			.run();

		return result.meta.changes === 1;
	}

	async recordRunAttempt(
		id: string,
		runToken: string,
		attempt: number,
		now: string,
	): Promise<Job | null> {
		const session = this.db.withSession("first-primary");
		const row = await session
			.prepare(
				`UPDATE jobs
         SET attempt_count = MAX(attempt_count, ?), updated_at = ?
         WHERE id = ? AND status = 'running' AND run_token = ?
         RETURNING *`,
			)
			.bind(attempt, now, id, runToken)
			.first<StoredJobRow>();

		return row ? mapStoredJob(row) : null;
	}

	async recordRetryScheduled(
		id: string,
		runToken: string,
		attempt: number,
		reasonCode: string,
		source: "consumer" | "exception" | "result",
		durationMs: number,
		now: string,
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO events (
          id, job_id, attempt, type, data_json, created_at
        )
        SELECT ?, id, ?, 'job.retry_scheduled', json_object(
          'reasonCode', ?,
          'source', ?,
          'durationMs', ?,
          'providerRequestCount', provider_request_count
        ), ?
        FROM jobs
        WHERE id = ? AND status = 'running' AND run_token = ?`,
			)
			.bind(
				crypto.randomUUID(),
				attempt,
				reasonCode,
				source,
				durationMs,
				now,
				id,
				runToken,
			)
			.run();

		return result.meta.changes === 1;
	}

	recordSent(
		id: string,
		runToken: string,
		formUrl: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["submitting"], now, {
			outcome: "sent",
			formUrl,
			reasonCode: null,
			reason: null,
			completedAt: now,
		});
	}

	recordProhibited(
		id: string,
		runToken: string,
		formUrl: string | null,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["running"], now, {
			outcome: "prohibited",
			formUrl,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	recordUncertain(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["running", "submitting"], now, {
			outcome: "uncertain",
			formUrl: null,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	recordFailed(
		id: string,
		runToken: string,
		reasonCode: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		return this.#finish(id, runToken, ["running"], now, {
			outcome: "failed",
			formUrl: null,
			reasonCode,
			reason,
			completedAt: now,
		});
	}

	async markDeadLettered(
		id: string,
		reason: string,
		now: string,
	): Promise<Job | null> {
		const session = this.db.withSession("first-primary");
		const eventId = crypto.randomUUID();
		const batchResult = await session.batch([
			session
				.prepare(
					`UPDATE jobs
           SET status = 'dead_lettered', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'running', 'failed')`,
				)
				.bind(now, id),
			session
				.prepare(
					`INSERT INTO events (
             id, job_id, attempt, type, data_json, created_at
           )
           SELECT ?, id, attempt_count, 'job.dead_lettered', ?, ?
           FROM jobs
           WHERE id = ? AND status = 'dead_lettered' AND updated_at = ?`,
				)
				.bind(eventId, JSON.stringify({ reason }), now, id, now),
		]);
		const statusUpdate = batchResult[0];
		const eventInsert = batchResult[1];

		if (
			!statusUpdate ||
			!eventInsert ||
			statusUpdate.meta.changes !== 1 ||
			eventInsert.meta.changes !== 1
		) {
			return null;
		}

		return this.#findRequired(session, id);
	}

	async #finish(
		id: string,
		runToken: string,
		expectedStatuses: readonly ("running" | "submitting")[],
		now: string,
		result: JobResult,
	): Promise<Job | null> {
		const session = this.db.withSession("first-primary");
		const statusPlaceholders = expectedStatuses.map(() => "?").join(", ");
		const batchResult = await session.batch([
			session
				.prepare(
					`UPDATE jobs
           SET status = ?, updated_at = ?
           WHERE id = ? AND status IN (${statusPlaceholders}) AND run_token = ?`,
				)
				.bind(result.outcome, now, id, ...expectedStatuses, runToken),
			session
				.prepare(
					`INSERT INTO results (
             job_id, outcome, form_url, reason_code, reason, completed_at
           )
           SELECT id, ?, ?, ?, ?, ?
           FROM jobs
           WHERE id = ? AND status = ? AND run_token = ?
             AND NOT EXISTS (
               SELECT 1 FROM results WHERE results.job_id = jobs.id
             )`,
				)
				.bind(
					result.outcome,
					result.formUrl,
					result.reasonCode,
					result.reason,
					result.completedAt,
					id,
					result.outcome,
					runToken,
				),
		]);
		const statusUpdate = batchResult[0];
		const resultInsert = batchResult[1];

		if (
			!statusUpdate ||
			!resultInsert ||
			statusUpdate.meta.changes !== 1 ||
			resultInsert.meta.changes !== 1
		) {
			return null;
		}

		return this.#findRequired(session, id);
	}

	async #findRequired(source: QuerySource, id: string): Promise<Job> {
		const job = await this.#find(source, id);
		if (!job) {
			throw new Error(`Job disappeared after a successful write: ${id}`);
		}
		return job;
	}

	async #find(source: QuerySource, id: string): Promise<Job | null> {
		const row = await source
			.prepare(
				`SELECT
          jobs.*,
          results.outcome,
          results.form_url,
          results.reason_code,
          results.reason,
          results.completed_at
        FROM jobs
        LEFT JOIN results ON results.job_id = jobs.id
        WHERE jobs.id = ?`,
			)
			.bind(id)
			.first<JobRow>();

		return row ? mapJob(row) : null;
	}
}

function mapJob(row: JobRow): Job {
	const job = mapStoredJob(row);
	return {
		...job,
		result: row.outcome
			? {
					outcome: row.outcome,
					formUrl: row.form_url,
					reasonCode: row.reason_code,
					reason: row.reason,
					completedAt: row.completed_at ?? row.updated_at,
				}
			: null,
	};
}

function mapStoredJob(row: StoredJobRow): Job {
	return {
		id: row.id,
		companyId: row.company_id,
		companyName: row.company_name,
		targetUrl: row.target_url,
		targetDomain: row.target_domain,
		allowedHosts: normalizeAllowedHosts(
			JSON.parse(row.allowed_hosts_json) as string[],
		),
		payload: JSON.parse(row.payload_json) as Record<string, unknown>,
		status: row.status,
		attemptCount: row.attempt_count,
		runToken: row.run_token,
		result: null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
