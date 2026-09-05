import { authorizeAdmin } from "./admin-auth";
import {
	AdminFilterError,
	loadAdminDetail,
	loadAdminOverview,
	parseAdminFilters,
} from "./admin-data";
import {
	renderAdminDetail,
	renderAdminError,
	renderAdminOverview,
} from "./admin-page";
import type { Env } from "./env";
import { JOB_ID_PATTERN } from "./job";

const SECURITY_HEADERS = {
	"cache-control": "private, no-store",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"x-robots-tag": "noindex, nofollow",
};
function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			...SECURITY_HEADERS,
			"content-type": "text/html; charset=utf-8",
		},
	});
}
function problem(title: string, message: string, status: number): Response {
	return html(renderAdminError(title, message), status);
}

/** Called only for /admin. Browser reads never carry the job registration token. */
export async function handleAdminRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!(await authorizeAdmin(request, env)))
		return problem(
			"アクセスできません",
			"管理者としてログインしたアドレスでアクセスしてください。",
			403,
		);
	return renderAdminRequest(request, env);
}

/** Rendering after authentication; also used by the isolated local preview. */
export async function renderAdminRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "GET")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { ...SECURITY_HEADERS, allow: "GET" },
		});
	try {
		const url = new URL(request.url);
		if (
			url.pathname === "/admin" ||
			url.pathname === "/admin/" ||
			url.pathname === "/admin/jobs"
		) {
			const filters = parseAdminFilters(url.searchParams);
			const data = await loadAdminOverview(env.DB, filters);
			return html(
				renderAdminOverview(data, filters, url.pathname === "/admin/jobs"),
			);
		}
		const match = /^\/admin\/jobs\/([^/]+)(?:\/evidence\/([^/]+))?$/.exec(
			url.pathname,
		);
		if (!match?.[1])
			return problem(
				"ページが見つかりません",
				"送信一覧からジョブを選択してください。",
				404,
			);
		let id: string;
		let evidenceId: string | undefined;
		try {
			id = decodeURIComponent(match[1]);
			evidenceId = match[2] ? decodeURIComponent(match[2]) : undefined;
		} catch {
			return problem("ページが見つかりません", "URLを確認してください。", 404);
		}
		if (
			!JOB_ID_PATTERN.test(id) ||
			(evidenceId && !JOB_ID_PATTERN.test(evidenceId))
		)
			return problem("ページが見つかりません", "URLを確認してください。", 404);
		if (evidenceId) {
			const entry = await env.DB.prepare(
				`SELECT json_extract(data_json, '$.objectKey') AS objectKey FROM events WHERE id=? AND job_id=? AND type='evidence.captured'`,
			)
				.bind(evidenceId, id)
				.first<{ objectKey: string }>();
			if (!entry?.objectKey?.startsWith(`jobs/${id}/`))
				return problem(
					"証跡が見つかりません",
					"このジョブに対応する証跡の記録がありません。",
					404,
				);
			const object = await env.EVIDENCE_BUCKET.get(entry.objectKey);
			if (!object)
				return problem(
					"証跡ファイルが見つかりません",
					"取得記録はありますが、保存先にファイルがありません。",
					404,
				);
			const type =
				object.httpMetadata?.contentType ??
				(entry.objectKey.endsWith(".jpg")
					? "image/jpeg"
					: entry.objectKey.endsWith(".json")
						? "application/json"
						: "application/octet-stream");
			if (!["image/jpeg", "image/png", "application/json"].includes(type)) {
				await object.body.cancel();
				return problem(
					"この形式は表示できません",
					"対応していない証跡形式です。",
					415,
				);
			}
			return new Response(object.body, {
				headers: {
					...SECURITY_HEADERS,
					"content-type": type,
					"content-length": String(object.size),
					"content-disposition":
						type === "application/json"
							? 'inline; filename="evidence.json"'
							: 'inline; filename="evidence.jpg"',
					"content-security-policy":
						"default-src 'none'; sandbox; frame-ancestors 'none'",
				},
			});
		}
		const detail = await loadAdminDetail(env.DB, id);
		if (!detail)
			return problem(
				"ジョブが見つかりません",
				"送信一覧からジョブを選択してください。",
				404,
			);
		const missing = new Set<string>();
		// Bounded batches avoid opening one R2 request per image at the same instant.
		for (let i = 0; i < detail.evidence.length; i += 4) {
			await Promise.all(
				detail.evidence.slice(i, i + 4).map(async (e) => {
					if (
						!e.objectKey?.startsWith(`jobs/${id}/`) ||
						!(await env.EVIDENCE_BUCKET.head(e.objectKey))
					)
						missing.add(e.id);
				}),
			);
		}
		return html(renderAdminDetail(detail, missing));
	} catch (error) {
		if (error instanceof AdminFilterError)
			return problem("検索条件を確認してください", error.message, 400);
		return problem(
			"データを取得できませんでした",
			"時間をおいて再度開いてください。結果や送信状態は変更していません。",
			503,
		);
	}
}
