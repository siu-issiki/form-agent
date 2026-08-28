export function hasNewSubmissionConfirmation(
	beforeText: string,
	afterText: string,
): boolean {
	const confirmation = /送信.{0,12}(完了|ありがとう)|thank\s*you|submitted/i;
	return !confirmation.test(beforeText) && confirmation.test(afterText);
}
