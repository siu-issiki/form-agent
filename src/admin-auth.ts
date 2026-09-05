import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Only the configured owner's Access application token grants dashboard access. */
export async function authorizeAdmin(
	request: Request,
	env: Env,
): Promise<boolean> {
	const issuer = env.ADMIN_ACCESS_ISSUER;
	const audience = env.ADMIN_ACCESS_AUDIENCE;
	const email = env.ADMIN_EMAIL;
	const token = request.headers.get("cf-access-jwt-assertion");
	if (
		!issuer ||
		!audience ||
		!email ||
		!token ||
		token.length > 16384 ||
		!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
	)
		return false;
	try {
		let keys = keySets.get(issuer);
		if (!keys) {
			keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
				timeoutDuration: 5000,
			});
			keySets.set(issuer, keys);
		}
		const { payload } = await jwtVerify(token, keys, {
			issuer,
			audience,
			algorithms: ["RS256"],
			requiredClaims: ["exp", "iat", "sub", "email"],
		});
		return (
			typeof payload.email === "string" &&
			payload.email.toLowerCase() === email.toLowerCase()
		);
	} catch {
		return false;
	}
}
