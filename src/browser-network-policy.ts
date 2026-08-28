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
): void {
	assertAllowedTargetUrl(url, targetDomain);
	if (!submissionAuthorized && !SAFE_METHODS.has(method.toUpperCase())) {
		throw new NavigationPolicyError();
	}
}
