import { describe, expect, test } from "bun:test";
import { capProviderOutputTokens } from "./provider-payload";

describe("capProviderOutputTokens", () => {
	test("caps Responses API output tokens without changing other fields", () => {
		expect(
			capProviderOutputTokens(
				{
					model: "gpt-5.4-mini",
					max_output_tokens: 32_000,
					stream: true,
				},
				4_096,
			),
		).toEqual({
			model: "gpt-5.4-mini",
			max_output_tokens: 4_096,
			stream: true,
		});
	});

	test("caps Chat Completions token fields", () => {
		expect(
			capProviderOutputTokens(
				{ max_completion_tokens: 8_192, max_tokens: 16_384 },
				4_096,
			),
		).toEqual({ max_completion_tokens: 4_096, max_tokens: 4_096 });
	});

	test("preserves payloads already within the limit", () => {
		const payload = { max_output_tokens: 2_048 };
		expect(capProviderOutputTokens(payload, 4_096)).toBe(payload);
	});
});
