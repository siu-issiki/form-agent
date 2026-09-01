export const TEST_FIXTURE_FORM_VALUES = {
	name: "実送信テスト",
	companyName: "Form Agent E2E",
	email: "no-reply@example.com",
	message: "これは管理下テストフォームへの実送信テストです。",
} as const;

export const TEST_FIXTURE_JOB_ID_PATTERN = /^agent-submit-e2e-[a-f0-9-]{36}$/;
