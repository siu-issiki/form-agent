/**
 * Narrows an unknown value to a plain object with string keys. Arrays are
 * excluded on purpose: every caller indexes the result by a named key, and an
 * array that slipped through would silently read as "record with no fields".
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
