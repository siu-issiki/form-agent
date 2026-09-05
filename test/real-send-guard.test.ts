import { describe, expect, test } from "bun:test";
import type { Job, JobInput } from "../src/job";
import { EFFECTIVE_DRY_RUN_KEY } from "../src/job";
import {
	jobContentFingerprint,
	jobInputFingerprint,
} from "../src/job-fingerprint";
import {
	checkRealSendGuard,
	DRY_RUN_COMPLETE_REASON_CODE,
	type DryRunRecord,
	isCompletedDryRunFor,
	matchesDryRunContent,
	type RealSendGuardStore,
} from "../src/real-send-guard";
import {
	isSendApproval,
	REAL_SEND_GUARD_EXEMPT_KEY,
	SEND_APPROVAL_KEY,
} from "../src/send-approval";

const TARGET_URL = "https://example.com/contact";
const DRY_RUN_JOB_ID = "job-dry-001";
const APPROVAL = {
	approvedBy: "operator",
	approvedAt: "2026-09-04T00:00:00Z",
	dryRunJobId: DRY_RUN_JOB_ID,
};

class FakeStore implements RealSendGuardStore {
	readonly findCalls: string[] = [];

	constructor(private readonly record: DryRunRecord | null) {}

	async find(id: string): Promise<DryRunRecord | null> {
		this.findCalls.push(id);
		return this.record;
	}
}

function sendInput(overrides: Partial<JobInput> = {}): JobInput {
	return {
		id: "job-send-001",
		companyId: "company-001",
		companyName: "Example Inc.",
		targetUrl: TARGET_URL,
		targetDomain: "example.com",
		allowedHosts: [],
		payload: {
			formValues: { message: "Hello" },
			[EFFECTIVE_DRY_RUN_KEY]: false,
			[SEND_APPROVAL_KEY]: { ...APPROVAL },
		},
		...overrides,
	};
}

function dryRunRecord(overrides: Partial<DryRunRecord> = {}): DryRunRecord {
	return {
		targetUrl: TARGET_URL,
		companyId: "company-001",
		status: "prohibited",
		payload: {
			formValues: { message: "Hello" },
			[EFFECTIVE_DRY_RUN_KEY]: true,
		},
		result: { reasonCode: DRY_RUN_COMPLETE_REASON_CODE },
		...overrides,
	};
}

describe("checkRealSendGuard", () => {
	test("leaves a dry-run job alone without reading the store", async () => {
		const store = new FakeStore(null);
		const input = sendInput({
			payload: { formValues: {}, [EFFECTIVE_DRY_RUN_KEY]: true },
		});
		expect(await checkRealSendGuard(input, store)).toEqual({
			allowed: true,
		});
		expect(store.findCalls).toEqual([]);
	});

	test("lets a job the API stamped as exempt through without an approval", async () => {
		const store = new FakeStore(null);
		const input = sendInput({
			payload: {
				formValues: {},
				[EFFECTIVE_DRY_RUN_KEY]: false,
				[REAL_SEND_GUARD_EXEMPT_KEY]: true,
			},
		});
		expect(await checkRealSendGuard(input, store)).toEqual({
			allowed: true,
		});
	});

	test("refuses a real send with no approval record", async () => {
		const store = new FakeStore(dryRunRecord());
		const input = sendInput({
			payload: { formValues: {}, [EFFECTIVE_DRY_RUN_KEY]: false },
		});
		expect(await checkRealSendGuard(input, store)).toEqual({
			allowed: false,
			refusal: "SEND_APPROVAL_REQUIRED",
		});
		expect(store.findCalls).toEqual([]);
	});

	test("refuses a real send whose approval record is malformed", async () => {
		const store = new FakeStore(dryRunRecord());
		const input = sendInput({
			payload: {
				formValues: {},
				[EFFECTIVE_DRY_RUN_KEY]: false,
				[SEND_APPROVAL_KEY]: { ...APPROVAL, approvedBy: "" },
			},
		});
		expect(await checkRealSendGuard(input, store)).toEqual({
			allowed: false,
			refusal: "SEND_APPROVAL_REQUIRED",
		});
	});

	test("refuses a real send whose dry-run cannot be found", async () => {
		const store = new FakeStore(null);
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_NOT_COMPLETED",
		});
		expect(store.findCalls).toEqual([DRY_RUN_JOB_ID]);
	});

	test("refuses a dry-run that ran against a different form URL", async () => {
		const store = new FakeStore(
			dryRunRecord({ targetUrl: "https://example.com/other" }),
		);
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_NOT_COMPLETED",
		});
	});

	test("refuses an approval that names a real send", async () => {
		const store = new FakeStore(
			dryRunRecord({
				payload: {
					formValues: { message: "Hello" },
					[EFFECTIVE_DRY_RUN_KEY]: false,
				},
			}),
		);
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_NOT_COMPLETED",
		});
	});

	test("refuses a dry-run that did not stop at the dry-run boundary", async () => {
		const store = new FakeStore(dryRunRecord({ status: "failed" }));
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_NOT_COMPLETED",
		});
	});

	test("refuses a dry-run whose result carries another reason code", async () => {
		const store = new FakeStore(
			dryRunRecord({ result: { reasonCode: "FORM_PROHIBITED" } }),
		);
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_NOT_COMPLETED",
		});
	});

	test("refuses a send whose content differs from the reviewed dry-run", async () => {
		const store = new FakeStore(
			dryRunRecord({
				payload: {
					formValues: { message: "Something else" },
					[EFFECTIVE_DRY_RUN_KEY]: true,
				},
			}),
		);
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_CONTENT_MISMATCH",
		});
	});

	test("refuses a send whose company differs from the reviewed dry-run", async () => {
		const store = new FakeStore(dryRunRecord({ companyId: "company-002" }));
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: false,
			refusal: "DRY_RUN_CONTENT_MISMATCH",
		});
	});

	test("allows a real send whose content matches its approved dry-run", async () => {
		const store = new FakeStore(dryRunRecord());
		expect(await checkRealSendGuard(sendInput(), store)).toEqual({
			allowed: true,
		});
		expect(store.findCalls).toEqual([DRY_RUN_JOB_ID]);
	});
});

describe("isCompletedDryRunFor", () => {
	test("accepts a stored job read back over the API with no payload", () => {
		// `JobState` from the operator tool carries a nullable payload; a missing
		// one is not a real send, so it passes the same way the Worker's does.
		expect(
			isCompletedDryRunFor(dryRunRecord({ payload: null }), {
				targetUrl: TARGET_URL,
			}),
		).toBe(true);
	});

	test("accepts a Worker job record unchanged", () => {
		const job: Job = {
			...sendInput(),
			payload: { formValues: {}, [EFFECTIVE_DRY_RUN_KEY]: true },
			status: "prohibited",
			attemptCount: 1,
			submitReviewDenialCount: 0,
			runToken: null,
			result: {
				outcome: "prohibited",
				formUrl: TARGET_URL,
				reasonCode: DRY_RUN_COMPLETE_REASON_CODE,
				reason: null,
				completedAt: "2026-09-04T00:00:00.000Z",
			},
			createdAt: "2026-09-04T00:00:00.000Z",
			updatedAt: "2026-09-04T00:00:00.000Z",
		};
		expect(isCompletedDryRunFor(job, { targetUrl: TARGET_URL })).toBe(true);
	});

	test("rejects a null record and a result that is missing", () => {
		expect(isCompletedDryRunFor(null, { targetUrl: TARGET_URL })).toBe(false);
		expect(
			isCompletedDryRunFor(dryRunRecord({ result: null }), {
				targetUrl: TARGET_URL,
			}),
		).toBe(false);
	});
});

describe("matchesDryRunContent", () => {
	test("compares only the form URL, the company, and the form values", async () => {
		// The stored payload carries the frozen mode and the approval record, so
		// the whole payload cannot be compared.
		const input = sendInput();
		expect(await matchesDryRunContent(dryRunRecord(), input)).toBe(true);
	});

	test("treats a payload that is missing as carrying no form values", async () => {
		expect(
			await matchesDryRunContent(dryRunRecord({ payload: null }), {
				targetUrl: TARGET_URL,
				companyId: "company-001",
				payload: {},
			}),
		).toBe(true);
		expect(
			await matchesDryRunContent(dryRunRecord({ payload: null }), sendInput()),
		).toBe(false);
	});
});

describe("direct send approval", () => {
	async function approvedInput() {
		const input = sendInput();
		input.payload[SEND_APPROVAL_KEY] = {
			approvedBy: APPROVAL.approvedBy,
			approvedAt: APPROVAL.approvedAt,
			mode: "direct",
			contentFingerprint: await jobContentFingerprint(
				input.targetUrl,
				input.companyId,
				input.payload,
			),
		};
		return input;
	}
	test("allows frozen direct content without looking up a dry-run", async () => {
		const input = await approvedInput();
		const store = new FakeStore(null);
		expect(await checkRealSendGuard(input, store)).toEqual({ allowed: true });
		expect(store.findCalls).toEqual([]);
	});
	test.each(["message", "company", "url", "candidate order"])(
		"rejects changed %s after direct approval",
		async (field) => {
			const input = await approvedInput();
			if (field === "candidate order") {
				input.payload.formValues = {
					message: "Hello",
					category: ["first", "second"],
				};
				const fingerprint = await jobContentFingerprint(
					input.targetUrl,
					input.companyId,
					input.payload,
				);
				input.payload[SEND_APPROVAL_KEY] = {
					...(input.payload[SEND_APPROVAL_KEY] as object),
					contentFingerprint: fingerprint,
				};
				input.payload.formValues = {
					message: "Hello",
					category: ["second", "first"],
				};
			}
			if (field === "message")
				input.payload.formValues = { message: "changed" };
			if (field === "company") input.companyId = "other";
			if (field === "url") input.targetUrl = "https://example.com/other";
			expect(await checkRealSendGuard(input, new FakeStore(null))).toEqual({
				allowed: false,
				refusal: "SEND_APPROVAL_CONTENT_MISMATCH",
			});
		},
	);
	test("rejects malformed and ambiguous direct approval records", async () => {
		const input = await approvedInput();
		const approval = input.payload[SEND_APPROVAL_KEY] as Record<
			string,
			unknown
		>;
		expect(isSendApproval(approval)).toBe(true);
		for (const patch of [
			{ mode: undefined },
			{ contentFingerprint: "abc" },
			{ dryRunJobId: "dry-1" },
			{ approvedBy: "" },
			{ approvedAt: "today" },
			{ extra: true },
		]) {
			expect(isSendApproval({ ...approval, ...patch })).toBe(false);
		}
	});
	test("registration recovery compares the direct approval fingerprint", async () => {
		const input = await approvedInput();
		const first = await jobInputFingerprint(
			input.targetUrl,
			input.payload,
			true,
		);
		const changed = {
			...input.payload,
			[SEND_APPROVAL_KEY]: {
				...(input.payload[SEND_APPROVAL_KEY] as object),
				contentFingerprint: "f".repeat(64),
			},
		};
		expect(await jobInputFingerprint(input.targetUrl, changed, true)).not.toBe(
			first,
		);
	});
});
