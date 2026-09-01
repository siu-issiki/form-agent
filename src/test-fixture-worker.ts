import { D1JobStore } from "./d1-job-store";
import {
	TEST_FIXTURE_FORM_VALUES,
	TEST_FIXTURE_JOB_ID_PATTERN,
} from "./test-fixture-contract";

interface TestFixtureEnv {
	DB: D1Database;
	FIXTURE_API_TOKEN?: string;
}

const MAX_FORM_BYTES = 16 * 1024;

const worker: ExportedHandler<TestFixtureEnv> = {
	async fetch(request, env) {
		return handleTestFixtureRequest(request, env);
	},
};

export default worker;

export async function handleTestFixtureRequest(
	request: Request,
	env: TestFixtureEnv,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/health") {
		return Response.json({ status: "ok" });
	}

	if (request.method === "GET" && url.pathname === "/contact") {
		const job = await loadFixtureJob(env.DB, url);
		return job?.status === "running"
			? contactFormResponse(job.id, url)
			: notFoundResponse();
	}

	if (request.method === "POST" && url.pathname === "/contact/submit") {
		const job = await loadFixtureJob(env.DB, contactUrl(url));
		if (job?.status !== "submitting") {
			return apiJson({ error: "SUBMISSION_NOT_AUTHORIZED" }, 409);
		}
		if (!(await hasExpectedFormValues(request))) {
			return apiJson({ error: "INVALID_FORM_VALUES" }, 400);
		}

		const now = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO test_fixture_submissions (
        job_id, post_count, first_submitted_at, last_submitted_at
      ) VALUES (?, 1, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        post_count = post_count + 1,
        last_submitted_at = excluded.last_submitted_at`,
		)
			.bind(job.id, now, now)
			.run();

		return htmlResponse(
			'<!doctype html><html lang="ja"><body><main><h1>送信が完了しました。ありがとうございました。</h1></main></body></html>',
			200,
		);
	}

	const submissionJobId = submissionJobIdFromPath(url.pathname);
	if (request.method === "GET" && submissionJobId) {
		if (!isAuthorized(request, env.FIXTURE_API_TOKEN)) {
			return apiJson({ error: "UNAUTHORIZED" }, 401);
		}
		const row = await env.DB.prepare(
			`SELECT post_count, first_submitted_at, last_submitted_at
       FROM test_fixture_submissions WHERE job_id = ?`,
		)
			.bind(submissionJobId)
			.first<{
				post_count: number;
				first_submitted_at: string;
				last_submitted_at: string;
			}>();
		return row
			? apiJson(
					{
						jobId: submissionJobId,
						postCount: row.post_count,
						firstSubmittedAt: row.first_submitted_at,
						lastSubmittedAt: row.last_submitted_at,
					},
					200,
				)
			: apiJson({ error: "NOT_FOUND" }, 404);
	}

	return notFoundResponse();
}

async function loadFixtureJob(db: D1Database, url: URL) {
	const jobId = url.searchParams.get("jobId");
	if (!jobId || !TEST_FIXTURE_JOB_ID_PATTERN.test(jobId)) return null;
	const job = await new D1JobStore(db).find(jobId);
	if (!job || job.targetUrl !== url.toString()) return null;
	return hasFixturePayload(job.payload) ? job : null;
}

function hasFixturePayload(payload: Record<string, unknown>): boolean {
	const values = payload.formValues;
	if (!isRecord(values)) return false;
	if (Object.keys(values).length !== 4) return false;
	return Object.entries(TEST_FIXTURE_FORM_VALUES).every(
		([key, value]) => values[key] === value,
	);
}

async function hasExpectedFormValues(request: Request): Promise<boolean> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0];
	const contentLength = Number(request.headers.get("content-length"));
	if (
		contentType?.trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
		(Number.isFinite(contentLength) && contentLength > MAX_FORM_BYTES)
	) {
		return false;
	}
	const body = await readBoundedFormBody(request);
	if (body === null) return false;
	const values = new URLSearchParams(body);
	if (Array.from(values.keys()).length !== 4) return false;
	return Object.entries(TEST_FIXTURE_FORM_VALUES).every(
		([key, value]) =>
			values.getAll(key).length === 1 && values.get(key) === value,
	);
}

async function readBoundedFormBody(request: Request): Promise<string | null> {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let body = "";
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_FORM_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			body += decoder.decode(value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

function contactFormResponse(jobId: string, url: URL): Response {
	const action = new URL("/contact/submit", url);
	action.searchParams.set("jobId", jobId);
	return htmlResponse(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Form Agent 管理下テストフォーム</title></head>
<body><main>
<h1>お問い合わせ</h1>
<form method="post" action="${escapeHtml(action.toString())}">
<label>お名前 <input name="name" autocomplete="name" required></label>
<label>会社名 <input name="companyName" autocomplete="organization" required></label>
<label>メールアドレス <input name="email" type="email" autocomplete="email" required></label>
<label>お問い合わせ内容 <textarea name="message" required></textarea></label>
<button type="submit">送信する</button>
</form>
</main></body></html>`);
}

function contactUrl(submitUrl: URL): URL {
	const url = new URL("/contact", submitUrl);
	url.search = submitUrl.search;
	return url;
}

function submissionJobIdFromPath(pathname: string): string | null {
	const match = /^\/submissions\/([^/]+)$/.exec(pathname);
	const jobId = match?.[1];
	return jobId && TEST_FIXTURE_JOB_ID_PATTERN.test(jobId) ? jobId : null;
}

function isAuthorized(request: Request, token: string | undefined): boolean {
	return Boolean(
		token && request.headers.get("authorization") === `Bearer ${token}`,
	);
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			"content-type": "text/html; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

function apiJson(body: unknown, status: number): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

function notFoundResponse(): Response {
	return apiJson({ error: "NOT_FOUND" }, 404);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
