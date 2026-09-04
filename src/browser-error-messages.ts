/**
 * The fixed messages of the plain `Error`s the browser layers throw. Several
 * layers classify a failure by comparing `error.message` against these
 * strings, so a throw site and a classifier must share one definition: a
 * message renamed in only one place would silently downgrade the diagnostic
 * to UNKNOWN. Messages are fixed text on purpose and never carry page or
 * provider content.
 */
export const BROWSER_ERROR = {
	CDP_CONNECTION_ABORTED: "Browser Use CDP connection aborted",
	CDP_CONNECTION_FAILED: "Browser Use CDP connection failed",
	CDP_CONNECTION_IS_CLOSED: "Browser Use CDP connection is closed",
	CDP_CONNECTION_CLOSED: "Browser Use CDP connection closed",
	CDP_COMMAND_TIMED_OUT: "Browser Use CDP command timed out",
	CDP_COMMAND_NOT_SENT: "Browser Use CDP command could not be sent",
	CDP_COMMAND_FAILED: "Browser Use CDP command failed",
	CDP_PAYLOAD_TOO_LARGE:
		"Browser Use CDP payload exceeded the safe Worker limit",
	CDP_ENDPOINT_INVALID: "Invalid Browser Use CDP endpoint",
	API_REQUEST_FAILED: "Browser Use request failed",
	API_KEY_REQUIRED: "Browser Use API key is required",
	SESSION_ID_REQUIRED: "Browser session ID is required",
	SESSION_WITHOUT_CDP_URL:
		"Browser Use did not return an active session with a CDP URL",
	DOMAIN_SCOPE_CANNOT_CHANGE: "Browser domain scope cannot be changed",
	HOST_SCOPE_CANNOT_CHANGE: "Browser host scope cannot be changed",
	DOMAIN_SCOPE_NOT_CONFIGURED: "Browser domain scope is not configured",
	NAVIGATION_FAILED: "Browser navigation failed",
	PAGE_NOT_READY: "Browser page did not become ready",
	DOM_DISCOVERY_FAILED: "Browser DOM discovery failed",
	PAGE_EVALUATION_FAILED: "Browser page evaluation failed",
	SCREENSHOT_FAILED: "Browser screenshot failed",
} as const;

export type BrowserErrorMessage =
	(typeof BROWSER_ERROR)[keyof typeof BROWSER_ERROR];
