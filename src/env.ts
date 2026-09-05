/**
 * The Worker's bindings and the shape of a queued job message.
 *
 * They live in their own module because the HTTP entry point (`worker.ts`) and
 * the queue consumer (`queue-consumer.ts`) both need them while `worker.ts`
 * already imports the consumer's handler: keeping the contract here means the
 * two modules share it without importing each other.
 */

/** The only payload the job queue carries: everything else is read from D1. */
export interface JobMessage {
	jobId: string;
}

export interface Env {
	DB: D1Database;
	JOB_QUEUE: Queue<JobMessage>;
	EVIDENCE_BUCKET: R2Bucket;
	AGENT_EXECUTOR_ENABLED?: string;
	AGENT_MODEL?: string;
	AGENT_SUBMIT_REVIEW_MODEL?: string;
	AGENT_DRY_RUN?: string;
	OPENAI_API_KEY?: string;
	BROWSER_USE_API_KEY?: string;
	JOB_API_TOKEN?: string;
	/** Dashboard owner and Cloudflare Access application. Unset denies all access. */
	ADMIN_EMAIL?: string;
	ADMIN_ACCESS_ISSUER?: string;
	ADMIN_ACCESS_AUDIENCE?: string;
	/**
	 * Comma-separated registrable domains whose jobs skip the real-send guard.
	 * It exists for the managed test system only: those submissions are real by
	 * nature and have no dry-run to approve against. Unset or empty means no exemption. A customer domain must never be
	 * listed here -- anything on this list can be sent to with no human
	 * approval record at all.
	 */
	REAL_SEND_GUARD_EXEMPT_DOMAINS?: string;
}
