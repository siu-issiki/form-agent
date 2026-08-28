import { describe, expect, test } from "bun:test";
import { hasNewSubmissionConfirmation } from "../src/browser-submit-confirmation";

describe("BrowserUseCdpDriver submission confirmation", () => {
	test("accepts a confirmation that appears after submit", () => {
		expect(
			hasNewSubmissionConfirmation(
				"お問い合わせフォーム",
				"送信が完了しました。ありがとうございました。",
			),
		).toBe(true);
	});

	test("does not accept confirmation text that already existed", () => {
		expect(
			hasNewSubmissionConfirmation(
				"Thank you for visiting our website.",
				"Thank you for visiting our website.",
			),
		).toBe(false);
	});

	test("does not accept a negative submitted message", () => {
		expect(
			hasNewSubmissionConfirmation(
				"Contact form",
				"The form was not submitted. Please correct the errors.",
			),
		).toBe(false);
	});
});
