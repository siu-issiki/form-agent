import { describe, expect, test } from "bun:test";
import { parseObservedForms } from "../src/observed-form";

describe("parseObservedForms", () => {
	test("types the fields a driver observation reports", () => {
		const forms = parseObservedForms([
			{
				action: "/contact",
				method: "post",
				fields: [
					{
						elementId: "fa-0-0",
						tag: "input",
						type: "text",
						name: "company",
						label: "会社名",
						placeholder: "株式会社",
						required: true,
						value: "Acme",
						options: ["a", "b"],
					},
					{
						elementId: "fa-0-1",
						tag: "input",
						type: "checkbox",
						checked: false,
					},
				],
				prohibitedReasonCodes: ["SALES_PROHIBITED"],
			},
		]);

		expect(forms.length).toBe(1);
		const form = forms[0];
		expect(form?.prohibitedReasonCodes).toEqual(["SALES_PROHIBITED"]);
		expect(form?.fields?.length).toBe(2);
		expect(form?.fields?.[0]).toMatchObject({
			elementId: "fa-0-0",
			tag: "input",
			type: "text",
			name: "company",
			label: "会社名",
			required: true,
			value: "Acme",
		});
		expect(form?.fields?.[0]?.checked).toBeUndefined();
		expect(form?.fields?.[1]?.checked).toBe(false);
	});

	test("keeps every property a scan never reads in raw", () => {
		const field = {
			elementId: "fa-0-0",
			tag: "select",
			options: ["a", "b"],
			role: "combobox",
			placeholder: "選択",
		};
		const form = { action: "/contact", method: "get", fields: [field] };

		const parsed = parseObservedForms([form]);

		expect(parsed[0]?.raw).toBe(form);
		expect(parsed[0]?.fields?.[0]?.raw).toBe(field);
	});

	test("keeps a form that is not an object, with no fields of its own", () => {
		const parsed = parseObservedForms(["form", null, 7, ["fa-0-0"]]);

		expect(parsed.length).toBe(4);
		for (const form of parsed) {
			expect(form.fields).toBeNull();
			expect(form.prohibitedReasonCodes).toBeNull();
		}
		expect(parsed[0]?.raw).toBe("form");
		expect(parsed[3]?.raw).toEqual(["fa-0-0"]);
	});

	test("reports a missing or non-array fields list as null, not as no fields", () => {
		const parsed = parseObservedForms([
			{},
			{ fields: null },
			{ fields: "fa-0-0" },
			{ fields: {} },
			{ fields: [] },
		]);

		expect(parsed.map((form) => form.fields)).toEqual([
			null,
			null,
			null,
			null,
			[],
		]);
	});

	test("drops a field that is not an object", () => {
		const parsed = parseObservedForms([
			{ fields: ["fa-0-0", null, 7, ["fa-0-1"], { elementId: "fa-0-2" }] },
		]);

		expect(parsed[0]?.fields?.length).toBe(1);
		expect(parsed[0]?.fields?.[0]?.elementId).toBe("fa-0-2");
	});

	test("keeps a field whose properties carry the wrong type, without them", () => {
		const parsed = parseObservedForms([
			{
				fields: [
					{
						elementId: 7,
						tag: true,
						type: null,
						name: {},
						label: ["会社名"],
						value: 42,
						checked: "yes",
						required: 1,
					},
				],
			},
		]);

		const field = parsed[0]?.fields?.[0];
		// The field itself stays: the fingerprint records every comparable field
		// the page reported, whether or not it named it with a usable id.
		expect(parsed[0]?.fields?.length).toBe(1);
		expect(field?.elementId).toBeUndefined();
		expect(field?.tag).toBeUndefined();
		expect(field?.type).toBeUndefined();
		expect(field?.name).toBeUndefined();
		expect(field?.label).toBeUndefined();
		expect(field?.value).toBeUndefined();
		expect(field?.checked).toBeUndefined();
		expect(field?.required).toBeUndefined();
		expect(field?.raw.elementId).toBe(7);
	});

	test("reports prohibition metadata only where the form carried an array", () => {
		const parsed = parseObservedForms([
			{},
			{ prohibitedReasonCodes: "SALES_PROHIBITED" },
			{ prohibitedReasonCodes: [] },
			{ prohibitedReasonCodes: ["SALES_PROHIBITED", "UNKNOWN_CODE", 7] },
		]);

		expect(parsed[0]?.prohibitedReasonCodes).toBeNull();
		expect(parsed[1]?.prohibitedReasonCodes).toBeNull();
		expect(parsed[2]?.prohibitedReasonCodes).toEqual([]);
		// Unfiltered on purpose: which codes count is the reader's decision.
		expect(parsed[3]?.prohibitedReasonCodes).toEqual([
			"SALES_PROHIBITED",
			"UNKNOWN_CODE",
			7,
		]);
	});

	test("keeps the observed order and length", () => {
		const parsed = parseObservedForms([
			{ fields: [{ elementId: "fa-0-0" }] },
			"form",
			{ fields: [{ elementId: "fa-1-0" }] },
		]);

		expect(parsed.map((form) => form.fields?.[0]?.elementId ?? null)).toEqual([
			"fa-0-0",
			null,
			"fa-1-0",
		]);
	});

	test("returns no forms for an empty observation", () => {
		expect(parseObservedForms([])).toEqual([]);
	});
});
