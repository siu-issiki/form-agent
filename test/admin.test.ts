import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { authorizeAdmin } from "../src/admin-auth";
import { loadAdminOverview, parseAdminFilters } from "../src/admin-data";
import type { Env } from "../src/env";
import { handleHttpRequest } from "../src/worker";

let privateKey: CryptoKey;
const issuer = "https://dashboard-test.cloudflareaccess.com";
const audience = "admin-test-audience";
const owner = "owner@example.com";
const settings = () => ({
	...env,
	ADMIN_EMAIL: owner,
	ADMIN_ACCESS_ISSUER: issuer,
	ADMIN_ACCESS_AUDIENCE: audience,
});
async function token(
	options: {
		email?: string;
		issuer?: string;
		audience?: string;
		expired?: boolean;
	} = {},
): Promise<string> {
	return new SignJWT({ email: options.email ?? owner })
		.setProtectedHeader({ alg: "RS256", kid: "admin-test" })
		.setIssuer(options.issuer ?? issuer)
		.setAudience(options.audience ?? audience)
		.setSubject("owner-id")
		.setIssuedAt()
		.setExpirationTime(options.expired ? "-1h" : "1h")
		.sign(privateKey);
}
async function request(
	path: string,
	options: { method?: string; jwt?: string; config?: Env } = {},
): Promise<Response> {
	return handleHttpRequest(
		new Request(`https://dashboard.test${path}`, {
			method: options.method ?? "GET",
			headers: { "cf-access-jwt-assertion": options.jwt ?? (await token()) },
		}),
		options.config ?? settings(),
	);
}
beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	const jwk = await exportJWK(pair.publicKey);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== `${issuer}/cdn-cgi/access/certs`)
				throw new Error("Unexpected external request");
			return Response.json({
				keys: [{ ...jwk, kid: "admin-test", alg: "RS256", use: "sig" }],
			});
		}),
	);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM events"),
		env.DB.prepare("DELETE FROM results"),
		env.DB.prepare("DELETE FROM jobs"),
	]);
});
async function seed(
	id: string,
	status = "sent",
	createdAt = "2026-09-05T14:59:00.000Z",
	completedAt: string | null = "2026-09-05T15:01:00.000Z",
	payload: Record<string, unknown> = { _formAgentEffectiveDryRun: false },
	realSend = 1,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO jobs(id,company_id,company_name,target_url,target_domain,payload_json,status,created_at,updated_at,real_send) VALUES (?,?,?,?,?,?,?,?,?,?)`,
	)
		.bind(
			id,
			`company-${id}`,
			"架空の会社",
			"https://example.com/contact",
			"example.com",
			JSON.stringify({
				campaign: "test-campaign",
				formValues: { message: "テスト本文", subject: "テスト件名" },
				...payload,
			}),
			status,
			createdAt,
			completedAt ?? createdAt,
			realSend,
		)
		.run();
	if (
		completedAt &&
		["sent", "failed", "uncertain", "prohibited"].includes(status)
	)
		await env.DB.prepare(
			"INSERT INTO results(job_id,outcome,reason_code,reason,completed_at) VALUES (?,?,?,?,?)",
		)
			.bind(
				id,
				status,
				status === "sent" ? "SENT" : "TEST_REASON",
				"テスト理由",
				completedAt,
			)
			.run();
}
async function evidence(
	jobId: string,
	id: string,
	key = `jobs/${jobId}/before_submit/${id}.jpg`,
	type = "image/jpeg",
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO events(id,job_id,attempt,type,data_json,created_at) VALUES(?,?,1,'evidence.captured',?,'2026-09-05T14:59:01.000Z')",
	)
		.bind(
			id,
			jobId,
			JSON.stringify({
				objectKey: key,
				stage: "before_submit",
				contentType: type,
			}),
		)
		.run();
}

describe("dashboard authorization", () => {
	test("denies before any database read, including evidence and forged email headers", async () => {
		const db = {
			prepare: vi.fn(() => {
				throw new Error("must not read");
			}),
		};
		for (const path of [
			"/admin",
			"/admin/jobs",
			"/admin/jobs/one",
			"/admin/jobs/one/evidence/e1",
		]) {
			const response = await handleHttpRequest(
				new Request(`https://dashboard.test${path}`, {
					headers: {
						"cf-access-authenticated-user-email": owner,
						authorization: "Bearer job-token",
					},
				}),
				{
					...settings(),
					DB: db as unknown as D1Database,
					JOB_API_TOKEN: "job-token",
				},
			);
			expect(response.status).toBe(403);
			expect(response.headers.get("cache-control")).toContain("no-store");
		}
		expect(db.prepare).not.toHaveBeenCalled();
	});
	test("accepts only a signed, unexpired token for this owner, issuer and audience", async () => {
		const check = async (jwt: string, config: Env = settings()) =>
			authorizeAdmin(
				new Request("https://dashboard.test/admin", {
					headers: { "cf-access-jwt-assertion": jwt },
				}),
				config,
			);
		expect(await check(await token())).toBe(true);
		for (const jwt of [
			await token({ email: "another@example.com" }),
			await token({ issuer: "https://other.cloudflareaccess.com" }),
			await token({ audience: "other-app" }),
			await token({ expired: true }),
			"forged.token.value",
		])
			expect(await check(jwt)).toBe(false);
		const signed = await token();
		expect(
			await check(
				signed.slice(0, signed.lastIndexOf(".") + 1) +
					(signed[signed.lastIndexOf(".") + 1] === "a" ? "b" : "a") +
					signed.slice(signed.lastIndexOf(".") + 2),
			),
		).toBe(false);
		const noEmail: Env = { ...settings() };
		delete noEmail.ADMIN_EMAIL;
		expect(await check(signed, noEmail)).toBe(false);
		expect(
			await check(signed, {
				...settings(),
				ADMIN_ACCESS_ISSUER: "https://attacker.test",
			}),
		).toBe(false);
	});
	test("exposes no write action and does not treat the admin JWT as a send credential", async () => {
		expect((await request("/admin/jobs", { method: "POST" })).status).toBe(405);
		expect(
			(
				await request("/jobs", {
					method: "POST",
					config: { ...settings(), JOB_API_TOKEN: "job-token" },
				})
			).status,
		).toBe(401);
	});
});

describe("dashboard read model", () => {
	test("uses JST boundaries and separates registration cohorts from completion dates", async () => {
		await seed(
			"before",
			"sent",
			"2026-09-04T14:59:59.999Z",
			"2026-09-05T15:00:00.000Z",
		);
		await seed(
			"start",
			"sent",
			"2026-09-04T15:00:00.000Z",
			"2026-09-05T15:00:00.000Z",
		);
		await seed(
			"end",
			"uncertain",
			"2026-09-05T14:59:59.999Z",
			"2026-09-05T14:59:59.999Z",
		);
		await seed(
			"outside",
			"sent",
			"2026-09-05T15:00:00.000Z",
			"2026-09-06T15:00:00.000Z",
		);
		const f = parseAdminFilters(
			new URLSearchParams("from=2026-09-05&to=2026-09-05"),
		);
		const day = await loadAdminOverview(env.DB, f);
		expect(day.total).toBe(2);
		expect(day.counts.sent).toBe(1);
		expect(day.counts.uncertain).toBe(1);
		expect(day.daily).toMatchObject([
			{
				day: "2026-09-05",
				registered: 2,
				sent: 0,
				counts: { sent: 1, uncertain: 1, failed: 0 },
			},
		]);
		const next = await loadAdminOverview(
			env.DB,
			parseAdminFilters(new URLSearchParams("from=2026-09-06&to=2026-09-06")),
		);
		expect(next.daily).toMatchObject([
			{
				day: "2026-09-06",
				registered: 1,
				sent: 2,
				counts: { sent: 1, uncertain: 0 },
			},
		]);
	});
	test("keeps managed tests, dry runs and unknown history out of ordinary counts", async () => {
		await seed("ordinary");
		await seed(
			"managed",
			"sent",
			undefined,
			undefined,
			{ _formAgentEffectiveDryRun: false, _formAgentRealSendGuardExempt: true },
			0,
		);
		await seed(
			"dry",
			"sent",
			undefined,
			undefined,
			{ _formAgentEffectiveDryRun: true },
			0,
		);
		await seed("historic", "sent", undefined, undefined, {}, 0);
		for (const [kind, id] of [
			["real", "ordinary"],
			["managed", "managed"],
			["dry_run", "dry"],
			["unknown", "historic"],
		]) {
			const data = await loadAdminOverview(
				env.DB,
				parseAdminFilters(
					new URLSearchParams(`from=2026-09-05&to=2026-09-06&kind=${kind}`),
				),
			);
			expect(data.jobs.map((j) => j.id)).toEqual([id]);
			expect(data.completedSent).toBe(1);
			expect(data.daily.reduce((sum, d) => sum + d.counts.sent, 0)).toBe(1);
		}
	});
	test("uses bound literal search, campaign and status filters", async () => {
		await seed("sent");
		await seed("uncertain", "uncertain");
		const data = await loadAdminOverview(
			env.DB,
			parseAdminFilters(
				new URLSearchParams(
					"from=2026-09-05&to=2026-09-06&status=uncertain&campaign=test-campaign&q=example.com",
				),
			),
		);
		expect(data.jobs.map((j) => j.id)).toEqual(["uncertain"]);
		expect(data.counts.sent).toBe(1);
		for (const q of ["%' OR 1=1 --", "_"]) {
			const f = new URLSearchParams({
				from: "2026-09-05",
				to: "2026-09-06",
				q,
			});
			expect(
				(await loadAdminOverview(env.DB, parseAdminFilters(f))).total,
			).toBe(0);
		}
	});
	test("paginates deterministically when creation timestamps are identical", async () => {
		for (let i = 0; i < 51; i++)
			await seed(`page-${String(i).padStart(3, "0")}`);
		const first = await loadAdminOverview(
			env.DB,
			parseAdminFilters(new URLSearchParams("from=2026-09-05&to=2026-09-06")),
		);
		const second = await loadAdminOverview(
			env.DB,
			parseAdminFilters(
				new URLSearchParams("from=2026-09-05&to=2026-09-06&page=2"),
			),
		);
		expect(first.jobs).toHaveLength(50);
		expect(second.jobs.map((j) => j.id)).toEqual(["page-000"]);
		expect(new Set([...first.jobs, ...second.jobs].map((j) => j.id)).size).toBe(
			51,
		);
	});
	test.each([
		"from=2026-02-30",
		"from=2026-09-07&to=2026-09-05",
		"from=2020-01-01&to=2026-09-05",
		"page=0",
		"page=1e3",
		"status=made-up",
		"kind=made-up",
	])("rejects invalid filters: %s", async (query) => {
		expect((await request(`/admin?${query}`)).status).toBe(400);
	});
});

describe("dashboard pages and private evidence", () => {
	test("renders and escapes stored text without exposing the raw payload or run token", async () => {
		await seed("xss", "uncertain", undefined, undefined, {
			_formAgentEffectiveDryRun: false,
			hiddenSecret: "must-not-render",
			formValues: { message: '<script>alert("xss")</script>' },
		});
		await env.DB.prepare(
			"UPDATE jobs SET company_name=?,run_token='private-run-token' WHERE id='xss'",
		)
			.bind('<img src=x onerror="alert(1)">')
			.run();
		const response = await request("/admin/jobs/xss");
		const text = await response.text();
		expect(text).toContain("&lt;script&gt;");
		expect(text).not.toContain("<script>alert");
		expect(text).toContain("&lt;img");
		expect(text).not.toContain("must-not-render");
		expect(text).not.toContain("private-run-token");
		expect(text).toContain("完了未確認");
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
	});
	test("loads matching R2 bytes only through the owning job and event", async () => {
		await seed("a");
		await seed("b");
		await evidence("a", "ea");
		const bytes = new Uint8Array([255, 216, 255, 217]);
		await env.EVIDENCE_BUCKET.put("jobs/a/before_submit/ea.jpg", bytes, {
			httpMetadata: { contentType: "image/jpeg" },
		});
		const success = await request("/admin/jobs/a/evidence/ea");
		expect(success.status).toBe(200);
		expect(new Uint8Array(await success.arrayBuffer())).toEqual(bytes);
		expect(success.headers.get("cache-control")).toContain("no-store");
		expect((await request("/admin/jobs/b/evidence/ea")).status).toBe(404);
		await evidence("b", "cross", "jobs/a/before_submit/ea.jpg");
		expect((await request("/admin/jobs/b/evidence/cross")).status).toBe(404);
	});
	test("distinguishes missing objects and capture failures and refuses active content", async () => {
		await seed("missing");
		await evidence("missing", "em");
		await env.DB.prepare(
			"INSERT INTO events(id,job_id,attempt,type,data_json,created_at) VALUES ('failure','missing',1,'evidence.capture_failed',?, '2026-09-05T15:00:00Z')",
		)
			.bind(
				JSON.stringify({
					stage: "after_submit",
					failureCode: "CAPTURE_TIMEOUT",
				}),
			)
			.run();
		const text = await (await request("/admin/jobs/missing")).text();
		expect(text).toContain("証跡ファイルが見つかりません");
		expect(text).toContain("CAPTURE_TIMEOUT");
		expect((await request("/admin/jobs/missing/evidence/em")).status).toBe(404);
		await env.EVIDENCE_BUCKET.put(
			"jobs/missing/before_submit/em.jpg",
			"<script>alert(1)</script>",
			{ httpMetadata: { contentType: "text/html" } },
		);
		expect((await request("/admin/jobs/missing/evidence/em")).status).toBe(415);
	});
	test("renders empty states, not-found and read failure without invented zero stats", async () => {
		expect(
			await (await request("/admin?from=2026-09-05&to=2026-09-06")).text(),
		).toContain("条件に一致するジョブがありません");
		expect((await request("/admin/jobs/not-found")).status).toBe(404);
		const db = {
			batch: () => Promise.reject(new Error("sensitive database detail")),
		};
		const response = await request("/admin", {
			config: { ...settings(), DB: db as unknown as D1Database },
		});
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("sensitive database detail");
	});
});
