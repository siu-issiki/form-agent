import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { AgentExecutionError, type AgentExecutor } from "../src/agent-executor";
import { AgentToolGateway } from "../src/agent-tool-service";
import {
	BrowserToolCoordinator,
	type BrowserToolName,
} from "../src/browser-tool-handler";
import { D1JobStore } from "../src/d1-job-store";
import {
	handleAgentToolRequest,
	proxyOpenAiRequest,
} from "../src/form-agent-sandbox";
import type { JobInput } from "../src/job";
import type {
	BrowserSubmitResult,
	RestrictedBrowserDriver,
} from "../src/restricted-browser";
import {
	type AgentSandboxLike,
	parseRunnerResult,
	SandboxAgentExecutor,
	sandboxIdForJob,
} from "../src/sandbox-agent-executor";
import worker, {
	consumeJobBatch,
	handleHttpRequest,
	type JobMessage,
	registerJob,
} from "../src/worker";

const input: JobInput = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://form-agent.dev/contact",
	targetDomain: "form-agent.dev",
	payload: { message: "Hello" },
};

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM events"),
		env.DB.prepare("DELETE FROM results"),
		env.DB.prepare("DELETE FROM jobs"),
	]);
});

describe("D1JobStore", () => {
	test("allows only one concurrent run claim", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");

		const claims = await Promise.all([
			store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z"),
			store.claimRun(input.id, "run-token-2", "2026-08-28T00:00:01.000Z"),
		]);

		expect(claims.filter((job) => job !== null)).toHaveLength(1);
		const persisted = await store.find(input.id);
		expect(persisted?.status).toBe("running");
		expect(persisted?.attemptCount).toBe(1);
	});

	test("persists an uncertain result and blocks another submission", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:02.000Z",
		);

		const uncertain = await store.recordUncertain(
			input.id,
			"run-token-1",
			"SUBMIT_RESULT_UNKNOWN",
			"The response was lost after submission.",
			"2026-08-28T00:00:03.000Z",
		);
		const repeatedResult = await store.recordUncertain(
			input.id,
			"run-token-1",
			"SUBMIT_RESULT_UNKNOWN",
			"The response was lost after submission.",
			"2026-08-28T00:00:04.000Z",
		);
		const duplicate = await store.claimSubmission(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:04.000Z",
		);

		expect(uncertain?.status).toBe("uncertain");
		expect(uncertain?.result?.reasonCode).toBe("SUBMIT_RESULT_UNKNOWN");
		expect(repeatedResult).toBeNull();
		expect(duplicate).toBeNull();
	});
});

describe("Job HTTP API", () => {
	const apiToken = "test-job-api-token";
	const queued: JobMessage[] = [];
	const apiEnv = {
		DB: env.DB,
		JOB_API_TOKEN: apiToken,
		JOB_QUEUE: {
			async send(message: JobMessage) {
				queued.push(message);
			},
		} as unknown as Queue<JobMessage>,
	};

	beforeEach(() => {
		queued.length = 0;
	});

	test("rejects unauthenticated registration without creating a job", async () => {
		const response = await handleHttpRequest(
			jobRequest("POST", "/jobs", input),
			apiEnv,
		);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe("Bearer");
		expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
		expect(await new D1JobStore(env.DB).find(input.id)).toBeNull();
		expect(queued).toEqual([]);
	});

	test("registers and retrieves a job without exposing its run token", async () => {
		const created = await handleHttpRequest(
			jobRequest("POST", "/jobs", input, apiToken),
			apiEnv,
		);
		const createdBody = (await created.json()) as {
			created: boolean;
			job: Record<string, unknown>;
		};

		expect(created.status).toBe(201);
		expect(created.headers.get("cache-control")).toBe("no-store");
		expect(createdBody.created).toBe(true);
		expect(createdBody.job).toMatchObject({ id: input.id, status: "pending" });
		expect(createdBody.job).not.toHaveProperty("runToken");
		expect(queued).toEqual([{ jobId: input.id }]);

		const fetched = await handleHttpRequest(
			jobRequest("GET", `/jobs/${input.id}`, undefined, apiToken),
			apiEnv,
		);
		const fetchedBody = (await fetched.json()) as {
			job: Record<string, unknown>;
		};

		expect(fetched.status).toBe(200);
		expect(fetchedBody.job).toMatchObject({
			id: input.id,
			payload: input.payload,
			status: "pending",
		});
		expect(fetchedBody.job).not.toHaveProperty("runToken");
	});

	test("returns the existing pending job for duplicate registration", async () => {
		const first = await handleHttpRequest(
			jobRequest("POST", "/jobs", input, apiToken),
			apiEnv,
		);
		const duplicate = await handleHttpRequest(
			jobRequest("POST", "/jobs", input, apiToken),
			apiEnv,
		);

		expect(first.status).toBe(201);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({
			created: false,
			job: { id: input.id, status: "pending" },
		});
		expect(queued).toEqual([{ jobId: input.id }, { jobId: input.id }]);
	});

	test("rejects a duplicate id with different input without leaking the job", async () => {
		await handleHttpRequest(
			jobRequest("POST", "/jobs", input, apiToken),
			apiEnv,
		);
		const conflict = await handleHttpRequest(
			jobRequest(
				"POST",
				"/jobs",
				{ ...input, companyName: "Other Inc.", payload: { message: "Other" } },
				apiToken,
			),
			apiEnv,
		);

		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "JOB_ID_CONFLICT" });
		expect(queued).toEqual([{ jobId: input.id }]);
		expect(await new D1JobStore(env.DB).find(input.id)).toMatchObject(input);
	});

	test("rejects malformed jobs before persistence", async () => {
		const mismatchedDomain = {
			...input,
			targetDomain: "evil.test",
		};
		const invalidDomain = await handleHttpRequest(
			jobRequest("POST", "/jobs", mismatchedDomain, apiToken),
			apiEnv,
		);
		const invalidPayload = await handleHttpRequest(
			jobRequest(
				"POST",
				"/jobs",
				{ ...input, id: "job-002", payload: [] },
				apiToken,
			),
			apiEnv,
		);

		expect(invalidDomain.status).toBe(400);
		expect(await invalidDomain.json()).toEqual({ error: "INVALID_JOB" });
		expect(invalidPayload.status).toBe(400);
		expect(await invalidPayload.json()).toEqual({ error: "INVALID_JOB" });
		expect(await new D1JobStore(env.DB).find(input.id)).toBeNull();
		expect(queued).toEqual([]);
	});

	test("fails closed when the API token is not configured", async () => {
		const response = await handleHttpRequest(
			jobRequest("GET", `/jobs/${input.id}`, undefined, apiToken),
			{ DB: apiEnv.DB, JOB_QUEUE: apiEnv.JOB_QUEUE },
		);

		expect(response.status).toBe(401);
	});

	test("stops reading a body when it exceeds the request limit", async () => {
		const response = await handleHttpRequest(
			new Request("https://form-agent.test/jobs", {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiToken}`,
					"content-type": "application/json",
				},
				body: "x".repeat(64 * 1024 + 1),
			}),
			apiEnv,
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "REQUEST_TOO_LARGE" });
		expect(queued).toEqual([]);
	});
});

function jobRequest(
	method: "GET" | "POST",
	pathname: string,
	body?: unknown,
	token?: string,
): Request {
	const headers = new Headers();
	if (token) headers.set("authorization", `Bearer ${token}`);
	if (body !== undefined) headers.set("content-type", "application/json");
	const init: RequestInit = {
		method,
		headers,
	};
	if (body !== undefined) init.body = JSON.stringify(body);
	return new Request(`https://form-agent.test${pathname}`, init);
}

describe("AgentToolGateway", () => {
	const toolNow = () => "2026-08-28T00:00:02.000Z";

	test("scopes job access and submission permission to the current run token", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB, toolNow);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const stale = await gateway.find(input.id, "run-token-2");
		const running = await gateway.find(input.id, "run-token-1");
		const submitting = await gateway.claimSubmission(input.id, "run-token-1");

		expect(stale).toBeNull();
		expect(running?.status).toBe("running");
		expect(submitting?.status).toBe("submitting");
	});

	test("records a sent result only for the persisted target domain", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB, toolNow);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		await gateway.claimSubmission(input.id, "run-token-1");

		await expect(
			gateway.recordSent(input.id, "run-token-1", "https://evil.test/collect"),
		).rejects.toThrow();
		const sent = await gateway.recordSent(
			input.id,
			"run-token-1",
			input.targetUrl,
		);

		expect(sent?.status).toBe("sent");
		expect(sent?.result?.formUrl).toBe(input.targetUrl);
	});

	test("rejects stale tokens and unbounded uncertain reasons", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB, toolNow);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const stale = await gateway.recordUncertain(
			input.id,
			"run-token-2",
			"FORM_UNCLEAR",
			"The form purpose could not be confirmed.",
		);
		await expect(
			gateway.recordUncertain(
				input.id,
				"run-token-1",
				"invalid-code",
				"x".repeat(1_001),
			),
		).rejects.toThrow();

		expect(stale).toBeNull();
	});
});

describe("FormAgentSandbox outbound handlers", () => {
	const openAiScope = {
		jobId: input.id,
		runToken: "run-token-1",
		model: "gpt-5.4-mini",
		maxRequests: 16,
		maxOutputTokens: 4_096,
	};

	test("exposes only run-scoped job data", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(
			env.DB,
			() => "2026-08-28T00:00:02.000Z",
		);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const stale = await handleAgentToolRequest(
			new Request("http://agent-tools.internal/job"),
			gateway,
			{ jobId: input.id, runToken: "run-token-2" },
		);
		const current = await handleAgentToolRequest(
			new Request("http://agent-tools.internal/job"),
			gateway,
			{ jobId: input.id, runToken: "run-token-1" },
		);
		const rawClaim = await handleAgentToolRequest(
			new Request("http://agent-tools.internal/submission/claim", {
				method: "POST",
			}),
			gateway,
			{ jobId: input.id, runToken: "run-token-1" },
		);
		const rawSent = await handleAgentToolRequest(
			new Request("http://agent-tools.internal/submission/sent", {
				method: "POST",
				body: JSON.stringify({ formUrl: "https://evil.test/collect" }),
			}),
			gateway,
			{ jobId: input.id, runToken: "run-token-1" },
		);
		expect(stale.status).toBe(404);
		expect(current.status).toBe(200);
		const currentBody = (await current.json()) as {
			job: { runToken?: unknown };
		};
		expect(currentBody.job.runToken).toBeUndefined();
		expect(rawClaim.status).toBe(404);
		expect(rawSent.status).toBe(404);
		expect((await store.find(input.id))?.status).toBe("running");
	});

	test("routes browser tools without exposing low-level submission mutations", async () => {
		const calls: unknown[][] = [];
		const browserTool = async (
			tool: BrowserToolName,
			params: Record<string, unknown>,
		) => {
			calls.push([tool, params]);
			return { result: { ok: true } };
		};
		const navigate = await handleAgentToolRequest(
			new Request("http://agent-tools.internal/browser/navigate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: input.targetUrl }),
			}),
			new AgentToolGateway(env.DB),
			{ jobId: input.id, runToken: "run-token-1" },
			browserTool,
		);
		const rawSent = await handleAgentToolRequest(
			new Request("http://agent-tools.internal/submission/sent", {
				method: "POST",
			}),
			new AgentToolGateway(env.DB),
			{ jobId: input.id, runToken: "run-token-1" },
			browserTool,
		);

		expect(navigate.status).toBe(200);
		expect(calls).toEqual([["navigate", { url: input.targetUrl }]]);
		expect(rawSent.status).toBe(404);
	});

	test("injects the OpenAI credential and enforces the run model budget", async () => {
		let forwarded: Request | undefined;
		const upstreamFetch = (async (request: RequestInfo | URL) => {
			forwarded = new Request(request);
			return new Response("ok");
		}) as typeof fetch;
		const response = await proxyOpenAiRequest(
			new Request("http://api.openai.com/v1/responses", {
				method: "POST",
				headers: {
					authorization: "Bearer sandbox-controlled",
					cookie: "must-not-leave",
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "gpt-5.4-mini" }),
			}),
			"worker-secret",
			openAiScope,
			async () => true,
			upstreamFetch,
		);

		expect(response.status).toBe(200);
		expect(forwarded?.url).toBe("https://api.openai.com/v1/responses");
		expect(forwarded?.headers.get("authorization")).toBe(
			"Bearer worker-secret",
		);
		expect(forwarded?.headers.get("cookie")).toBeNull();
		expect(await forwarded?.json()).toMatchObject({
			model: "gpt-5.4-mini",
			max_output_tokens: 4_096,
		});
	});

	test("denies unapproved provider endpoints", async () => {
		const response = await proxyOpenAiRequest(
			new Request("https://api.openai.com/v1/files", { method: "POST" }),
			"worker-secret",
			openAiScope,
			async () => true,
		);

		expect(response.status).toBe(403);
	});

	test("denies model changes, remote tools, and requests beyond the D1 limit", async () => {
		const store = new D1JobStore(env.DB);
		const gateway = new AgentToolGateway(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const request = (body: unknown) =>
			new Request("https://api.openai.com/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const claim = () =>
			gateway.claimProviderRequest(input.id, "run-token-1", 1);
		const upstreamFetch = (async () => new Response("ok")) as typeof fetch;

		const changedModel = await proxyOpenAiRequest(
			request({ model: "gpt-5.4" }),
			"worker-secret",
			openAiScope,
			claim,
			upstreamFetch,
		);
		const remoteTool = await proxyOpenAiRequest(
			request({ model: "gpt-5.4-mini", tools: [{ type: "web_search" }] }),
			"worker-secret",
			openAiScope,
			claim,
			upstreamFetch,
		);
		const first = await proxyOpenAiRequest(
			request({ model: "gpt-5.4-mini" }),
			"worker-secret",
			openAiScope,
			claim,
			upstreamFetch,
		);
		const repeated = await proxyOpenAiRequest(
			request({ model: "gpt-5.4-mini" }),
			"worker-secret",
			openAiScope,
			claim,
			upstreamFetch,
		);

		expect(changedModel.status).toBe(403);
		expect(remoteTool.status).toBe(403);
		expect(first.status).toBe(200);
		expect(repeated.status).toBe(429);
	});

	test("denies multiple Chat Completions candidates", async () => {
		const response = await proxyOpenAiRequest(
			new Request("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.4-mini", n: 2 }),
			}),
			"worker-secret",
			openAiScope,
			async () => true,
		);

		expect(response.status).toBe(403);
	});

	test("rejects oversized provider request bodies before claiming budget", async () => {
		let claimed = false;
		const response = await proxyOpenAiRequest(
			new Request("https://api.openai.com/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.4-mini",
					input: "x".repeat(128 * 1_024),
				}),
			}),
			"worker-secret",
			openAiScope,
			async () => {
				claimed = true;
				return true;
			},
		);

		expect(response.status).toBe(413);
		expect(claimed).toBe(false);
	});
});

describe("SandboxAgentExecutor", () => {
	test("scopes outbound handlers before launching the bounded runner", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) {
			throw new Error("Expected a claimed job");
		}
		const handlerCalls: unknown[][] = [];
		let sandboxId: string | undefined;
		let launchEnv: Record<string, string> | undefined;
		let destroyed = false;
		let browserClosed = false;
		const sandbox: AgentSandboxLike = {
			async closeBrowser() {
				browserClosed = true;
			},
			async setAllowedHosts(hosts) {
				handlerCalls.push(["allowed", hosts]);
			},
			async setOutboundByHost(host, handler, params) {
				handlerCalls.push([host, handler, params]);
			},
			async exec(_command, options) {
				launchEnv = options.env;
				return {
					async output() {
						return {
							stdout: JSON.stringify({
								outcome: "failed",
								reasonCode: "FORM_NOT_FOUND",
								reason: "No compatible form was found.",
								retryable: false,
							}),
							stderr: "",
							exitCode: 0,
							timedOut: false,
							truncated: false,
						};
					},
					async kill() {},
				};
			},
			async destroy() {
				destroyed = true;
			},
		};
		const executor = new SandboxAgentExecutor((id) => {
			sandboxId = id;
			return sandbox;
		}, "gpt-5.4-mini");

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result.outcome).toBe("failed");
		expect(handlerCalls).toContainEqual([
			"agent-tools.internal",
			"agentTools",
			{
				jobId: input.id,
				runToken: "run-token-1",
				sandboxId: await sandboxIdForJob(input.id),
			},
		]);
		expect(handlerCalls).toContainEqual([
			"api.openai.com",
			"openai",
			{
				jobId: input.id,
				runToken: "run-token-1",
				model: "gpt-5.4-mini",
				maxRequests: 16,
				maxOutputTokens: 4_096,
			},
		]);
		expect(sandboxId).toBe(await sandboxIdForJob(input.id));
		expect(launchEnv).toEqual({
			FORM_AGENT_MODEL: "gpt-5.4-mini",
			FORM_AGENT_MAX_OUTPUT_TOKENS: "4096",
			FORM_AGENT_TOOL_BASE_URL: "http://agent-tools.internal",
			OPENAI_API_KEY: "injected-by-worker-outbound-handler",
		});
		expect(destroyed).toBe(true);
		expect(browserClosed).toBe(true);
	});

	test("kills a process obtained after the deadline before returning", async () => {
		let resolveProcess:
			| ((process: Awaited<ReturnType<AgentSandboxLike["exec"]>>) => void)
			| undefined;
		let markExecStarted: (() => void) | undefined;
		const execStarted = new Promise<void>((resolve) => {
			markExecStarted = resolve;
		});
		let killCount = 0;
		let destroyed = false;
		const sandbox: AgentSandboxLike = {
			async setAllowedHosts() {},
			async setOutboundByHost() {},
			exec() {
				markExecStarted?.();
				return new Promise((resolve) => {
					resolveProcess = resolve;
				});
			},
			async destroy() {
				destroyed = true;
			},
		};
		const controller = new AbortController();
		const executor = new SandboxAgentExecutor(() => sandbox, "gpt-5.4-mini");
		const execution = executor.execute(
			{
				job: {
					...input,
					status: "running",
					attemptCount: 1,
					runToken: "run-token-1",
					result: null,
					createdAt: "2026-08-28T00:00:00.000Z",
					updatedAt: "2026-08-28T00:00:01.000Z",
				},
				runToken: "run-token-1",
				maxDurationMs: 60_000,
			},
			controller.signal,
		);
		await execStarted;
		controller.abort();
		resolveProcess?.({
			async output() {
				throw new Error("output must not be read after abort");
			},
			async kill() {
				killCount += 1;
			},
		});

		const error = await execution.catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("AGENT_TIMEOUT");
		expect(killCount).toBe(1);
		expect(destroyed).toBe(true);
	});

	test("derives valid collision-resistant sandbox IDs from arbitrary job IDs", async () => {
		const reserved = await sandboxIdForJob("api");
		const long = await sandboxIdForJob("x".repeat(1_000));

		expect(reserved).toMatch(/^job-[a-f0-9]{48}$/);
		expect(long).toMatch(/^job-[a-f0-9]{48}$/);
		expect(reserved).not.toBe(long);
		expect(await sandboxIdForJob("api")).toBe(reserved);
	});

	test("rejects a runner result containing an outside form URL", () => {
		let error: unknown;
		try {
			parseRunnerResult(
				JSON.stringify({ outcome: "sent", formUrl: "https://evil.test" }),
				input.targetDomain,
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect((error as AgentExecutionError).reasonCode).toBe(
			"AGENT_RESULT_INVALID",
		);
	});
});

describe("BrowserToolCoordinator", () => {
	test("keeps one run-scoped browser and persists submit through RestrictedBrowserTools", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const driver = new WorkerFakeBrowserDriver();
		let createCount = 0;
		const coordinator = new BrowserToolCoordinator(env.DB, async () => {
			createCount += 1;
			return driver;
		});

		const observed = await coordinator.execute(
			input.id,
			"run-token-1",
			"observe",
			{},
		);
		const submitted = await coordinator.execute(
			input.id,
			"run-token-1",
			"submit",
			{ elementId: "fa-0-1" },
		);
		await expect(
			coordinator.execute(input.id, "run-token-1", "observe", {}),
		).rejects.toBeInstanceOf(Error);
		await coordinator.close();

		expect(observed).toEqual({
			result: { url: input.targetUrl, forms: [] },
		});
		expect(submitted).toMatchObject({ job: { status: "sent" } });
		expect("runToken" in (submitted as { job: object }).job).toBe(false);
		expect(createCount).toBe(1);
		expect(driver.restrictedDomain).toBe(input.targetDomain);
		expect(driver.closed).toBe(true);
	});
});

class WorkerFakeBrowserDriver implements RestrictedBrowserDriver {
	url = input.targetUrl;
	restrictedDomain: string | undefined;
	closed = false;

	async close(): Promise<void> {
		this.closed = true;
	}
	async restrictToDomain(targetDomain: string): Promise<void> {
		this.restrictedDomain = targetDomain;
	}
	async currentUrl(): Promise<string> {
		return this.url;
	}
	async navigate(url: string): Promise<void> {
		this.url = url;
	}
	async observe() {
		return { url: this.url, forms: [] };
	}
	async clickNonSubmit(): Promise<void> {}
	async fill(): Promise<void> {}
	async select(): Promise<void> {}
	async validateSubmit(): Promise<void> {}
	async submit(): Promise<BrowserSubmitResult> {
		return { outcome: "sent", formUrl: this.url };
	}
}

describe("Queue orchestration", () => {
	test("registers a pending job before enqueueing it", async () => {
		const sent: JobMessage[] = [];
		const queue = {
			async send(message: JobMessage) {
				sent.push(message);
			},
		};

		const registered = await registerJob(
			env.DB,
			queue,
			input,
			"2026-08-28T00:00:00.000Z",
		);

		expect(registered.created).toBe(true);
		expect(registered.job.status).toBe("pending");
		expect(sent).toEqual([{ jobId: input.id }]);
	});

	test("fails closed before acknowledging duplicate deliveries", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
			{
				id: "message-2",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();

		await worker.queue?.(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1", "message-2"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("failed");
		expect(persisted?.attemptCount).toBe(1);
		expect(persisted?.result?.reasonCode).toBe("EXECUTOR_NOT_CONFIGURED");
	});

	test("resumes a run claimed by the same queue message", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "message-1", "2026-08-28T00:00:01.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:02.000Z"),
				body: { jobId: input.id },
				attempts: 2,
			},
		]);
		const ctx = createExecutionContext();

		await worker.queue?.(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("failed");
		expect(persisted?.attemptCount).toBe(2);
	});

	test("persists a prohibited agent decision and acknowledges the message", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute() {
				return {
					outcome: "prohibited",
					formUrl: input.targetUrl,
					reasonCode: "SALES_PROHIBITED",
					reason: "Sales messages are prohibited.",
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("prohibited");
		expect(persisted?.result?.reasonCode).toBe("SALES_PROHIBITED");
	});

	test("retries a retryable agent failure without releasing the run claim", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute() {
				return {
					outcome: "failed",
					reasonCode: "PROVIDER_RATE_LIMITED",
					reason: "The provider rate limit was reached.",
					retryable: true,
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual([]);
		expect(result.retryMessages).toHaveLength(1);
		expect(persisted?.status).toBe("running");
		expect(persisted?.runToken).toBe("message-1");
	});

	test("fails closed when the agent reports sent without a D1 sent result", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute() {
				return { outcome: "sent", formUrl: input.targetUrl };
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("SENT_RESULT_NOT_PERSISTED");
	});

	test("does not retry a retryable failure after submission permission", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();
		const executor: AgentExecutor = {
			async execute(agentInput) {
				await store.claimSubmission(
					agentInput.job.id,
					agentInput.runToken,
					"2026-08-28T00:00:02.000Z",
				);
				return {
					outcome: "failed",
					reasonCode: "BROWSER_CONNECTION_LOST",
					reason: "The browser connection was lost.",
					retryable: true,
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("uncertain");
		expect(persisted?.result?.reasonCode).toBe("AGENT_RESULT_CONFLICT");
	});

	test("marks a safe job state as dead-lettered", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs-dlq", [
			{
				id: "dlq-message-1",
				timestamp: new Date("2026-08-28T00:00:03.000Z"),
				body: { jobId: input.id },
				attempts: 1,
			},
		]);
		const ctx = createExecutionContext();

		await worker.queue?.(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(input.id);
		const event = await env.DB.prepare(
			"SELECT type, data_json FROM events WHERE job_id = ?",
		)
			.bind(input.id)
			.first<{ type: string; data_json: string }>();

		expect(result.explicitAcks).toEqual(["dlq-message-1"]);
		expect(persisted?.status).toBe("dead_lettered");
		expect(event?.type).toBe("job.dead_lettered");
		expect(JSON.parse(event?.data_json ?? "{}")).toEqual({
			reason: "QUEUE_RETRY_EXHAUSTED",
		});
	});
});
