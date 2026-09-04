import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS } from "../src/agent-tool-schema";
import { isRecord } from "../src/json-record";
import { PAYLOAD_KEY_PATTERN } from "../src/restricted-browser";
import {
	ELEMENT_ID_PATTERN,
	SUBMIT_ACTIVATION_STRATEGIES,
} from "../src/tool-input-patterns";

// The schema tells the provider which inputs are legal and the trusted
// handlers reject anything that is not, so both sides have to read the same
// definition. These tests pin the schema to the shared constants: a pattern
// loosened in the handler but not advertised, or an activation strategy added
// to the schema that no handler accepts, fails here.

/** Every occurrence of one property name across the tool definitions. */
function propertiesNamed(
	name: string,
): Array<[toolName: string, property: Record<string, unknown>]> {
	const found: Array<[string, Record<string, unknown>]> = [];
	for (const tool of AGENT_TOOLS) {
		const parameters: unknown = tool.parameters;
		if (!isRecord(parameters) || !isRecord(parameters.properties)) continue;
		const property = parameters.properties[name];
		if (!isRecord(property)) continue;
		found.push([tool.name, property]);
	}
	return found;
}

describe("AGENT_TOOLS input schema", () => {
	test("every elementId is described by ELEMENT_ID_PATTERN", () => {
		const properties = propertiesNamed("elementId");
		expect(properties.map(([toolName]) => toolName)).toEqual([
			"click",
			"fill",
			"select",
			"submit",
		]);
		for (const [, property] of properties) {
			expect(property.pattern).toBe(ELEMENT_ID_PATTERN.source);
		}
	});

	test("every payloadKey is described by PAYLOAD_KEY_PATTERN", () => {
		const properties = propertiesNamed("payloadKey");
		expect(properties.map(([toolName]) => toolName)).toEqual([
			"fill",
			"select",
		]);
		for (const [, property] of properties) {
			expect(property.pattern).toBe(PAYLOAD_KEY_PATTERN.source);
		}
	});

	test("activationStrategy offers exactly the accepted strategies", () => {
		const properties = propertiesNamed("activationStrategy");
		expect(properties.map(([toolName]) => toolName)).toEqual(["submit"]);
		for (const [, property] of properties) {
			expect(property.enum).toEqual([...SUBMIT_ACTIVATION_STRATEGIES]);
		}
	});
});
