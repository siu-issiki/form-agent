import { parse } from "tldts";
import {
	assertAllowedTargetUrl,
	NavigationPolicyError,
} from "./restricted-browser";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface VerificationProviderHost {
	/** Exact hostname, unless `allowSubdomains` is set. */
	readonly host: string;
	/** When set, only paths starting with this prefix are allowed. */
	readonly pathPrefix?: string;
	/** When set, `*.host` is allowed in addition to `host` itself. */
	readonly allowSubdomains?: boolean;
}

/**
 * Hosts of the verification widgets (reCAPTCHA, hCaptcha, Turnstile) every job
 * may reach, regardless of the target domain. The list is fixed in code: a job
 * can never extend it, and `allowedHosts` stays the only per-job mechanism.
 * Without these hosts the widgets fail to load and report "cannot connect",
 * which turned non-interactive challenges (reCAPTCHA v3, Turnstile) into
 * `CAPTCHA_REQUIRED` even though no human step was actually needed.
 */
export const VERIFICATION_PROVIDER_ALLOWLIST: readonly VerificationProviderHost[] =
	[
		{ host: "www.google.com", pathPrefix: "/recaptcha/" },
		{ host: "www.gstatic.com", pathPrefix: "/recaptcha/" },
		{ host: "recaptcha.net", pathPrefix: "/recaptcha/" },
		{ host: "www.recaptcha.net", pathPrefix: "/recaptcha/" },
		{ host: "hcaptcha.com", allowSubdomains: true },
		{ host: "challenges.cloudflare.com" },
	];

/** reCAPTCHA v3 posts its token, so POST cannot be excluded here. */
const VERIFICATION_PROVIDER_METHODS = new Set(["GET", "POST"]);

/**
 * Whether the URL alone belongs to a known verification widget: https without
 * credentials, an allowlisted host, and — where the entry names one — a path
 * below its prefix. Method and resource type are not considered, so the same
 * rule can be applied to a browser target's URL.
 */
export function isVerificationProviderUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password) return false;
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	return VERIFICATION_PROVIDER_ALLOWLIST.some((entry) => {
		const hostMatches = entry.allowSubdomains
			? hostname === entry.host || hostname.endsWith(`.${entry.host}`)
			: hostname === entry.host;
		if (!hostMatches) return false;
		return (
			entry.pathPrefix === undefined ||
			url.pathname.startsWith(entry.pathPrefix)
		);
	});
}

/**
 * Whether the request may be continued because it belongs to a known
 * verification widget. Only https and XHR / fetch / subresources qualify in the
 * top frame: a `Document` request there is a page navigation, and the run must
 * never leave the target domain. Below the top frame a `Document` request is
 * the widget's own iframe (`.../recaptcha/api2/anchor`), which has to load for
 * the widget to work at all, so `subframe` allows exactly that case.
 */
export function isVerificationProviderRequest(
	rawUrl: string,
	method: string,
	resourceType?: string,
	subframe = false,
): boolean {
	if (resourceType === "Document" && !subframe) return false;
	if (!VERIFICATION_PROVIDER_METHODS.has(method.toUpperCase())) return false;
	return isVerificationProviderUrl(rawUrl);
}

/**
 * Throws unless the request may be continued. Returns whether it was allowed by
 * {@link VERIFICATION_PROVIDER_ALLOWLIST}, so the caller can count it.
 */
export function assertAllowedBrowserRequest(
	url: string,
	targetDomain: string,
	method: string,
	submissionAuthorized: boolean,
	allowExternalRead = false,
	blockRequest = false,
	allowedHosts: readonly string[] = [],
	resourceType?: string,
	subframe = false,
): boolean {
	// Checked before every other rule so a widget keeps working after the
	// dry-run interaction lock and outside the safe-method window.
	if (isVerificationProviderRequest(url, method, resourceType, subframe)) {
		return true;
	}
	if (blockRequest) throw new NavigationPolicyError();
	const safeMethod = SAFE_METHODS.has(method.toUpperCase());
	if (allowExternalRead && safeMethod) {
		assertPublicBrowserResourceUrl(url);
	} else {
		assertAllowedTargetUrl(url, targetDomain, allowedHosts);
	}
	if (!submissionAuthorized && !safeMethod) {
		throw new NavigationPolicyError();
	}
	return false;
}

function assertPublicBrowserResourceUrl(rawUrl: string): void {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new NavigationPolicyError();
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	const parsed = parse(hostname, {
		allowPrivateDomains: true,
		detectSpecialUse: true,
		extractHostname: false,
	});
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		parsed.isIp ||
		parsed.isSpecialUse ||
		(!parsed.isIcann && !parsed.isPrivate)
	) {
		throw new NavigationPolicyError();
	}
}
