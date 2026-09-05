/// <reference types="@cloudflare/workers-types" />
/** Local-only, synthetic data preview. Never reads production bindings or secrets. */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { renderAdminRequest } from "../src/admin-handler";
import type { Env } from "../src/env";

const db = new Database(":memory:");
const migrations = new URL("../migrations/", import.meta.url);
for (const file of (await readdir(migrations))
	.filter((f) => f.endsWith(".sql"))
	.sort())
	db.exec(await readFile(new URL(file, migrations), "utf8"));
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const start = Date.parse(`${today}T00:00:00+09:00`);
const names = [
	"青葉デザイン",
	"つむぎ企画",
	"港まちスタジオ",
	"木の実ラボ",
	"北野ワークス",
	"みなと制作室",
];
const statuses = [
	"sent",
	"sent",
	"sent",
	"uncertain",
	"prohibited",
	"failed",
	"pending",
	"running",
	"submitting",
	"dead_lettered",
];
for (let i = 0; i < 94; i++) {
	const id = `preview-${String(i).padStart(3, "0")}`;
	const status = statuses[i % statuses.length] ?? "sent";
	const created = new Date(
		start - (i % 7) * 86400000 + 8 * 3600000 + i * 60000,
	).toISOString();
	const done = new Date(Date.parse(created) + 180000).toISOString();
	const kind = i % 17 === 0 ? "managed" : i % 19 === 0 ? "dry_run" : "real";
	const payload = {
		campaign: "autumn-invitation",
		_formAgentEffectiveDryRun: kind === "dry_run",
		_formAgentRealSendGuardExempt: kind === "managed",
		formValues: {
			subject: "交流会のご案内（架空データ）",
			message:
				"これは管理画面の表示確認用の架空データです。\n実際の送信は行っていません。",
			fullName: "山田 太郎",
			companyName: "サンプル株式会社",
			email: "preview@example.com",
		},
	};
	db.query(
		"INSERT INTO jobs(id,company_id,company_name,target_url,target_domain,payload_json,status,attempt_count,created_at,updated_at,real_send) VALUES(?,?,?,?,?,?,?,1,?,?,?)",
	).run(
		id,
		`company-${i}`,
		names[i % names.length] ?? "架空の会社",
		`https://example.com/contact/${i}`,
		`sample-${i}.example.com`,
		JSON.stringify(payload),
		status,
		created,
		done,
		kind === "real" ? 1 : 0,
	);
	if (["sent", "uncertain", "prohibited", "failed"].includes(status))
		db.query(
			"INSERT INTO results(job_id,outcome,reason_code,reason,completed_at) VALUES(?,?,?,?,?)",
		).run(
			id,
			status,
			status === "sent"
				? "SENT"
				: status === "uncertain"
					? "SUBMISSION_UNCONFIRMED"
					: status === "prohibited"
						? "SALES_PROHIBITED"
						: "NO_FORM",
			status === "sent"
				? "受付完了の表示を確認しました。"
				: status === "uncertain"
					? "送信操作の後に、受付完了を示す表示を確認できませんでした。"
					: "フォームの目的・制限により処理を終了しました。",
			done,
		);
	if (["sent", "uncertain", "prohibited"].includes(status))
		for (const stage of ["before_submit", "after_submit"]) {
			const event = `${id}-${stage}`;
			db.query(
				"INSERT INTO events(id,job_id,attempt,type,data_json,created_at) VALUES(?,?,1,'evidence.captured',?,?)",
			).run(
				event,
				id,
				JSON.stringify({
					stage,
					objectKey: `jobs/${id}/${stage}/${event}.png`,
					contentType: "image/png",
				}),
				done,
			);
		}
}
function prepare(sql: string, values: SQLQueryBindings[] = []): unknown {
	return {
		bind: (...next: SQLQueryBindings[]) => prepare(sql, next),
		first: async () => db.query(sql).get(...values),
		all: async () => ({
			results: db.query(sql).all(...values),
			success: true,
			meta: {},
		}),
	};
}
const previewEnv = {
	DB: {
		prepare,
		batch: async (statements: { all: () => Promise<unknown> }[]) =>
			Promise.all(statements.map((s) => s.all())),
	},
	EVIDENCE_BUCKET: {
		head: async () =>
			(await Bun.file(
				new URL(
					"../artifacts/admin-dashboard/preview-evidence.png",
					import.meta.url,
				),
			).exists())
				? {}
				: null,
		get: async () => {
			const file = Bun.file(
				new URL(
					"../artifacts/admin-dashboard/preview-evidence.png",
					import.meta.url,
				),
			);
			if (!(await file.exists())) return null;
			return {
				body: file.stream(),
				size: file.size,
				httpMetadata: { contentType: "image/png" },
			};
		},
	},
} as unknown as Env;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 8788,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/preview-form")
			return new Response(
				`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>架空の受付画面</title><style>body{font:18px/1.8 sans-serif;background:#f5f7fb;padding:65px;color:#25384c}main{max-width:680px;margin:auto;background:white;padding:45px;border:1px solid #dce5ed;border-radius:14px}small{color:#64778a}h1{font-size:30px}.success{background:#e9f7ef;padding:20px;color:#13724f;margin:25px 0}dl{display:grid;grid-template-columns:120px 1fr;gap:16px}dd{margin:0}footer{margin-top:30px;font-size:13px;color:#64778a}</style><main><small>表示確認用 / SAMPLE</small><h1>お問い合わせを受け付けました</h1><div class="success">✓ ご連絡ありがとうございます。</div><dl><dt>お名前</dt><dd>山田 太郎</dd><dt>会社名</dt><dd>サンプル株式会社</dd><dt>件名</dt><dd>交流会のご案内</dd></dl><footer>管理画面の証跡表示を確認するための架空画面です。<br>フォーム送信は行っていません。</footer></main></html>`,
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		const response = await renderAdminRequest(request, previewEnv);
		if (response.headers.get("content-type")?.includes("text/html"))
			return new Response(
				(await response.text()).replace(
					"管理者専用 · 日本時間",
					"プレビュー（架空データ） · 日本時間",
				),
				response,
			);
		return response;
	},
});
console.log(`Synthetic preview only: ${server.url}admin`);
