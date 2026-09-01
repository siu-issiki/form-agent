const OUTPUT_TOKEN_FIELDS = [
	"max_output_tokens",
	"max_completion_tokens",
	"max_tokens",
] as const;

export function capProviderOutputTokens(
	payload: unknown,
	maximum: number,
): unknown {
	if (
		!Number.isInteger(maximum) ||
		maximum < 1 ||
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return payload;
	}

	const next = { ...(payload as Record<string, unknown>) };
	let changed = false;
	for (const field of OUTPUT_TOKEN_FIELDS) {
		const value = next[field];
		if (typeof value === "number" && value > maximum) {
			next[field] = maximum;
			changed = true;
		}
	}
	return changed ? next : payload;
}
