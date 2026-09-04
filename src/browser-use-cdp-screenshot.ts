/**
 * Screenshot capture over CDP: the viewport shot, the full-page plan that
 * keeps a capture under the CDP message limit, and the base64 decoding of
 * both.
 */
import { BROWSER_ERROR } from "./browser-error-messages";

export interface CdpScreenshotResult {
	data?: string;
}

export const SCREENSHOT_PARAMS = {
	format: "jpeg",
	quality: 80,
	captureBeyondViewport: false,
	fromSurface: true,
} as const;

/**
 * Captures only the currently visible viewport as JPEG. A payload that
 * exceeds the CDP message limit closes the underlying connection, so there is
 * no connection left to retry against; every failure is reported as the same
 * opaque error so that no page content leaks through the message.
 */
export async function captureCdpScreenshot(
	send: (params: Record<string, unknown>) => Promise<CdpScreenshotResult>,
): Promise<Uint8Array> {
	let result: CdpScreenshotResult;
	try {
		result = await send({ ...SCREENSHOT_PARAMS });
	} catch {
		throw new Error(BROWSER_ERROR.SCREENSHOT_FAILED);
	}
	return decodeCdpScreenshot(result);
}

function decodeCdpScreenshot(result: CdpScreenshotResult): Uint8Array {
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(result.data ?? "");
	} catch {
		throw new Error(BROWSER_ERROR.SCREENSHOT_FAILED);
	}
	if (bytes.byteLength === 0) {
		throw new Error(BROWSER_ERROR.SCREENSHOT_FAILED);
	}
	return bytes;
}

/**
 * Widest output image. A screenshot that is wider than this carries no extra
 * information for a reviewer and only grows the payload.
 */
export const FULL_PAGE_SCREENSHOT_MAX_WIDTH_PX = 1280;
/** Tallest output image, and with the width cap the long edge of the result. */
export const FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX = 4000;
/**
 * Floor for the downscale factor. Without it a very long page shrinks until
 * neither an operator nor the pre-submit review can read the fields, which
 * defeats the purpose of the evidence. Below the floor the capture keeps the
 * scale and cuts the page instead -- see `planFullPageScreenshot`.
 */
export const FULL_PAGE_SCREENSHOT_MIN_SCALE = 0.5;
export const FULL_PAGE_SCREENSHOT_QUALITY = 60;
/** Used when the planned image still looks large; see the pixel budget. */
export const FULL_PAGE_SCREENSHOT_REDUCED_QUALITY = 45;
/**
 * Safety net on the encoded size. The caps above already keep the output under
 * this, so it only fires if a cap is ever raised or the page reports a size the
 * caps cannot tame.
 */
export const FULL_PAGE_SCREENSHOT_PIXEL_BUDGET = 6_000_000;

export const FULL_PAGE_SCREENSHOT_BASE_PARAMS = {
	format: "jpeg",
	captureBeyondViewport: true,
	fromSurface: true,
} as const;

export interface CdpLayoutMetricsResult {
	cssContentSize?: { width?: number; height?: number };
}

export interface FullPageScreenshotClip {
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
}

export interface FullPageScreenshotPlan {
	quality: number;
	clip: FullPageScreenshotClip;
}

function positivePageSize(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

export function chooseFullPageScreenshotQuality(pixels: number): number {
	return pixels > FULL_PAGE_SCREENSHOT_PIXEL_BUDGET
		? FULL_PAGE_SCREENSHOT_REDUCED_QUALITY
		: FULL_PAGE_SCREENSHOT_QUALITY;
}

/**
 * Turns the CSS content size into the single `Page.captureScreenshot` clip that
 * covers the whole document.
 *
 * The width cap is absolute: the scale never lets the output grow past
 * `FULL_PAGE_SCREENSHOT_MAX_WIDTH_PX`. The height cap is met by scaling down
 * too, but only until `FULL_PAGE_SCREENSHOT_MIN_SCALE`; a page longer than that
 * allows is cut from the top edge, because an unbounded downscale produces an
 * image nothing can be read from. Both caps together keep the output inside
 * 1280x4000, which is what keeps the CDP response under the message limit that
 * would otherwise close the connection and lose the run.
 *
 * Returns `null` when the metrics are missing or not a usable size, so that the
 * caller can fall back to the viewport capture.
 */
export function planFullPageScreenshot(
	contentWidth: unknown,
	contentHeight: unknown,
): FullPageScreenshotPlan | null {
	const width = positivePageSize(contentWidth);
	const height = positivePageSize(contentHeight);
	if (width === null || height === null) return null;
	const widthScale = Math.min(1, FULL_PAGE_SCREENSHOT_MAX_WIDTH_PX / width);
	const scale = Math.min(
		widthScale,
		Math.max(
			FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX / height,
			FULL_PAGE_SCREENSHOT_MIN_SCALE,
		),
	);
	const clipHeight = Math.min(
		height,
		FULL_PAGE_SCREENSHOT_MAX_HEIGHT_PX / scale,
	);
	return {
		quality: chooseFullPageScreenshotQuality(
			width * scale * (clipHeight * scale),
		),
		clip: { x: 0, y: 0, width, height: clipHeight, scale },
	};
}

/**
 * Captures the whole document as one downscaled JPEG. The layout metrics are
 * read first so the clip can be sized before anything is encoded: the payload
 * has to be small enough up front, since a response over the CDP message limit
 * closes the connection instead of returning an error. Every failure is the
 * same opaque error, so no page content leaks through the message.
 */
export async function captureCdpFullPageScreenshot(
	getLayoutMetrics: () => Promise<CdpLayoutMetricsResult>,
	send: (params: Record<string, unknown>) => Promise<CdpScreenshotResult>,
): Promise<Uint8Array> {
	let metrics: CdpLayoutMetricsResult;
	try {
		metrics = await getLayoutMetrics();
	} catch {
		throw new Error(BROWSER_ERROR.SCREENSHOT_FAILED);
	}
	const plan = planFullPageScreenshot(
		metrics?.cssContentSize?.width,
		metrics?.cssContentSize?.height,
	);
	if (!plan) {
		throw new Error(BROWSER_ERROR.SCREENSHOT_FAILED);
	}

	let result: CdpScreenshotResult;
	try {
		result = await send({
			...FULL_PAGE_SCREENSHOT_BASE_PARAMS,
			quality: plan.quality,
			clip: plan.clip,
		});
	} catch {
		throw new Error(BROWSER_ERROR.SCREENSHOT_FAILED);
	}
	return decodeCdpScreenshot(result);
}

export function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
