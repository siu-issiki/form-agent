import { D1JobStore } from "./d1-job-store";
import type { Job } from "./job";
import {
	type BrowserObservation,
	type RestrictedBrowserDriver,
	RestrictedBrowserTools,
	type SubmitActivationStrategy,
} from "./restricted-browser";

export type BrowserToolName =
	| "navigate"
	| "observe"
	| "click"
	| "fill"
	| "select"
	| "submit";

export type BrowserToolParams = Record<string, unknown>;

export type BrowserDriverFactory = (
	job: Job,
) => Promise<RestrictedBrowserDriver>;

export class BrowserToolInputError extends Error {}

export class BrowserToolCoordinator {
	#driver: RestrictedBrowserDriver | undefined;
	#tools: RestrictedBrowserTools | undefined;
	#scopeKey: string | undefined;
	#operationTail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(
		private readonly db: D1Database,
		private readonly createDriver: BrowserDriverFactory,
	) {}

	async execute(
		jobId: string,
		runToken: string,
		tool: BrowserToolName,
		params: BrowserToolParams,
	): Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }> {
		const operation = this.#operationTail.then(() =>
			this.#execute(jobId, runToken, tool, params),
		);
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async validateSubmit(
		jobId: string,
		runToken: string,
		params: BrowserToolParams,
	): Promise<void> {
		const operation = this.#operationTail.then(async () => {
			if (this.#closed) throw new BrowserToolInputError();
			const { tools } = await this.#getToolsAndJob(jobId, runToken);
			readSubmitActivationStrategy(params);
			await tools.validateSubmit(readElementId(params));
		});
		this.#operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async #execute(
		jobId: string,
		runToken: string,
		tool: BrowserToolName,
		params: BrowserToolParams,
	): Promise<{ result: unknown } | { job: Omit<Job, "runToken"> }> {
		if (this.#closed) {
			throw new BrowserToolInputError();
		}
		const { job, tools } = await this.#getToolsAndJob(jobId, runToken);
		switch (tool) {
			case "navigate":
				await tools.navigate(readString(params, "url", 2_048));
				return { result: { ok: true } };
			case "observe":
				return { result: await tools.observe() };
			case "click":
				await tools.click(readElementId(params));
				return { result: { ok: true } };
			case "fill":
				await tools.fill(
					readElementId(params),
					readPayloadValue(job, params, 8_192),
				);
				return { result: { ok: true } };
			case "select":
				await tools.select(
					readElementId(params),
					readPayloadValue(job, params, 2_048),
				);
				return { result: { ok: true } };
			case "submit": {
				const job = await tools.submit(
					readElementId(params),
					readSubmitActivationStrategy(params),
				);
				const { runToken: _, ...safeJob } = job;
				return { job: safeJob };
			}
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		const driver = this.#driver;
		this.#driver = undefined;
		this.#tools = undefined;
		this.#scopeKey = undefined;
		await driver?.close?.();
	}

	async #getToolsAndJob(
		jobId: string,
		runToken: string,
	): Promise<{ job: Job; tools: RestrictedBrowserTools }> {
		const scopeKey = `${jobId}\u0000${runToken}`;
		const store = new D1JobStore(this.db);
		const job = await store.find(jobId);
		if (job?.status !== "running" || job.runToken !== runToken) {
			throw new BrowserToolInputError();
		}
		if (this.#tools) {
			if (this.#scopeKey !== scopeKey) {
				throw new BrowserToolInputError();
			}
			return { job, tools: this.#tools };
		}

		const driver = await this.createDriver(job);
		try {
			const tools = await RestrictedBrowserTools.create(
				driver,
				store,
				jobId,
				runToken,
			);
			await tools.navigate(job.targetUrl);
			if (this.#closed) {
				throw new BrowserToolInputError();
			}
			this.#driver = driver;
			this.#tools = tools;
			this.#scopeKey = scopeKey;
			return { job, tools };
		} catch (error) {
			await driver.close?.().catch(() => undefined);
			throw error;
		}
	}
}

function readSubmitActivationStrategy(
	params: BrowserToolParams,
): SubmitActivationStrategy {
	const value = params.activationStrategy;
	if (value === "mouse" || value === "enter") return value;
	throw new BrowserToolInputError();
}

function readPayloadValue(
	job: Job,
	params: BrowserToolParams,
	maxLength: number,
): string {
	const payloadKey = readString(params, "payloadKey", 64);
	if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(payloadKey)) {
		throw new BrowserToolInputError();
	}
	const formValues = job.payload.formValues;
	if (!isRecord(formValues) || !Object.hasOwn(formValues, payloadKey)) {
		throw new BrowserToolInputError();
	}
	const value = formValues[payloadKey];
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength
	) {
		throw new BrowserToolInputError();
	}
	return value;
}

function readElementId(params: BrowserToolParams): string {
	const value = readString(params, "elementId", 64);
	if (!/^fa-[a-z0-9-]+$/.test(value)) {
		throw new BrowserToolInputError();
	}
	return value;
}

function readString(
	params: BrowserToolParams,
	key: string,
	maxLength: number,
	allowEmpty = false,
): string {
	const value = params[key];
	if (
		typeof value !== "string" ||
		(!allowEmpty && !value) ||
		value.length > maxLength
	) {
		throw new BrowserToolInputError();
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { BrowserObservation };
