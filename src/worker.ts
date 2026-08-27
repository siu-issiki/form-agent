import { D1JobStore } from "./d1-job-store";
import { DuplicateJobError, type Job, type JobInput } from "./job";

export interface JobMessage {
	jobId: string;
}

export interface Env {
	DB: D1Database;
	JOB_QUEUE: Queue<JobMessage>;
}

export interface RegisterJobResult {
	created: boolean;
	job: Job;
}

interface JobQueue {
	send(message: JobMessage): Promise<unknown>;
}

const DEAD_LETTER_QUEUE = "form-agent-jobs-dlq";

export async function registerJob(
	db: D1Database,
	queue: JobQueue,
	input: JobInput,
	now: string,
): Promise<RegisterJobResult> {
	const store = new D1JobStore(db);
	let created = true;
	let job: Job;

	try {
		job = await store.create(input, now);
	} catch (error) {
		if (!(error instanceof DuplicateJobError)) {
			throw error;
		}

		created = false;
		const existing = await store.find(input.id);
		if (!existing) {
			throw new Error(`Duplicate job could not be loaded: ${input.id}`);
		}
		job = existing;
	}

	if (job.status === "pending") {
		await queue.send({ jobId: job.id });
	}

	return { created, job };
}

const worker: ExportedHandler<Env, JobMessage> = {
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}
		return new Response("Not Found", { status: 404 });
	},

	async queue(batch, env) {
		const store = new D1JobStore(env.DB);

		for (const message of batch.messages) {
			if (!isJobMessage(message.body)) {
				message.ack();
				continue;
			}

			try {
				const now = new Date().toISOString();
				if (batch.queue === DEAD_LETTER_QUEUE) {
					await store.markDeadLettered(
						message.body.jobId,
						"QUEUE_RETRY_EXHAUSTED",
						now,
					);
					message.ack();
					continue;
				}

				const runToken = message.id;
				const claimed = await store.claimRun(message.body.jobId, runToken, now);
				const job = claimed ?? (await store.find(message.body.jobId));

				if (job?.status !== "running" || job.runToken !== runToken) {
					message.ack();
					continue;
				}

				await store.recordFailed(
					job.id,
					runToken,
					"EXECUTOR_NOT_CONFIGURED",
					"The browser executor has not been configured yet.",
					now,
				);
				message.ack();
			} catch {
				message.retry({ delaySeconds: 30 });
			}
		}
	},
};

export default worker;

function isJobMessage(value: unknown): value is JobMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"jobId" in value &&
		typeof value.jobId === "string" &&
		value.jobId.length > 0
	);
}
