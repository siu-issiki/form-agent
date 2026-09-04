import type { BrowserObservation } from "./restricted-browser";

export type ProhibitedReasonCode =
	| "NO_FORM_PRESENT"
	| "SALES_PROHIBITED"
	| "FORM_PURPOSE_INCOMPATIBLE";

/** How a prohibition claim was verified, or why the quote was refused. */
export type ProhibitionEvidenceOutcome =
	| "PROHIBITION_EVIDENCE_VERIFIED"
	| "PROHIBITION_EVIDENCE_NOT_FOUND"
	| "PROHIBITION_EVIDENCE_WEAK";

/** How `validateProhibited` accepted the claim. */
export type ProhibitionVerification =
	| "REASON_CODES"
	| "PROHIBITION_EVIDENCE_VERIFIED";

export function detectProhibitedReasonCodes(
	observation: Pick<BrowserObservation, "forms" | "pageText">,
): ProhibitedReasonCode[] {
	const codes: ProhibitedReasonCode[] = [];
	if (observation.forms.length === 0) return ["NO_FORM_PRESENT"];
	const pageCodes = detectProhibitedTextReasonCodes(observation.pageText ?? "");
	if (observation.forms.every(hasTrustedFormProhibitionMetadata)) {
		const formCodes = observation.forms.map(readProhibitedReasonCodes);
		if (formCodes.every((formCode) => formCode.length > 0)) {
			for (const formCode of formCodes) {
				for (const code of formCode) {
					if (!codes.includes(code)) codes.push(code);
				}
			}
		}
	} else {
		for (const code of pageCodes) {
			if (!codes.includes(code)) codes.push(code);
		}
	}
	// A sales prohibition applies to the whole page, so the page text is
	// consulted for it even when every form carries trusted metadata. The notice
	// is often a site-wide line far from the form, out of reach of the
	// form-local text the page function collects. `FORM_PURPOSE_INCOMPATIBLE`
	// stays form-local because it describes who one specific form serves.
	if (
		pageCodes.includes("SALES_PROHIBITED") &&
		!codes.includes("SALES_PROHIBITED")
	) {
		codes.push("SALES_PROHIBITED");
	}
	return codes;
}

/**
 * Purpose words that mark a form as serving a specific audience instead of a
 * general inquiry. They are matched only next to a limiting expression or on
 * their own inside a heading, because each word also appears in ordinary
 * navigation on a general contact page.
 */
const FORM_PURPOSE_WORDS =
	"採用|求人|エントリー|応募|新卒|中途|アルバイト|インターン|予約|資料請求|お見積り|お見積|見積|会員|ログイン|マイページ|サポート|不具合|修理受付|報道|取材|サンプル";

/** Words that turn a purpose word into a restriction on who may use the form. */
const FORM_PURPOSE_LIMITERS = "専用|のみ|限定|に限ります|に限らせて";

/**
 * 「以外」 alone usually introduces a general inquiry form rather than excluding
 * one ("採用以外のお問い合わせはこちら"), so it counts as a restriction only when
 * a refusal follows it closely.
 */
const FORM_PURPOSE_REFUSALS =
	"受け付けて(?:おりません|いません|ません)|受け付けません|受付(?:して)?(?:おりません|いません|ません)|お断り|ご遠慮|承って(?:おりません|いません|ません)|承りません|承れません|(?:いた|致)?しかねます|かねます|対象外|対応して(?:おりません|いません)|お受けして(?:おりません|いません)|ご利用(?:いただけません|になれません)|できません";

/**
 * Generic connectors allowed between a purpose word and a limiter. Requiring
 * one of these keeps "ご予約はお電話のみ" from reading as a purpose restriction
 * while still matching "採用に関するお問い合わせ専用".
 */
const FORM_PURPOSE_CONNECTORS =
	"(?:に関する|に関して|についての|について|関連|向け|の)?(?:お問い?合わ?せ|問い?合わ?せ|ご相談|相談|ご依頼|依頼|受付|窓口|フォーム|ページ|申込み?|申し込み)?(?:の)?";

/** Filler a heading may contain around a purpose word and nothing else. */
const FORM_PURPOSE_HEADING_FILLER =
	"[\\s|｜/／・\\-‐−–—:：、。]|に関する|に関して|についての|について|関連|向け|専用|の|ご|お問い?合わ?せ|問い?合わ?せ|ご?相談|ご?依頼|受付|窓口|フォーム|ページ|情報|エントリー|応募|申込み?|申し込み|入力|送信|はこちら|専門";

/**
 * Words naming an unsolicited sales approach. Bare 「営業」 also sits inside
 * ordinary business vocabulary ("営業時間", "営業利益", "自営業"), so it is
 * guarded on both sides: a negative lookbehind for 「自営業」 and a negative
 * lookahead for the common compounds that describe a company's own operations.
 * The sales compounds are listed ahead of the bare word so they keep matching
 * whatever the lookahead grows to exclude. The exclusions lean towards missing
 * a prohibition rather than inventing one, because a miss is recovered by the
 * quoted-evidence path in `validateProhibited` while a false positive silently
 * drops a legitimate inquiry.
 */
const SALES_SUBJECTS =
	"営業(?:を|の)?目的(?:と)?|営業活動|営業メール|営業(?:の)?ご?提案|勧誘目的|(?<!自)営業(?!時間|日|所|中|カレンダー|マン|職|エリア|拠点|センター|本部|時|日程|利益|成績|年度|許可|秘密|報告|力|会議|実績|収益|外|停止|終了|再開|開始|活動報告)|勧誘|セールス|売り込み|売込み|sales|solicitation";

/**
 * Ways a page refuses something. Softened refusals ("お控えください",
 * "ご遠慮ください") carry the same meaning as an outright ban and appear far
 * more often on Japanese contact pages.
 */
const SALES_REFUSALS =
	"禁止|お断り|受け付け(?:て)?(?:おりません|いません|ません|ない)|ご遠慮|お?控え(?:ください|下さい|いただ|頂)|控えて|一切お断り|固くお断り|お断りして|お断りいたし|お断り致し|受け付けかね|対応(?:いた|致)しかね|(?:いた|致)?しかねます|かねます|対象外|ご対応(?:でき|出来)ません|返信(?:いた|致)しません|返答(?:いた|致)しません";

export const PROHIBITION_TEXT_PATTERN_SOURCES = {
	explicitAllowances: [
		"(営業|勧誘|セールス).{0,40}(も|を)?受け付け(?:て)?(?:います|ております)",
		"(営業|勧誘|セールス).{0,40}禁止して(?:い|おり)?ません",
		"(sales|solicitation).{0,40}(?:is|are) not prohibited",
	],
	salesProhibited: [
		`(?:${SALES_SUBJECTS}).{0,40}(?:${SALES_REFUSALS})`,
		`(?:${SALES_REFUSALS}).{0,40}(?:${SALES_SUBJECTS})`,
		"(sales|solicitation).{0,40}(prohibited|not accepted|do not use)",
	],
	formPurposeIncompatible: [
		`(?:${FORM_PURPOSE_WORDS})${FORM_PURPOSE_CONNECTORS}(?:${FORM_PURPOSE_LIMITERS})`,
		// The reverse order ("専用の採用窓口") takes only the limiters that cannot
		// attach to something else in between; "のみ" in this position matched
		// unrelated sentences such as "お電話のみのご予約".
		`(?:専用|限定)(?:の|は|:|：)?(?:${FORM_PURPOSE_WORDS})`,
		`(?:${FORM_PURPOSE_WORDS})${FORM_PURPOSE_CONNECTORS}以外(?:は|の).{0,20}(?:${FORM_PURPOSE_REFUSALS})`,
	],
	/**
	 * Matched only against a heading, legend, or document title whose whole text
	 * is a purpose word plus generic filler. A heading naming a company or any
	 * other extra word is left alone.
	 */
	formPurposeHeading: [
		`^[\\s|｜/／・\\-‐−–—]*[ごお]?(?:${FORM_PURPOSE_WORDS})(?:${FORM_PURPOSE_HEADING_FILLER})*$`,
	],
} as const;

export function detectProhibitedTextReasonCodes(
	rawText: string,
): ProhibitedReasonCode[] {
	const codes: ProhibitedReasonCode[] = [];
	const text = rawText.replace(/\s+/g, " ").toLowerCase();
	const withoutExplicitAllowances =
		PROHIBITION_TEXT_PATTERN_SOURCES.explicitAllowances.reduce(
			(value, source) => value.replace(new RegExp(source, "g"), " "),
			text,
		);
	if (
		PROHIBITION_TEXT_PATTERN_SOURCES.salesProhibited.some((source) =>
			new RegExp(source).test(withoutExplicitAllowances),
		)
	) {
		codes.push("SALES_PROHIBITED");
	}
	if (
		PROHIBITION_TEXT_PATTERN_SOURCES.formPurposeIncompatible.some((source) =>
			new RegExp(source).test(text),
		)
	) {
		codes.push("FORM_PURPOSE_INCOMPATIBLE");
	}
	return codes;
}

/** Shortest and longest quote the evidence check will consider. */
export const MIN_PROHIBITION_EVIDENCE_LENGTH = 8;
export const MAX_PROHIBITION_EVIDENCE_LENGTH = 300;

/**
 * Refusals a quoted sentence may carry. Only negative forms count: the stems
 * 「受け付け」「受付」「対応」「承って」 also open the acceptance a page states
 * ("営業のご提案も受け付けております"), which would turn an invitation into a
 * prohibition.
 */
const EVIDENCE_REFUSALS =
	/受け付けて(?:おりません|いません|ません)|受け付けません|受付(?:して)?(?:おりません|いません|ません)|お断り|ご遠慮|遠慮ください|禁止|お控え|控えて|承って(?:おりません|いません|ません)|承りません|対応(?:して)?(?:おりません|いません)|(?:いた|致)?しかねます|かねます|対象外|できません|しません|not accepted|prohibited|do not|refrain|decline/;

/**
 * Words a quoted sentence must contain for each reason code. They are looser
 * than the detection patterns because the sentence itself is already proven to
 * exist on the page; the check only rules out a quote that names something else
 * entirely, such as a heading about the sales department.
 */
const PROHIBITION_EVIDENCE_VOCABULARY: Record<
	Exclude<ProhibitedReasonCode, "NO_FORM_PRESENT">,
	readonly [RegExp, RegExp]
> = {
	SALES_PROHIBITED: [
		/営業|勧誘|セールス|売り込み|売込み|sales|solicitation|ソリシテーション/,
		EVIDENCE_REFUSALS,
	],
	FORM_PURPOSE_INCOMPATIBLE: [
		new RegExp(FORM_PURPOSE_WORDS),
		// 「以外」 on its own introduces a general inquiry form as often as it
		// excludes one, so it counts only through the refusal that follows it.
		new RegExp(`専用|のみ|限定|に限|${EVIDENCE_REFUSALS.source}`),
	],
};

/**
 * Normalizes a page or a quote for comparison. NFKC folds the full-width forms
 * a page may use, and collapsing runs of whitespace absorbs the line breaks and
 * ideographic spaces that layout adds between the words of one sentence.
 */
function normalizeForEvidence(value: string): string {
	return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Returns how a quoted prohibition sentence fared against the page text, or
 * null when there is no quote to check. `NO_FORM_PRESENT` is a structural claim
 * about the page rather than a statement on it, so no quote can support it.
 */
export function checkProhibitionEvidence(
	reasonCode: ProhibitedReasonCode,
	evidence: string | null | undefined,
	pageText: string | undefined,
): ProhibitionEvidenceOutcome | null {
	if (reasonCode === "NO_FORM_PRESENT") return null;
	if (typeof evidence !== "string") return null;
	const quote = normalizeForEvidence(evidence);
	if (
		quote.length < MIN_PROHIBITION_EVIDENCE_LENGTH ||
		evidence.length > MAX_PROHIBITION_EVIDENCE_LENGTH
	) {
		return "PROHIBITION_EVIDENCE_NOT_FOUND";
	}
	if (!normalizeForEvidence(pageText ?? "").includes(quote)) {
		return "PROHIBITION_EVIDENCE_NOT_FOUND";
	}
	// A sentence that states the opposite is refused outright, so a quote such
	// as "営業のご提案も受け付けております" cannot be read as a prohibition.
	if (
		PROHIBITION_TEXT_PATTERN_SOURCES.explicitAllowances.some((source) =>
			new RegExp(source).test(quote),
		)
	) {
		return "PROHIBITION_EVIDENCE_WEAK";
	}
	const [subject, refusal] = PROHIBITION_EVIDENCE_VOCABULARY[reasonCode];
	return subject.test(quote) && refusal.test(quote)
		? "PROHIBITION_EVIDENCE_VERIFIED"
		: "PROHIBITION_EVIDENCE_WEAK";
}

/** Fixed outcome only: the quote itself never reaches the log. */
export function logProhibitionEvidence(
	outcome: ProhibitionEvidenceOutcome,
): void {
	console.log(
		JSON.stringify({ event: "browser_prohibition_evidence", outcome }),
	);
}

function hasTrustedFormProhibitionMetadata(form: unknown): boolean {
	return isRecord(form) && Array.isArray(form.prohibitedReasonCodes);
}

export function readProhibitedReasonCodes(
	form: unknown,
): ProhibitedReasonCode[] {
	if (!isRecord(form) || !Array.isArray(form.prohibitedReasonCodes)) return [];
	return form.prohibitedReasonCodes.filter(isProhibitedReasonCode);
}

export function isProhibitedReasonCode(
	value: unknown,
): value is ProhibitedReasonCode {
	return (
		value === "NO_FORM_PRESENT" ||
		value === "SALES_PROHIBITED" ||
		value === "FORM_PURPOSE_INCOMPATIBLE"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
