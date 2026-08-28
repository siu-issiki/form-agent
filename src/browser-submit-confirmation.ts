export const SUBMISSION_CONFIRMATION_PATTERN =
	"送信.{0,12}(完了|ありがとう)|thank\\s*you";

export function hasNewSubmissionConfirmation(
	beforeText: string,
	afterText: string,
): boolean {
	const confirmation = new RegExp(SUBMISSION_CONFIRMATION_PATTERN, "i");
	return !confirmation.test(beforeText) && confirmation.test(afterText);
}
