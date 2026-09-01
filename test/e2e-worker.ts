import { D1JobStore } from "../src/d1-job-store";
import type { JobInput } from "../src/job";
import worker, { type Env, type JobMessage, registerJob } from "../src/worker";

interface E2eEnv extends Env {
	E2E_TOKEN?: string;
	E2E_TARGET_URL?: string;
}

const JOB_ID_PATTERN = /^agent-e2e-[a-f0-9-]{36}$/;
const DEFAULT_TARGET_URL = "https://www.selenium.dev/selenium/web/blank.html";

const e2eWorker: ExportedHandler<E2eEnv, JobMessage> = {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}
		if (
			!env.E2E_TOKEN ||
			request.headers.get("authorization") !== `Bearer ${env.E2E_TOKEN}`
		) {
			return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
		}

		if (request.method === "POST" && url.pathname === "/e2e/jobs") {
			const body = (await request.json()) as { jobId?: unknown };
			if (typeof body.jobId !== "string" || !JOB_ID_PATTERN.test(body.jobId)) {
				return Response.json({ error: "INVALID_JOB_ID" }, { status: 400 });
			}
			const targetUrl = env.E2E_TARGET_URL ?? DEFAULT_TARGET_URL;
			let target: URL;
			try {
				target = new URL(targetUrl);
				if (target.protocol !== "https:") throw new TypeError();
			} catch {
				return Response.json({ error: "INVALID_TARGET_URL" }, { status: 500 });
			}
			const input: JobInput = {
				id: body.jobId,
				companyId: "agent-e2e-target",
				companyName: `${target.hostname} E2E Fixture`,
				targetUrl,
				targetDomain: target.hostname,
				payload: {
					scenario: "safe-no-submit",
					name: "送信なしテスト",
					companyName: "Form Agent E2E",
					email: "no-reply@example.com",
					message: "これは送信しないフォーム動作確認です。",
					instruction:
						"Inspect the target and fill a compatible inquiry form using only these payload values. Call submit after validation; dry-run mode must intercept it without sending.",
				},
			};
			const registered = await registerJob(
				env.DB,
				env.JOB_QUEUE,
				input,
				new Date().toISOString(),
			);
			return Response.json(registered, {
				status: registered.created ? 201 : 200,
			});
		}

		const jobId = jobIdFromPath(url.pathname);
		if (request.method === "GET" && jobId) {
			const job = await new D1JobStore(env.DB).find(jobId);
			if (!job) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
			const counters = await env.DB.prepare(
				"SELECT provider_request_count FROM jobs WHERE id = ?",
			)
				.bind(jobId)
				.first<{ provider_request_count: number }>();
			return Response.json({
				job,
				providerRequestCount: counters?.provider_request_count ?? 0,
			});
		}

		return Response.json({ error: "NOT_FOUND" }, { status: 404 });
	},
	async queue(batch, env, ctx) {
		await worker.queue?.(batch, env, ctx);
	},
};

export default e2eWorker;

function jobIdFromPath(pathname: string): string | null {
	const match = /^\/e2e\/jobs\/(agent-e2e-[a-f0-9-]{36})$/.exec(pathname);
	return match?.[1] ?? null;
}
