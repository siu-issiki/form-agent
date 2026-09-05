import { JOB_STATUSES, type JobStatus } from "./job";

export const ADMIN_PAGE_SIZE = 50;
export const ADMIN_KINDS = [
	"real",
	"managed",
	"dry_run",
	"unknown",
	"all",
] as const;
export type AdminKind = (typeof ADMIN_KINDS)[number];
export interface AdminFilters {
	from: string;
	to: string;
	start: string;
	end: string;
	kind: AdminKind;
	status: JobStatus | "all";
	search: string;
	campaign: string;
	page: number;
}
export interface AdminJob {
	id: string;
	companyName: string;
	targetDomain: string;
	targetUrl: string;
	status: JobStatus;
	kind: Exclude<AdminKind, "all">;
	campaign: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	reasonCode: string | null;
	reason: string | null;
	attemptCount: number;
	evidenceCount: number;
}
export interface AdminDay {
	day: string;
	registered: number;
	sent: number;
	counts: Record<JobStatus, number>;
}
export interface AdminOverview {
	jobs: AdminJob[];
	total: number;
	counts: Record<JobStatus, number>;
	daily: AdminDay[];
	completedSent: number;
}
export class AdminFilterError extends Error {}
const DAY = 86400000;
const JST = 9 * 3600000;
const dateLabel = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function validDate(value: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		dateLabel(Date.parse(value)) === value
	);
}
export function parseAdminFilters(
	params: URLSearchParams,
	now = new Date(),
): AdminFilters {
	const today = dateLabel(now.getTime() + JST);
	const from = params.get("from") ?? dateLabel(Date.parse(today) - 13 * DAY);
	const to = params.get("to") ?? today;
	const kind = params.get("kind") ?? "real";
	const status = params.get("status") ?? "all";
	const search = (params.get("q") ?? "").trim();
	const campaign = (params.get("campaign") ?? "").trim();
	const pageValue = params.get("page") ?? "1";
	const page = Number(pageValue);
	if (
		!validDate(from) ||
		!validDate(to) ||
		from > to ||
		Date.parse(to) - Date.parse(from) > 92 * DAY ||
		!ADMIN_KINDS.includes(kind as AdminKind) ||
		(status !== "all" && !JOB_STATUSES.includes(status as JobStatus)) ||
		search.length > 200 ||
		campaign.length > 128 ||
		!/^\d+$/.test(pageValue) ||
		!Number.isSafeInteger(page) ||
		page < 1 ||
		page > 2000
	)
		throw new AdminFilterError(
			"日付は93日以内、検索語は200文字以内で指定してください。",
		);
	return {
		from,
		to,
		start: new Date(Date.parse(from) - JST).toISOString(),
		end: new Date(Date.parse(to) + DAY - JST).toISOString(),
		kind: kind as AdminKind,
		status: status as AdminFilters["status"],
		search,
		campaign,
		page,
	};
}

// The real_send counter excludes managed tests. Unknown historic modes stay unknown.
const KIND_SQL = `CASE
 WHEN json_extract(j.payload_json, '$._formAgentRealSendGuardExempt') = 1 THEN 'managed'
 WHEN json_extract(j.payload_json, '$._formAgentEffectiveDryRun') = 1
   OR json_extract(j.payload_json, '$._formAgentDryRun') = 1 THEN 'dry_run'
 WHEN j.real_send = 1 OR json_extract(j.payload_json, '$._formAgentEffectiveDryRun') = 0 THEN 'real'
 ELSE 'unknown' END`;
const SELECT_JOB = `SELECT j.id, j.company_name AS companyName, j.target_domain AS targetDomain,
 j.target_url AS targetUrl, j.status, ${KIND_SQL} AS kind,
 json_extract(j.payload_json, '$.campaign') AS campaign, j.created_at AS createdAt,
 j.updated_at AS updatedAt, r.completed_at AS completedAt, r.reason_code AS reasonCode,
 r.reason, j.attempt_count AS attemptCount,
 (SELECT COUNT(*) FROM events e WHERE e.job_id=j.id AND e.type='evidence.captured') AS evidenceCount
 FROM jobs j LEFT JOIN results r ON r.job_id=j.id`;

function scope(filters: AdminFilters): {
	clause: string;
	values: (string | number)[];
} {
	const clauses: string[] = [];
	const values: (string | number)[] = [];
	if (filters.kind !== "all") {
		clauses.push(`(${KIND_SQL}) = ?`);
		values.push(filters.kind);
	}
	if (filters.search) {
		clauses.push(
			"(instr(lower(j.company_name), lower(?)) > 0 OR instr(lower(j.target_domain), lower(?)) > 0 OR j.id = ?)",
		);
		values.push(filters.search, filters.search, filters.search);
	}
	if (filters.campaign) {
		clauses.push("json_extract(j.payload_json, '$.campaign') = ?");
		values.push(filters.campaign);
	}
	return { clause: clauses.length ? clauses.join(" AND ") : "1=1", values };
}

export async function loadAdminOverview(
	db: D1Database,
	filters: AdminFilters,
): Promise<AdminOverview> {
	const base = scope(filters);
	const cohort = `${base.clause} AND j.created_at >= ? AND j.created_at < ?`;
	const values = [...base.values, filters.start, filters.end];
	const statusClause = filters.status === "all" ? "" : " AND j.status = ?";
	const listValues =
		filters.status === "all" ? values : [...values, filters.status];
	const [list, totals, registrations, completions] = await db.batch([
		db
			.prepare(
				`${SELECT_JOB} WHERE ${cohort}${statusClause} ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`,
			)
			.bind(
				...listValues,
				ADMIN_PAGE_SIZE,
				(filters.page - 1) * ADMIN_PAGE_SIZE,
			),
		db
			.prepare(
				`SELECT j.status, COUNT(*) AS count FROM jobs j WHERE ${cohort} GROUP BY j.status`,
			)
			.bind(...values),
		db
			.prepare(
				`SELECT date(j.created_at, '+9 hours') AS day, j.status, COUNT(*) AS count FROM jobs j WHERE ${cohort} GROUP BY day, j.status`,
			)
			.bind(...values),
		db
			.prepare(
				`SELECT date(r.completed_at, '+9 hours') AS day, COUNT(*) AS count FROM results r JOIN jobs j ON j.id=r.job_id WHERE ${base.clause} AND j.status='sent' AND r.outcome='sent' AND r.completed_at >= ? AND r.completed_at < ? GROUP BY day`,
			)
			.bind(...base.values, filters.start, filters.end),
	]);
	const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
		JobStatus,
		number
	>;
	for (const row of (totals?.results ?? []) as {
		status: JobStatus;
		count: number;
	}[])
		counts[row.status] = row.count;
	const dailyCounts = new Map<string, Record<JobStatus, number>>();
	for (const row of (registrations?.results ?? []) as {
		day: string;
		status: JobStatus;
		count: number;
	}[]) {
		const counts =
			dailyCounts.get(row.day) ??
			(Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
				JobStatus,
				number
			>);
		counts[row.status] = row.count;
		dailyCounts.set(row.day, counts);
	}
	const sent = new Map(
		((completions?.results ?? []) as { day: string; count: number }[]).map(
			(r) => [r.day, r.count],
		),
	);
	const daily: AdminDay[] = [];
	for (
		let time = Date.parse(filters.from);
		time <= Date.parse(filters.to);
		time += DAY
	) {
		const day = dateLabel(time);
		const counts =
			dailyCounts.get(day) ??
			(Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
				JobStatus,
				number
			>);
		daily.push({
			day,
			counts,
			registered: Object.values(counts).reduce((a, b) => a + b, 0),
			sent: sent.get(day) ?? 0,
		});
	}
	return {
		jobs: (list?.results ?? []) as unknown as AdminJob[],
		total:
			filters.status === "all"
				? Object.values(counts).reduce((a, b) => a + b, 0)
				: counts[filters.status],
		counts,
		daily,
		completedSent: daily.reduce((sum, d) => sum + d.sent, 0),
	};
}

export interface AdminEvidence {
	id: string;
	stage: string;
	contentType: string;
	capturedAt: string;
	objectKey: string;
}
export interface AdminDetail {
	job: AdminJob;
	formValues: Record<string, unknown>;
	evidence: AdminEvidence[];
	captureFailures: { createdAt: string; stage: string; failureCode: string }[];
}
export async function loadAdminDetail(
	db: D1Database,
	id: string,
): Promise<AdminDetail | null> {
	const job = await db
		.prepare(`${SELECT_JOB} WHERE j.id=?`)
		.bind(id)
		.first<AdminJob>();
	if (!job) return null;
	const [payload, evidence, failures] = await Promise.all([
		db
			.prepare(
				"SELECT json_extract(payload_json, '$.formValues') AS formValues FROM jobs WHERE id=?",
			)
			.bind(id)
			.first<{ formValues: string | null }>(),
		db
			.prepare(
				`SELECT id, json_extract(data_json, '$.stage') AS stage, json_extract(data_json, '$.contentType') AS contentType, json_extract(data_json, '$.objectKey') AS objectKey, created_at AS capturedAt FROM events WHERE job_id=? AND type='evidence.captured' ORDER BY created_at, rowid`,
			)
			.bind(id)
			.all<AdminEvidence>(),
		db
			.prepare(
				`SELECT created_at AS createdAt, json_extract(data_json, '$.stage') AS stage, json_extract(data_json, '$.failureCode') AS failureCode FROM events WHERE job_id=? AND type='evidence.capture_failed' ORDER BY created_at, rowid`,
			)
			.bind(id)
			.all<AdminDetail["captureFailures"][number]>(),
	]);
	let formValues: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(payload?.formValues ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			formValues = parsed as Record<string, unknown>;
	} catch {
		/* Legacy malformed values are not rendered as HTML. */
	}
	return {
		job,
		formValues,
		evidence: evidence.results,
		captureFailures: failures.results,
	};
}
