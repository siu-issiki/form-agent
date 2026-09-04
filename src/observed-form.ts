import { isRecord } from "./json-record";

/**
 * The observation a page returns is page-controlled JSON, so it arrives as
 * `unknown`. This module types it once, at the restricted browser boundary, so
 * that every later scan reads named properties instead of repeating its own
 * `isRecord` / `Array.isArray` / `typeof` checks.
 *
 * The parser is deliberately not a validator: it never rejects an observation.
 * A property that does not carry the type its readers expect is simply absent
 * from the parsed field, which is exactly what the hand-written checks did with
 * it. Anything no scan reads -- `options`, `placeholder`, `role`, `action`,
 * `method` -- is untouched in `raw`, which stays the value handed to the model.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * One field of an observed form. Every property is optional because the page
 * decides what it reports; a property is present only when it carried the type
 * its readers require.
 */
export interface ObservedField {
	/** The handle a tool call names. Absent unless the page reported a string. */
	readonly elementId?: string;
	readonly tag?: string;
	readonly type?: string;
	readonly name?: string;
	readonly label?: string;
	readonly value?: string;
	readonly checked?: boolean;
	readonly required?: boolean;
	/** The field as observed, including properties no scan reads. */
	readonly raw: Record<string, unknown>;
}

export interface ObservedForm {
	/**
	 * The parsed fields, or null when the observation carried no `fields` array
	 * -- either because the form was not an object at all or because `fields`
	 * was something other than an array. Null is kept distinct from an empty
	 * array because `observationFingerprint` records the two differently.
	 */
	readonly fields: readonly ObservedField[] | null;
	/**
	 * The reason codes the form carried, unfiltered, or null when it carried no
	 * array. Null is what marks a form as lacking trusted prohibition metadata,
	 * so it stays distinct from an empty array here as well. The values are left
	 * unchecked: `readProhibitedReasonCodes` owns which codes it recognises.
	 */
	readonly prohibitedReasonCodes: readonly unknown[] | null;
	/** The form as observed, including properties no scan reads. */
	readonly raw: unknown;
}

/** Types one observation's forms. Every entry is kept, in order. */
export function parseObservedForms(forms: readonly unknown[]): ObservedForm[] {
	return forms.map(parseObservedForm);
}

function parseObservedForm(form: unknown): ObservedForm {
	if (!isRecord(form)) {
		return { fields: null, prohibitedReasonCodes: null, raw: form };
	}
	return {
		fields: Array.isArray(form.fields)
			? form.fields.filter(isRecord).map(parseObservedField)
			: null,
		prohibitedReasonCodes: Array.isArray(form.prohibitedReasonCodes)
			? form.prohibitedReasonCodes
			: null,
		raw: form,
	};
}

function parseObservedField(field: Record<string, unknown>): ObservedField {
	const parsed: Mutable<ObservedField> = { raw: field };
	if (typeof field.elementId === "string") parsed.elementId = field.elementId;
	if (typeof field.tag === "string") parsed.tag = field.tag;
	if (typeof field.type === "string") parsed.type = field.type;
	if (typeof field.name === "string") parsed.name = field.name;
	if (typeof field.label === "string") parsed.label = field.label;
	if (typeof field.value === "string") parsed.value = field.value;
	if (typeof field.checked === "boolean") parsed.checked = field.checked;
	if (typeof field.required === "boolean") parsed.required = field.required;
	return parsed;
}
