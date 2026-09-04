/** Lower-case hex SHA-256 of a string (UTF-8) or of raw bytes. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	// Copying into a fresh ArrayBuffer keeps the view type narrow enough for
	// the WebCrypto signature under both the bun and the Workers definitions.
	const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	copy.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", copy);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
