/**
 * Acknowledgements require inquiry/message context, paired sentences, or a
 * completion heading. A generic visit/interest "thank you" is not a receipt:
 * treating it as one also masks a later receipt in the same body.
 */
export const SUBMISSION_CONFIRMATION_PATTERN =
	"送信(?![前後](?:は|に|の)).{0,12}(完了|ありがとう)|(?:^|[\\r\\n])\\s*thank\\s+you\\s+for\\s+(?:your\\s+(?:inquiry|inquiries|message|submission)|contacting\\s+us)(?:,\\s*we\\s+will\\s+reply\\s+as\\s+soon\\s+as\\s+possible)?(?=[.!](?:\\s|$)|[\\r\\n]|$)|(?:^|[\\r\\n])\\s*thank\\s+you[!.]\\s+your\\s+message\\s+has\\s+been\\s+sent(?:\\s+successfully)?(?=[.!](?:\\s|$)|[\\r\\n]|$)|(?:メッセージは送信されました|お問い合わせを受け付けました)(?=[。.!！\\s]|$)|(?:^|[\\r\\n])\\s*ご連絡ありがとうございます。\\s*近いうちにご返信させていただきます。(?=\\s|$)|(?:^|[\\r\\n])\\s*お問い合わせありがとうございます。\\s*追ってご連絡させていただきます。(?=\\s|$)|(?:^|[\\r\\n])\\s*問い合わせ完了\\s+このたびはお問い合わせありがとうございました。(?=\\s|$)|(?:^|[\\r\\n])\\s*お問い合わせ[-・]?完了画面\\s+[^。\\r\\n「」]{1,80}へのお問い合わせをありがとうございました。\\s*担当者より折り返し連絡いたします。(?=\\s|$)|(?:^|[\\r\\n])\\s*ご要望を頂戴いたしました。\\s*ありがとうございました。(?=\\s|$)|(?:^|[\\r\\n])\\s*この度はお問い合わせをいただき、誠にありがとうございます。\\s*後ほど、担当者?よりメールまたはお電話にて折り返しいたします。(?=\\s|$)|(?:^|[\\r\\n])\\s*お問い合わせ頂き誠にありがとうございました。\\s*お問い合わせ内容を確認させていただき、後ほど担当者よりご回答をさせていただきます。(?=\\s|$)|(?:^|[\\r\\n])\\s*フォームを送信しました。(?=\\s|$)|(?:^|[\\r\\n])\\s*お問合せが完了いたしました。(?=\\s|$)" +
	"|(?:^|[\\r\\n])\\s*(?:お問い合わせ完了\\s+お問い合わせ受付完了|お問い合わせありがとうございます。\\s*(?:内容確認後、追ってご連絡させていただきます。|担当者から返信いたしますので、今しばらくお待ちください。)|お問い合わせが送信されました。|お問い合わせ完了\\s+お問い合わせ内容を送信いたしました。|この度は、お問合せ頂き誠にありがとうございました。\\s*担当の者より2～3日以内に御連絡差し上げます。)(?=\\s|$)";

/** Explicit non-completion is never waived as static guidance. */
export const SUBMISSION_INCOMPLETE_PATTERN =
	"完了(して|しており)?(い)?ません|完了していない|まだ送信|送信は(まだ|完了)";

/** Confirmation/review text is pending unless the reader verifies unchanged guidance after form removal. */
export const SUBMISSION_PENDING_PATTERN = `${SUBMISSION_INCOMPLETE_PATTERN}|入力内容(の|を)(ご)?確認|確認画面|この内容で送信|上記の内容で送信|内容をご確認`;

/** Explicit page failure, kept uncertain because the request may have reached the receiver. */
export const SUBMISSION_FAILURE_PATTERN =
	"送信に失敗しました|送信できませんでした|メッセージの送信に失敗しました|(?:^|[\\r\\n])\\s*1つ以上の項目にエラーがあります。\\s*確認してもう一度お試しください。(?=\\s|$)|(?:^|[\\r\\n])\\s*文字数が正しくありません。(?=\\s|$)|(?:^|[\\r\\n])[ \\t]*(?:SPAM BLOCK|Too Many Requests)[ \\t]*(?=[\\r\\n]|$)|(?:^|[\\r\\n])\\s*送信を受け付けられませんでした。(?=\\s|$)|(?:^|[\\r\\n])\\s*必須項目に記入もれがあります。\\s*入力内容に不備があります。確認してもう一度送信してください。(?=\\s|$)|(?:^|[\\r\\n])\\s*Service Temporarily Unavailable\\s+The server is temporarily unable to service your request due to maintenance downtime or capacity problems\\.\\s*Please try again later\\.(?=\\s|$)|(?:^|[\\r\\n])\\s*Invalid reCAPTCHA Secret key\\.(?=\\s|$)|(?:^|[\\r\\n])\\s*人間であることを確認してください。(?=\\s|$)" +
	"|(?:^|[\\r\\n])\\s*(?:Not Found\\s+The requested URL was not found on this server\\.|スパム防止のチェックを入れてください。|(?:カタカナで入力してください。\\s*)?入力内容に問題があります。\\s*確認して再度お試しください。|スパム送信の可能性があります。|認証に失敗しました。\\s*お手数ですが、もう一度お試しください。)(?=\\s|$)";
