import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentExecutionError, type AgentExecutor } from "../src/agent-executor";
import {
	BrowserToolCoordinator,
	BrowserToolInputError,
} from "../src/browser-tool-handler";
import { BrowserUseCdpPayloadTooLargeError } from "../src/browser-use-cdp";
import { D1JobStore } from "../src/d1-job-store";
import type { JobInput } from "../src/job";
import { ResponsesAgentExecutor } from "../src/responses-agent-executor";
import {
	BrowserElementError,
	type BrowserSubmitResult,
	type RestrictedBrowserDriver,
	type SubmitActivationStrategy,
} from "../src/restricted-browser";
import worker, {
	consumeJobBatch,
	handleHttpRequest,
	isAgentDryRun,
	type JobMessage,
	registerJob,
} from "../src/worker";

const input: JobInput = {
	id: "job-001",
	companyId: "company-001",
	companyName: "Example Inc.",
	targetUrl: "https://form-agent.dev/contact",
	targetDomain: "form-agent.dev",
	allowedHosts: [],
	payload: { formValues: { message: "Hello" } },
};

test("keeps agent dry-run enabled unless production submission is explicitly enabled", () => {
	expect(isAgentDryRun(undefined)).toBe(true);
	expect(isAgentDryRun("true")).toBe(true);
	expect(isAgentDryRun("false")).toBe(false);
});

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

	test("enforces the persisted provider request limit", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");

		const first = await store.claimProviderRequest(
			input.id,
			"run-token-1",
			1,
			"2026-08-28T00:00:02.000Z",
		);
		const repeated = await store.claimProviderRequest(
			input.id,
			"run-token-1",
			1,
			"2026-08-28T00:00:03.000Z",
		);

		expect(first).toBe(true);
		expect(repeated).toBe(false);
		const counter = await env.DB.prepare(
			"SELECT provider_request_count FROM jobs WHERE id = ?",
		)
			.bind(input.id)
			.first<{ provider_request_count: number }>();
		expect(counter?.provider_request_count).toBe(1);
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

	test("persists a normalized job-specific external host scope", async () => {
		const external = {
			...input,
			targetUrl: "https://forms.gle/example",
			allowedHosts: ["DOCS.GOOGLE.COM.", "forms.gle", "forms.gle"],
		};
		const created = await handleHttpRequest(
			jobRequest("POST", "/jobs", external, apiToken),
			apiEnv,
		);
		const body = (await created.json()) as {
			job: { allowedHosts: string[] };
		};

		expect(created.status).toBe(201);
		expect(body.job.allowedHosts).toEqual(["docs.google.com", "forms.gle"]);
		expect((await new D1JobStore(env.DB).find(input.id))?.allowedHosts).toEqual(
			["docs.google.com", "forms.gle"],
		);
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
				{
					...input,
					companyName: "Other Inc.",
					payload: { formValues: { message: "Other" } },
				},
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
		const legacyPayload = await handleHttpRequest(
			jobRequest(
				"POST",
				"/jobs",
				{ ...input, id: "job-003", payload: { message: "Legacy" } },
				apiToken,
			),
			apiEnv,
		);
		const unsafeAllowedHost = await handleHttpRequest(
			jobRequest(
				"POST",
				"/jobs",
				{
					...input,
					id: "job-004",
					targetUrl: "http://127.0.0.1/contact",
					allowedHosts: ["127.0.0.1"],
				},
				apiToken,
			),
			apiEnv,
		);
		const invalidAttemptLimit = await handleHttpRequest(
			jobRequest(
				"POST",
				"/jobs",
				{
					...input,
					id: "job-005",
					payload: {
						...input.payload,
						_formAgentMaxAttempts: 0,
					},
				},
				apiToken,
			),
			apiEnv,
		);

		expect(invalidDomain.status).toBe(400);
		expect(await invalidDomain.json()).toEqual({ error: "INVALID_JOB" });
		expect(invalidPayload.status).toBe(400);
		expect(await invalidPayload.json()).toEqual({ error: "INVALID_JOB" });
		expect(legacyPayload.status).toBe(400);
		expect(await legacyPayload.json()).toEqual({ error: "INVALID_JOB" });
		expect(unsafeAllowedHost.status).toBe(400);
		expect(await unsafeAllowedHost.json()).toEqual({ error: "INVALID_JOB" });
		expect(invalidAttemptLimit.status).toBe(400);
		expect(await invalidAttemptLimit.json()).toEqual({ error: "INVALID_JOB" });
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
		const filled = await coordinator.execute(input.id, "run-token-1", "fill", {
			elementId: "fa-0-0",
			payloadKey: "message",
		});
		expect(filled).toEqual({ result: { ok: true } });
		const submitResult = await coordinator.execute(
			input.id,
			"run-token-1",
			"submit",
			{ elementId: "fa-0-1", activationStrategy: "mouse" },
		);
		await expect(
			coordinator.execute(input.id, "run-token-1", "observe", {}),
		).rejects.toBeInstanceOf(Error);
		await coordinator.close();

		expect(observed).toEqual({
			result: { url: input.targetUrl, forms: [] },
		});
		expect(submitResult).toMatchObject({ job: { status: "sent" } });
		expect("runToken" in (submitResult as { job: object }).job).toBe(false);
		expect(createCount).toBe(1);
		expect(driver.restrictedDomain).toBe(input.targetDomain);
		expect(driver.filledValues).toEqual(["Hello"]);
		expect(driver.submitActivationStrategies).toEqual(["mouse"]);
		expect(driver.closed).toBe(true);
	});

	test("rejects an unsupported submit activation before claiming permission", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const driver = new WorkerFakeBrowserDriver();
		const coordinator = new BrowserToolCoordinator(env.DB, async () => driver);
		await coordinator.execute(input.id, "run-token-1", "fill", {
			elementId: "fa-0-0",
			payloadKey: "message",
		});

		await expect(
			coordinator.execute(input.id, "run-token-1", "submit", {
				elementId: "fa-0-1",
				activationStrategy: "coordinates",
			}),
		).rejects.toBeInstanceOf(BrowserToolInputError);

		expect((await store.find(input.id))?.status).toBe("running");
		expect(driver.submitCount).toBe(0);
		await coordinator.close();
	});

	test("rejects raw, missing, and non-form payload values", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(
			{
				...input,
				payload: {
					...input.payload,
					instruction: "Do not enter this control value",
				},
			},
			"2026-08-28T00:00:00.000Z",
		);
		await store.claimRun(input.id, "run-token-1", "2026-08-28T00:00:01.000Z");
		const coordinator = new BrowserToolCoordinator(
			env.DB,
			async () => new WorkerFakeBrowserDriver(),
		);

		await expect(
			coordinator.execute(input.id, "run-token-1", "fill", {
				elementId: "fa-0-0",
				value: "invented",
			}),
		).rejects.toBeInstanceOf(BrowserToolInputError);
		await expect(
			coordinator.execute(input.id, "run-token-1", "fill", {
				elementId: "fa-0-0",
				payloadKey: "instruction",
			}),
		).rejects.toBeInstanceOf(BrowserToolInputError);
		await expect(
			coordinator.execute(input.id, "run-token-1", "fill", {
				elementId: "fa-0-0",
				payloadKey: "missing",
			}),
		).rejects.toBeInstanceOf(BrowserToolInputError);
		await coordinator.close();
	});
});

class WorkerFakeBrowserDriver implements RestrictedBrowserDriver {
	url = input.targetUrl;
	restrictedDomain: string | undefined;
	closed = false;
	observed = false;
	requireObservationForSubmit = false;
	validateSubmitCount = 0;
	submitCount = 0;
	submitActivationStrategies: SubmitActivationStrategy[] = [];
	filledValues: string[] = [];

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
		this.observed = true;
		return { url: this.url, forms: [] };
	}
	async clickNonSubmit(): Promise<void> {}
	async fill(_elementId: string, value: string): Promise<void> {
		this.filledValues.push(value);
	}
	async select(): Promise<void> {}
	async validateSubmit(): Promise<void> {
		this.validateSubmitCount += 1;
		if (this.requireObservationForSubmit && !this.observed) {
			throw new BrowserElementError();
		}
	}
	async submit(
		_elementId: string,
		activationStrategy: SubmitActivationStrategy,
	): Promise<BrowserSubmitResult> {
		this.submitCount += 1;
		this.submitActivationStrategies.push(activationStrategy);
		return { outcome: "sent", formUrl: this.url };
	}
}

describe("ResponsesAgentExecutor", () => {
	test("validates the observed submit control without browser submission for a job-level dry-run", async () => {
		const store = new D1JobStore(env.DB);
		const dryRunInput = {
			...input,
			payload: { ...input.payload, _formAgentDryRun: true },
		};
		await store.create(dryRunInput, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const requestBodies: Array<{
			tools?: Array<{
				name?: string;
				parameters?: { properties?: Record<string, unknown> };
			}>;
			instructions?: string;
		}> = [];
		const responses = [
			functionResponse("call-observe", "observe", {}),
			functionResponse("call-fill", "fill", {
				elementId: "fa-0-0",
				payloadKey: "message",
			}),
			functionResponse("call-submit", "submit", {
				elementId: "fa-0-1",
				activationStrategy: "mouse",
			}),
		];
		const driver = new WorkerFakeBrowserDriver();
		driver.requireObservationForSubmit = true;
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			dryRun: false,
			fetcher: (async (_resource, init) => {
				requestBodies.push(JSON.parse(String(init?.body)));
				const response = responses.shift();
				if (!response) throw new Error("Unexpected provider request");
				return Response.json(response);
			}) as typeof fetch,
			createBrowserDriver: async (_apiKey, _job, dryRun) => {
				expect(dryRun).toBe(true);
				return driver;
			},
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toEqual({
			outcome: "prohibited",
			formUrl: input.targetUrl,
			reasonCode: "DRY_RUN_COMPLETE",
			reason:
				"Dry-run validated the current submit control and stopped before submission authorization or browser submission.",
		});
		expect(requestBodies[0]?.tools?.map((tool) => tool.name)).toContain(
			"submit",
		);
		const fillTool = requestBodies[0]?.tools?.find(
			(tool) => tool.name === "fill",
		);
		expect(fillTool?.parameters?.properties).toHaveProperty("payloadKey");
		expect(fillTool?.parameters?.properties).not.toHaveProperty("value");
		const submitTool = requestBodies[0]?.tools?.find(
			(tool) => tool.name === "submit",
		);
		expect(submitTool?.parameters?.properties).toHaveProperty(
			"activationStrategy",
		);
		expect(requestBodies[0]?.instructions).toContain("This is a dry-run");
		expect(driver.validateSubmitCount).toBe(1);
		expect(driver.submitCount).toBe(0);
		expect(driver.closed).toBe(true);
		expect((await store.find(input.id))?.status).toBe("running");
		const diagnostics = await readAgentToolDiagnostics(input.id);
		expect(diagnostics).toEqual([
			{
				turn: 1,
				toolName: "observe",
				stage: "observe",
				resultCode: "OK",
			},
			{
				turn: 2,
				toolName: "fill",
				stage: "fill",
				resultCode: "OK",
			},
			{
				turn: 3,
				toolName: "submit",
				stage: "submit_validate",
				resultCode: "DRY_RUN_COMPLETE",
			},
		]);
		expect(JSON.stringify(diagnostics)).not.toContain(input.targetUrl);
		expect(JSON.stringify(diagnostics)).not.toContain("Hello");
	});

	test("rejects a guessed dry-run submit element before observation", async () => {
		const store = new D1JobStore(env.DB);
		const dryRunInput = {
			...input,
			payload: { ...input.payload, _formAgentDryRun: true },
		};
		await store.create(dryRunInput, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const responses = [
			functionResponse("call-guessed-submit", "submit", {
				elementId: "fa-0-1",
				activationStrategy: "mouse",
			}),
			functionResponse("call-finish", "finish", {
				outcome: "failed",
				formUrl: null,
				reasonCode: "SUBMIT_ELEMENT_NOT_OBSERVED",
				reason: "The submit element was not observed.",
				retryable: false,
			}),
		];
		const driver = new WorkerFakeBrowserDriver();
		driver.requireObservationForSubmit = true;
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			dryRun: false,
			fetcher: (async () => {
				const response = responses.shift();
				if (!response) throw new Error("Unexpected provider request");
				return Response.json(response);
			}) as typeof fetch,
			createBrowserDriver: async () => driver,
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "SUBMIT_ELEMENT_NOT_OBSERVED",
		});
		expect(driver.validateSubmitCount).toBe(0);
		expect(driver.submitCount).toBe(0);
	});

	test.each([408, 409])(
		"retries transient provider status %i",
		async (status) => {
			const store = new D1JobStore(env.DB);
			await store.create(input, "2026-08-28T00:00:00.000Z");
			const job = await store.claimRun(
				input.id,
				"run-token-1",
				"2026-08-28T00:00:01.000Z",
			);
			if (!job) throw new Error("Expected a claimed job");
			const executor = new ResponsesAgentExecutor({
				db: env.DB,
				model: "gpt-5.6-luna",
				openAiApiKey: "openai-secret",
				browserUseApiKey: "browser-secret",
				fetcher: (async () => new Response(null, { status })) as typeof fetch,
				createBrowserDriver: async () => new WorkerFakeBrowserDriver(),
			});

			const error = await executor
				.execute(
					{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
					new AbortController().signal,
				)
				.catch((caught) => caught);

			expect(error).toBeInstanceOf(AgentExecutionError);
			expect(error.reasonCode).toBe("PROVIDER_REQUEST_REJECTED");
			expect(error.retryable).toBe(true);
		},
	);

	test("retries infrastructure failures instead of asking the model to classify them", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async () =>
				Response.json(
					functionResponse("call-observe", "observe", {}),
				)) as typeof fetch,
			createBrowserDriver: async () => {
				throw new Error("BrowserUse is temporarily unavailable");
			},
		});

		const error = await executor
			.execute(
				{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
				new AbortController().signal,
			)
			.catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("BROWSER_TOOL_UNAVAILABLE");
		expect(error.retryable).toBe(true);
		expect(await readAgentToolDiagnostics(input.id)).toEqual([
			{
				turn: 1,
				toolName: "observe",
				stage: "driver_connect",
				resultCode: "UNKNOWN",
			},
		]);
	});

	test("does not retry a browser document that exceeds the safe Worker cap", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async () =>
				Response.json(
					functionResponse("call-observe", "observe", {}),
				)) as typeof fetch,
			createBrowserDriver: async () => {
				throw new BrowserUseCdpPayloadTooLargeError();
			},
		});

		const error = await executor
			.execute(
				{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
				new AbortController().signal,
			)
			.catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("BROWSER_PAYLOAD_TOO_LARGE");
		expect(error.retryable).toBe(false);
		expect(await readAgentToolDiagnostics(input.id)).toEqual([
			{
				turn: 1,
				toolName: "observe",
				stage: "driver_connect",
				resultCode: "PAYLOAD_TOO_LARGE",
			},
		]);
	});

	test("waits for an active browser operation to stop after abort", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		let markObserveStarted: (() => void) | undefined;
		let releaseObserve: (() => void) | undefined;
		const observeStarted = new Promise<void>((resolve) => {
			markObserveStarted = resolve;
		});
		const driver = new WorkerFakeBrowserDriver();
		driver.observe = async () => {
			markObserveStarted?.();
			await new Promise<void>((resolve) => {
				releaseObserve = resolve;
			});
			return { url: driver.url, forms: [] };
		};
		driver.close = async () => {
			driver.closed = true;
			releaseObserve?.();
		};
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async () =>
				Response.json(
					functionResponse("call-observe", "observe", {}),
				)) as typeof fetch,
			createBrowserDriver: async () => driver,
		});
		const controller = new AbortController();
		const execution = executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			controller.signal,
		);
		await observeStarted;

		controller.abort();
		const error = await execution.catch((caught) => caught);

		expect(error).toBeInstanceOf(AgentExecutionError);
		expect(error.reasonCode).toBe("AGENT_TIMEOUT");
		expect(driver.closed).toBe(true);
		expect(executor.terminationGraceMs).toBe(30_000);
	});

	test("runs strict sequential Responses tools and finishes without submitting", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");

		const requests: Array<{ url: string; headers: Headers; body: unknown }> =
			[];
		const responses = [
			functionResponse("call-observe", "observe", {}),
			functionResponse("call-finish", "finish", {
				outcome: "prohibited",
				formUrl: input.targetUrl,
				reasonCode: "NO_FORM_PRESENT",
				reason: "No inquiry form is present.",
				retryable: null,
			}),
		];
		const fetcher = async function (
			this: unknown,
			resource: RequestInfo | URL,
			init?: RequestInit,
		) {
			expect(this).toBeUndefined();
			requests.push({
				url: String(resource),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			const response = responses.shift();
			if (!response) throw new Error("Unexpected provider request");
			return Response.json(response);
		} as typeof fetch;
		const driver = new WorkerFakeBrowserDriver();
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher,
			createBrowserDriver: async (apiKey) => {
				expect(apiKey).toBe("browser-secret");
				return driver;
			},
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toEqual({
			outcome: "prohibited",
			formUrl: input.targetUrl,
			reasonCode: "NO_FORM_PRESENT",
			reason: "No inquiry form is present.",
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer openai-secret",
		);
		expect(requests[0]?.body).toMatchObject({
			model: "gpt-5.6-luna",
			tool_choice: "required",
			parallel_tool_calls: false,
			max_output_tokens: 4_096,
			store: false,
		});
		expect(JSON.stringify(requests[0]?.body)).not.toContain("run-token-1");
		expect(requests[1]?.body).toMatchObject({
			input: expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call-observe",
				}),
			]),
		});
		const counter = await env.DB.prepare(
			"SELECT provider_request_count FROM jobs WHERE id = ?",
		)
			.bind(input.id)
			.first<{ provider_request_count: number }>();
		expect(counter?.provider_request_count).toBe(2);
		expect(driver.closed).toBe(true);
	});

	test("lets the model recover when click is used for a submit control", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const responses = [
			functionResponse("call-click", "click", { elementId: "fa-0-1" }),
			functionResponse("call-finish", "finish", {
				outcome: "failed",
				formUrl: null,
				reasonCode: "CORRECTED_TOOL_SELECTION",
				reason: "The submit control requires the submit tool.",
				retryable: false,
			}),
		];
		const requests: unknown[] = [];
		const driver = new WorkerFakeBrowserDriver();
		driver.clickNonSubmit = async () => {
			throw new BrowserElementError();
		};
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async (_resource, init) => {
				requests.push(JSON.parse(String(init?.body)));
				const response = responses.shift();
				if (!response) throw new Error("Unexpected provider request");
				return Response.json(response);
			}) as typeof fetch,
			createBrowserDriver: async () => driver,
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "CORRECTED_TOOL_SELECTION",
		});
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({
			input: expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call-click",
					output: JSON.stringify({ error: "INVALID_TOOL_INPUT" }),
				}),
			]),
		});
	});

	test("reports sent only from the restricted browser persisted result", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const driver = new WorkerFakeBrowserDriver();
		const responses = [
			functionResponse("call-fill", "fill", {
				elementId: "fa-0-0",
				payloadKey: "message",
			}),
			functionResponse("call-submit", "submit", {
				elementId: "fa-0-1",
				activationStrategy: "mouse",
			}),
		];
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async () => {
				const response = responses.shift();
				if (!response) throw new Error("Unexpected provider request");
				return Response.json(response);
			}) as typeof fetch,
			createBrowserDriver: async () => driver,
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toEqual({ outcome: "sent", formUrl: input.targetUrl });
		expect((await store.find(input.id))?.status).toBe("sent");
		expect(driver.closed).toBe(true);
		expect(await readAgentToolDiagnostics(input.id)).toEqual([
			{
				turn: 1,
				toolName: "fill",
				stage: "fill",
				resultCode: "OK",
			},
			{
				turn: 2,
				toolName: "submit",
				stage: "submit",
				resultCode: "OK",
			},
		]);
	});

	test("records a fixed diagnostic when a real submit result is uncertain", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const driver = new WorkerFakeBrowserDriver();
		driver.submit = async () => {
			throw new Error("arbitrary browser detail");
		};
		const responses = [
			functionResponse("call-fill", "fill", {
				elementId: "fa-0-0",
				payloadKey: "message",
			}),
			functionResponse("call-submit", "submit", {
				elementId: "fa-0-1",
				activationStrategy: "mouse",
			}),
		];
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async () => {
				const response = responses.shift();
				if (!response) throw new Error("Unexpected provider request");
				return Response.json(response);
			}) as typeof fetch,
			createBrowserDriver: async () => driver,
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toMatchObject({ outcome: "uncertain" });
		expect((await store.find(input.id))?.status).toBe("uncertain");
		const diagnostics = await readAgentToolDiagnostics(input.id);
		expect(diagnostics).toEqual([
			{
				turn: 1,
				toolName: "fill",
				stage: "fill",
				resultCode: "OK",
			},
			{
				turn: 2,
				toolName: "submit",
				stage: "submit",
				resultCode: "SUBMISSION_RESULT_UNCERTAIN",
			},
		]);
		expect(JSON.stringify(diagnostics)).not.toContain(
			"arbitrary browser detail",
		);
	});

	test("rejects a finish result containing a form URL outside the target domain", async () => {
		const store = new D1JobStore(env.DB);
		await store.create(input, "2026-08-28T00:00:00.000Z");
		const job = await store.claimRun(
			input.id,
			"run-token-1",
			"2026-08-28T00:00:01.000Z",
		);
		if (!job) throw new Error("Expected a claimed job");
		const responses = [
			functionResponse("call-invalid", "finish", {
				outcome: "prohibited",
				formUrl: "https://evil.test/contact",
				reasonCode: "NO_FORM_PRESENT",
				reason: "No inquiry form is present.",
				retryable: null,
			}),
			functionResponse("call-valid", "finish", {
				outcome: "prohibited",
				formUrl: input.targetUrl,
				reasonCode: "NO_FORM_PRESENT",
				reason: "No inquiry form is present.",
				retryable: null,
			}),
		];
		const requests: unknown[] = [];
		const executor = new ResponsesAgentExecutor({
			db: env.DB,
			model: "gpt-5.6-luna",
			openAiApiKey: "openai-secret",
			browserUseApiKey: "browser-secret",
			fetcher: (async (_resource, init) => {
				requests.push(JSON.parse(String(init?.body)));
				const response = responses.shift();
				if (!response) throw new Error("Unexpected provider request");
				return Response.json(response);
			}) as typeof fetch,
			createBrowserDriver: async () => new WorkerFakeBrowserDriver(),
		});

		const result = await executor.execute(
			{ job, runToken: "run-token-1", maxDurationMs: 60_000 },
			new AbortController().signal,
		);

		expect(result).toMatchObject({
			outcome: "prohibited",
			formUrl: input.targetUrl,
		});
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({
			input: expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call-invalid",
					output: JSON.stringify({ error: "INVALID_TOOL_INPUT" }),
				}),
			]),
		});
		expect(await readAgentToolDiagnostics(input.id)).toEqual([
			{
				turn: 1,
				toolName: "finish",
				stage: "finish_validation",
				resultCode: "FINISH_FORM_URL_NOT_ALLOWED",
			},
			{
				turn: 2,
				toolName: "finish",
				stage: "finish_validation",
				resultCode: "OK",
			},
		]);
	});
});

async function readAgentToolDiagnostics(
	jobId: string,
): Promise<Array<Record<string, unknown>>> {
	const { results } = await env.DB.prepare(
		"SELECT data_json FROM events WHERE job_id = ? AND type = 'agent.tool_diagnostic' ORDER BY CAST(json_extract(data_json, '$.turn') AS INTEGER)",
	)
		.bind(jobId)
		.all<{ data_json: string }>();
	return results.map((row) => JSON.parse(row.data_json));
}

function functionResponse(
	callId: string,
	name: string,
	parameters: Record<string, unknown>,
) {
	return {
		status: "completed",
		output: [
			{
				type: "function_call",
				call_id: callId,
				name,
				arguments: JSON.stringify(parameters),
			},
		],
	};
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
		const event = await env.DB.prepare(
			"SELECT attempt, type, data_json, created_at FROM events WHERE job_id = ?",
		)
			.bind(input.id)
			.first<{
				attempt: number;
				type: string;
				data_json: string;
				created_at: string;
			}>();

		expect(result.explicitAcks).toEqual([]);
		expect(result.retryMessages).toHaveLength(1);
		expect(persisted?.status).toBe("running");
		expect(persisted?.runToken).toBe("message-1");
		expect(event?.attempt).toBe(1);
		expect(event?.type).toBe("job.retry_scheduled");
		expect(event?.created_at).toBeTruthy();
		expect(JSON.parse(event?.data_json ?? "{}")).toMatchObject({
			reasonCode: "PROVIDER_RATE_LIMITED",
			source: "result",
			durationMs: expect.any(Number),
			providerRequestCount: 0,
		});
	});

	test("stops a retryable failure at a job-specific attempt limit", async () => {
		const limitedInput = {
			...input,
			payload: { ...input.payload, _formAgentMaxAttempts: 1 },
		};
		const store = new D1JobStore(env.DB);
		await store.create(limitedInput, "2026-08-28T00:00:00.000Z");
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:01.000Z"),
				body: { jobId: limitedInput.id },
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
		const persisted = await store.find(limitedInput.id);

		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("failed");
		expect(persisted?.attemptCount).toBe(1);
		expect(persisted?.result?.reasonCode).toBe("PROVIDER_RATE_LIMITED");
	});

	test("does not call the agent after a limited job is redelivered", async () => {
		const limitedInput = {
			...input,
			payload: { ...input.payload, _formAgentMaxAttempts: 1 },
		};
		const store = new D1JobStore(env.DB);
		await store.create(limitedInput, "2026-08-28T00:00:00.000Z");
		await store.claimRun(
			limitedInput.id,
			"message-1",
			"2026-08-28T00:00:01.000Z",
		);
		await store.recordRunAttempt(
			limitedInput.id,
			"message-1",
			1,
			"2026-08-28T00:00:01.000Z",
		);
		const batch = createMessageBatch<JobMessage>("form-agent-jobs", [
			{
				id: "message-1",
				timestamp: new Date("2026-08-28T00:00:02.000Z"),
				body: { jobId: limitedInput.id },
				attempts: 2,
			},
		]);
		const ctx = createExecutionContext();
		let executions = 0;
		const executor: AgentExecutor = {
			async execute() {
				executions += 1;
				return {
					outcome: "failed",
					reasonCode: "SHOULD_NOT_RUN",
					reason: "The agent should not run.",
					retryable: false,
				};
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const persisted = await store.find(limitedInput.id);

		expect(executions).toBe(0);
		expect(result.explicitAcks).toEqual(["message-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(persisted?.status).toBe("failed");
		expect(persisted?.attemptCount).toBe(2);
		expect(persisted?.result?.reasonCode).toBe("JOB_ATTEMPT_LIMIT_REACHED");
	});

	test("persists the reason for a retryable agent exception", async () => {
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
				throw new AgentExecutionError(
					"BROWSER_TOOL_UNAVAILABLE",
					"The browser tool became unavailable.",
					true,
				);
			},
		};

		await consumeJobBatch(batch, env, executor);
		const result = await getQueueResult(batch, ctx);
		const event = await env.DB.prepare(
			"SELECT attempt, type, data_json FROM events WHERE job_id = ?",
		)
			.bind(input.id)
			.first<{ attempt: number; type: string; data_json: string }>();

		expect(result.retryMessages).toHaveLength(1);
		expect(event?.attempt).toBe(1);
		expect(event?.type).toBe("job.retry_scheduled");
		expect(JSON.parse(event?.data_json ?? "{}")).toMatchObject({
			reasonCode: "BROWSER_TOOL_UNAVAILABLE",
			source: "exception",
			durationMs: expect.any(Number),
			providerRequestCount: 0,
		});
	});

	test("persists a safe reason when the queue consumer schedules a retry", async () => {
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
		const recordProhibited = vi
			.spyOn(D1JobStore.prototype, "recordProhibited")
			.mockRejectedValueOnce(new Error("D1 write failed"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await consumeJobBatch(batch, env, executor);
		} finally {
			recordProhibited.mockRestore();
			warn.mockRestore();
		}
		const result = await getQueueResult(batch, ctx);
		const event = await env.DB.prepare(
			"SELECT attempt, type, data_json FROM events WHERE job_id = ?",
		)
			.bind(input.id)
			.first<{ attempt: number; type: string; data_json: string }>();

		expect(result.retryMessages).toHaveLength(1);
		expect(event?.attempt).toBe(1);
		expect(event?.type).toBe("job.retry_scheduled");
		expect(JSON.parse(event?.data_json ?? "{}")).toMatchObject({
			reasonCode: "QUEUE_CONSUMER_ERROR",
			source: "consumer",
			providerRequestCount: 0,
		});
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
