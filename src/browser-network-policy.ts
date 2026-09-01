import { parse } from "tldts";
import {
	assertAllowedTargetUrl,
	NavigationPolicyError,
} from "./restricted-browser";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function assertAllowedBrowserRequest(
	url: string,
	targetDomain: string,
	method: string,
	submissionAuthorized: boolean,
	allowExternalRead = false,
	blockRequest = false,
	allowedHosts: readonly string[] = [],
): void {
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
