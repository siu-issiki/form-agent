import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
	SELECT_OPTION_BY_CANDIDATE_FUNCTION,
	SELECT_RADIO_BY_CANDIDATE_FUNCTION,
} from "../src/browser-use-cdp-page-scripts";
import { isTrustedCandidateList } from "../src/restricted-browser";

const profile = JSON.parse(
	readFileSync(
		new URL(
			"../docs/examples/campaign-choices.general-outreach.example.json",
			import.meta.url,
		),
		"utf8",
	),
) as Record<string, string[]>;
const legacy = JSON.parse(
	readFileSync(
		new URL("../docs/examples/campaign-choices.example.json", import.meta.url),
		"utf8",
	),
) as Record<string, string[]>;
const select = runInNewContext(`(${SELECT_OPTION_BY_CANDIDATE_FUNCTION})`, {
	Event: class {},
}) as (this: object, candidates: readonly string[]) => boolean;
function option(label: string) {
	return {
		tagName: "SELECT",
		options: [
			{ value: "", text: "選択してください", selected: true },
			{ value: "other-topic", text: label, selected: false },
		],
		dispatchEvent: () => true,
	};
}

describe("future approved general outreach choice profile", () => {
	test.each([
		[288, "その他について"],
		[706, "その他について"],
		[305, "その他、協業やご提案について"],
		[434, "各種お問い合わせ"],
		[693, "その他のお問合せ"],
		[925, "その他のご意見・ご感想"],
		[941, "弊社への提案"],
	])("row %s selects only the explicitly supplied label", (_row, label) => {
		expect(select.call(option(label as string), legacy.inquiryType ?? [])).toBe(
			false,
		);
		const control = option(label as string);
		expect(select.call(control, profile.inquiryType ?? [])).toBe(true);
		expect(control.options[1]?.selected).toBe(true);
	});
	test("retains the candidate limit and rejects merged profiles", () => {
		expect(profile.inquiryType).toHaveLength(10);
		for (const values of Object.values(profile))
			expect(isTrustedCandidateList(values)).toBe(true);
		expect(
			isTrustedCandidateList([...(profile.inquiryType ?? []), "別の候補"]),
		).toBe(false);
	});
	test.each([
		"資料請求",
		"サービスについて",
		"採用について",
		"その他の有料サービスについて",
		"個人情報の第三者提供に同意する",
	])("does not infer permission for %s", (label) => {
		expect(select.call(option(label), profile.inquiryType ?? [])).toBe(false);
	});
	test.each([546, 730])(
		"row %s authorizes radio consent by its full literal label",
		() => {
			const radio = {
				tagName: "INPUT",
				type: "radio",
				value: "agree",
				name: "privacyConsent",
				form: {},
				checked: false,
				labels: [{ textContent: "同意する" }],
				getAttribute: () => null,
				closest: () => null,
				getRootNode: () => ({ querySelectorAll: () => [] }),
				click() {
					this.checked = true;
				},
			};
			const choose = runInNewContext(
				`(${SELECT_RADIO_BY_CANDIDATE_FUNCTION})`,
			) as (this: object, candidates: readonly string[]) => string;
			expect(choose.call(radio, legacy.privacyConsent ?? [])).toBe(
				"not_candidate",
			);
			expect(choose.call(radio, profile.privacyConsent ?? [])).toBe("selected");
			radio.labels = [{ textContent: "今後の広告メールの受信に同意する" }];
			radio.checked = false;
			expect(choose.call(radio, profile.privacyConsent ?? [])).toBe(
				"not_candidate",
			);
			expect(radio.checked).toBe(false);
		},
	);
});
