export const SUBMISSION_CONFIRMATION_PATTERN =
	"送信.{0,12}(完了|ありがとう)|thank\\s*you";

/**
 * Text that marks a page as a confirmation step rather than a completed send:
 * a negated completion ("完了していません"), an explicit "not yet", or the
 * headings and buttons of a review-before-send screen. A page that matches
 * this is never read as a completion, whatever else it says.
 */
export const SUBMISSION_PENDING_PATTERN =
	"完了(して|しており)?(い)?ません|完了していない|まだ送信|送信は(まだ|完了)|入力内容(の|を)(ご)?確認|確認画面|この内容で送信|上記の内容で送信|内容をご確認";
