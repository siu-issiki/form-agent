import {
	ADMIN_PAGE_SIZE,
	type AdminDetail,
	type AdminFilters,
	type AdminJob,
	type AdminOverview,
} from "./admin-data";
import { ADMIN_STYLES } from "./admin-styles";
import { JOB_STATUSES, type JobStatus } from "./job";

export const STATUS_LABELS: Record<JobStatus, string> = {
	pending: "待機中",
	running: "処理中",
	submitting: "送信処理中",
	sent: "送信完了",
	prohibited: "送信禁止",
	uncertain: "完了未確認",
	failed: "失敗",
	dead_lettered: "処理中断",
};
const KINDS = {
	real: "通常の実送信",
	managed: "管理下テスト",
	dry_run: "dry-run",
	unknown: "種別不明",
	all: "すべて",
};
const STAGES: Record<string, string> = {
	before_submit: "送信前",
	after_submit: "送信後",
	prohibited: "送信禁止の根拠",
	dry_run_before_submit: "dry-run 入力確認",
	dry_run_field_map: "入力項目の記録",
	submission_result: "受付判定の記録",
};
export function escapeHtml(value: unknown): string {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] as string,
	);
}
const number = (n: number) => n.toLocaleString("ja-JP");
const dateTime = (value: string | null) =>
	value && Number.isFinite(Date.parse(value))
		? new Intl.DateTimeFormat("ja-JP", {
				timeZone: "Asia/Tokyo",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			}).format(new Date(value))
		: "—";
const badge = (status: JobStatus) =>
	`<span class="badge ${escapeHtml(status)}"><span aria-hidden="true">●</span> ${escapeHtml(STATUS_LABELS[status] ?? status)}</span>`;
function safeLink(value: string): string | null {
	try {
		const u = new URL(value);
		return ["https:", "http:"].includes(u.protocol) &&
			!u.username &&
			!u.password
			? u.href
			: null;
	} catch {
		return null;
	}
}
function query(f: AdminFilters, changes: Record<string, string> = {}): string {
	return new URLSearchParams({
		from: f.from,
		to: f.to,
		kind: f.kind,
		status: f.status,
		q: f.search,
		campaign: f.campaign,
		...changes,
	}).toString();
}

export function adminFrame(
	title: string,
	body: string,
	active = "overview",
): string {
	return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · Form Agent</title><style>${ADMIN_STYLES}</style></head><body><a class="skip" href="#main">本文へ移動</a><header class="topbar"><a class="brand" href="/admin"><span class="mark" aria-hidden="true">↗</span>Form Agent</a><span class="owner">管理者専用 · 日本時間</span></header><div class="workspace"><aside class="sidebar"><p>WORKSPACE</p><a class="navlink" href="/admin" ${active === "overview" ? 'aria-current="page"' : ""}>送信状況</a><a class="navlink" href="/admin/jobs" ${active === "jobs" ? 'aria-current="page"' : ""}>送信一覧</a><small>送信結果と証跡を<br>ひとつの場所で。</small></aside><main id="main" class="main">${body}<footer class="footer">日時・日別集計はすべて日本時間（JST）</footer></main></div></body></html>`;
}
function filterForm(f: AdminFilters, action: string): string {
	const option = (v: string, label: string, current: string) =>
		`<option value="${escapeHtml(v)}" ${v === current ? "selected" : ""}>${escapeHtml(label)}</option>`;
	return `<form class="filters" method="get" action="${action}"><label>開始日<input type="date" name="from" value="${f.from}" required></label><label>終了日<input type="date" name="to" value="${f.to}" required></label><label>対象<select name="kind">${Object.entries(
		KINDS,
	)
		.map(([v, l]) => option(v, l, f.kind))
		.join(
			"",
		)}</select></label><label>ステータス<select name="status">${option("all", "すべて", f.status)}${JOB_STATUSES.map((s) => option(s, STATUS_LABELS[s], f.status)).join("")}</select></label><label class="search">企業名・ドメイン・ジョブID<input type="search" name="q" value="${escapeHtml(f.search)}" maxlength="200" placeholder="送信先を検索"></label><label class="campaign">キャンペーン<input name="campaign" value="${escapeHtml(f.campaign)}" maxlength="128" placeholder="キャンペーン名"></label><button class="primary" type="submit">適用</button></form>`;
}
function jobTable(jobs: AdminJob[]): string {
	if (!jobs.length)
		return `<div class="empty"><strong>条件に一致するジョブがありません</strong>日付やステータスの条件を変更してください。</div>`;
	return `<div class="scroll"><table><thead><tr><th>送信先</th><th>ステータス / 理由</th><th>登録日時</th><th class="num">証跡</th><th><span class="muted">詳細</span></th></tr></thead><tbody>${jobs.map((j) => `<tr><td><a class="company" href="/admin/jobs/${encodeURIComponent(j.id)}">${escapeHtml(j.companyName)}</a><small>${escapeHtml(j.targetDomain)} · ${escapeHtml(KINDS[j.kind] ?? "種別不明")}</small></td><td>${badge(j.status)}${j.reasonCode ? `<small>${escapeHtml(j.reasonCode)}</small>` : ""}</td><td class="nowrap value">${dateTime(j.createdAt)}<small>${escapeHtml(j.campaign ?? "キャンペーン未設定")}</small></td><td class="num">${number(j.evidenceCount)}<small>件</small></td><td><a class="nowrap" href="/admin/jobs/${encodeURIComponent(j.id)}" aria-label="${escapeHtml(j.companyName)}の詳細を見る">見る →</a></td></tr>`).join("")}</tbody></table></div>`;
}
export function renderAdminOverview(
	data: AdminOverview,
	f: AdminFilters,
	listOnly = false,
): string {
	const action = listOnly ? "/admin/jobs" : "/admin";
	const title = listOnly ? "送信一覧" : "送信状況";
	const registered = Object.values(data.counts).reduce((a, b) => a + b, 0);
	const active =
		data.counts.pending + data.counts.running + data.counts.submitting;
	const max = Math.max(1, ...data.daily.flatMap((d) => [d.registered, d.sent]));
	const cards = `<div class="cards"><section class="card"><div class="label">期間内の登録</div><div class="metric">${number(registered)}</div><small>登録日が選択期間内のジョブ</small></section><section class="card"><div class="label">期間内の送信完了</div><div class="metric green">${number(data.completedSent)}</div><small>完了日が選択期間内のジョブ</small></section><section class="card"><div class="label">完了未確認</div><div class="metric">${number(data.counts.uncertain)}</div><small>期間内登録分の現在の状態</small></section><section class="card"><div class="label">待機・処理中</div><div class="metric">${number(active)}</div><small>期間内登録分の現在の状態</small></section></div>`;
	const stats = `<section class="panel"><div class="panel-title"><div><h2>日別の実績</h2><p>登録日と送信完了日をそれぞれ集計。ステータスの絞り込みは一覧に適用します。</p></div></div><div class="legend"><span><i class="dot" style="background:#b9cbea"></i>登録</span><span><i class="dot" style="background:#168365"></i>送信完了</span></div><div class="scroll"><div class="chart" aria-hidden="true">${data.daily.map((d) => `<div class="day" title="${d.day} 登録${d.registered}件 / 送信完了${d.sent}件"><div class="bar-area"><div class="bar registered" style="height:${Math.round((d.registered / max) * 120)}px"></div><div class="bar sent" style="height:${Math.round((d.sent / max) * 120)}px"></div></div><span class="day-label">${d.day.slice(5).replace("-", "/")}</span></div>`).join("")}</div></div><details class="daily-table"><summary>日別の件数を表で見る</summary><div class="scroll"><table><thead><tr><th rowspan="2">日付</th><th rowspan="2" class="num">送信完了<br>完了日ベース</th><th colspan="6">登録日ベース · 現在の状態</th></tr><tr><th class="num">登録合計</th><th class="num">送信完了</th><th class="num">完了未確認</th><th class="num">送信禁止</th><th class="num">失敗・中断</th><th class="num">待機・処理中</th></tr></thead><tbody>${data.daily.map((d) => `<tr><td class="nowrap">${d.day}</td><td class="num">${number(d.sent)}</td><td class="num">${number(d.registered)}</td><td class="num">${number(d.counts.sent)}</td><td class="num">${number(d.counts.uncertain)}</td><td class="num">${number(d.counts.prohibited)}</td><td class="num">${number(d.counts.failed + d.counts.dead_lettered)}</td><td class="num">${number(d.counts.pending + d.counts.running + d.counts.submitting)}</td></tr>`).join("")}</tbody></table></div></details></section>`;
	const distribution = `<section class="panel"><div class="panel-title"><div><h2>登録分の現在の状態</h2><p>状態を選ぶと、該当する送信一覧を開きます。</p></div></div><div class="distribution">${JOB_STATUSES.map((s) => `<a href="/admin/jobs?${escapeHtml(query(f, { status: s }))}">${escapeHtml(STATUS_LABELS[s])}<strong>${number(data.counts[s])}</strong></a>`).join("")}</div></section>`;
	const pages = Math.max(1, Math.ceil(data.total / ADMIN_PAGE_SIZE));
	return adminFrame(
		title,
		`<div class="heading"><div><p class="eyebrow">${listOnly ? "DELIVERY LOG" : "DELIVERY OVERVIEW"}</p><h1>${title}</h1><p class="muted">${listOnly ? "送信先ごとの結果と、その根拠を確認できます。" : "日々の送信実績と、確認が必要な結果を把握できます。"}</p></div><a class="button" href="${action}?${escapeHtml(query(f, { page: String(f.page) }))}">最新に更新</a></div>${filterForm(f, action)}${listOnly ? "" : cards + stats + distribution}<section class="panel"><div class="panel-title"><div><h2>${listOnly ? "送信ジョブ" : "最近の送信ジョブ"}</h2><p>登録日で絞り込み · ${escapeHtml(KINDS[f.kind])}</p></div><span class="muted">${number(data.total)} 件</span></div>${jobTable(data.jobs)}<div class="pagination"><span>${f.page} / ${pages} ページ · 1ページ${ADMIN_PAGE_SIZE}件</span><nav aria-label="ページ切替">${f.page > 1 ? `<a class="button" href="${action}?${escapeHtml(query(f, { page: String(f.page - 1) }))}">← 前へ</a>` : ""}${f.page < pages ? `<a class="button" href="${action}?${escapeHtml(query(f, { page: String(f.page + 1) }))}">次へ →</a>` : ""}</nav></div></section>`,
		listOnly ? "jobs" : "overview",
	);
}
const FIELD_NAMES: Record<string, string> = {
	subject: "件名",
	message: "本文",
	fullName: "氏名",
	companyName: "会社名",
	email: "メールアドレス",
	phone: "電話番号",
	lastName: "姓",
	firstName: "名",
	address: "住所",
	companyWebsite: "会社URL",
	department: "部署",
};
export function renderAdminDetail(
	detail: AdminDetail,
	missing: ReadonlySet<string> = new Set(),
): string {
	const { job: j, evidence, formValues, captureFailures } = detail;
	const url = safeLink(j.targetUrl);
	const facts = `<dl class="facts"><dt>ステータス</dt><dd>${badge(j.status)}</dd><dt>種別</dt><dd>${escapeHtml(KINDS[j.kind] ?? "種別不明")}</dd><dt>登録日時</dt><dd>${dateTime(j.createdAt)}</dd><dt>最終更新</dt><dd>${dateTime(j.updatedAt)}</dd><dt>結果確定</dt><dd>${dateTime(j.completedAt)}</dd><dt>試行回数</dt><dd>${number(j.attemptCount)} 回</dd><dt>キャンペーン</dt><dd>${escapeHtml(j.campaign ?? "未設定")}</dd><dt>ジョブID</dt><dd class="mono">${escapeHtml(j.id)}</dd></dl>`;
	const evidenceCards = evidence
		.map((e) => {
			const href = `/admin/jobs/${encodeURIComponent(j.id)}/evidence/${encodeURIComponent(e.id)}`;
			const label = STAGES[e.stage] ?? e.stage;
			return `<figure class="evidence">${missing.has(e.id) ? `<div class="empty"><strong>証跡ファイルが見つかりません</strong>取得記録はありますが、保存先で確認できませんでした。</div>` : e.contentType?.startsWith("image/") || (!e.contentType && e.objectKey?.endsWith(".jpg")) ? `<a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${escapeHtml(label)}の証跡" loading="lazy"></a>` : `<a class="json-evidence" href="${href}" target="_blank" rel="noopener">判定・入力記録を開く ↗</a>`}<figcaption><strong>${escapeHtml(label)}</strong><small>${dateTime(e.capturedAt)}</small></figcaption></figure>`;
		})
		.join("");
	return adminFrame(
		j.companyName,
		`<a class="back" href="/admin/jobs">← 送信一覧へ</a><div class="heading"><div><p class="eyebrow">DELIVERY DETAIL</p><h1>${escapeHtml(j.companyName)}</h1><p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(j.targetDomain)} ↗</a>` : escapeHtml(j.targetDomain)}</p></div>${badge(j.status)}</div><div class="detail-grid"><div><section class="panel"><div class="panel-title"><div><h2>証跡</h2><p>取得順に表示 · ${number(evidence.length)}件</p></div></div>${captureFailures.map((f) => `<div class="alert">${escapeHtml(STAGES[f.stage] ?? f.stage)}の取得に失敗 · ${escapeHtml(f.failureCode)}<br>${dateTime(f.createdAt)}</div>`).join("")}${evidence.length ? `<div class="evidence-list">${evidenceCards}</div>` : `<div class="empty"><strong>保存された証跡はありません</strong>${["pending", "running", "submitting"].includes(j.status) ? "処理が進むと証跡が表示されます。" : "処理結果と理由を確認してください。"}</div>`}</section><section class="panel"><div class="panel-title"><h2>送信内容</h2></div><div class="details">${
			Object.keys(formValues).length
				? `<dl>${Object.entries(formValues)
						.map(
							([key, value]) =>
								`<div class="payload-row"><dt>${escapeHtml(FIELD_NAMES[key] ?? key)}</dt><dd>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</dd></div>`,
						)
						.join("")}</dl>`
				: `<p class="muted">送信内容の記録はありません。</p>`
		}</div></section></div><aside class="details-side"><section class="panel"><div class="panel-title"><h2>処理結果</h2></div><div class="details">${facts}${j.reasonCode || j.reason ? `<div class="reason"><strong class="mono">${escapeHtml(j.reasonCode)}</strong>${j.reason ? `<div>${escapeHtml(j.reason)}</div>` : ""}</div>` : ""}${j.status === "uncertain" ? `<p class="note" style="margin-top:16px">送信されている可能性があります。証跡を確認し、重複送信に注意してください。</p>` : ""}</div></section></aside></div>`,
		"jobs",
	);
}
export function renderAdminError(title: string, message: string): string {
	return adminFrame(
		title,
		`<section class="card error"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><a class="button" href="/admin">送信状況へ戻る</a></section>`,
	);
}
