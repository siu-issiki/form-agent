/**
 * JavaScript source that is evaluated inside the page, kept as strings.
 * Nothing here runs in the Worker; every constant is handed to CDP so that it
 * is compiled in the page's own realm.
 */

import { PROHIBITION_TEXT_PATTERN_SOURCES } from "./form-prohibition";

export const BLOCK_BROWSER_ESCAPE_EXPRESSION = `(() => {
  class BlockedNetworkConstructor { constructor() { throw new Error("Browser network escape is disabled"); } }
  for (const name of [
    "WebSocket",
    "WebSocketStream",
    "WebTransport",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "Worker",
    "SharedWorker"
  ]) {
    Object.defineProperty(globalThis, name, { value: BlockedNetworkConstructor, configurable: false, writable: false });
  }
  Object.defineProperty(globalThis, "open", { value: () => null, configurable: false, writable: false });
  try {
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        value: () => Promise.reject(new Error("Service workers are disabled")),
        configurable: false,
        writable: false
      });
    }
  } catch {}
})()`;

export const INSPECT_ELEMENT_FUNCTION = String.raw`function() {
  const element = this;
  if (!element || typeof element.tagName !== "string") return { ok: false };
  const tag = element.tagName.toLowerCase();
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  const labels = Array.from(element.labels ?? []).map((label) => label.textContent?.trim() ?? "").filter(Boolean).join(" ");
  const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => element.getRootNode().getElementById?.(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
  const label = (element.getAttribute("aria-label") || labelledBy || labels || element.closest("label")?.textContent?.trim() || "").slice(0, 500);
  const submitLike = (tag === "button" && (!type || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type));
  const target = (element.getAttribute("formtarget") ?? element.form?.getAttribute("target") ?? "").trim().toLowerCase();
  const formAction = element.hasAttribute("formaction") ? element.formAction : element.form?.action;
  const formMethod = element.hasAttribute("formmethod") ? element.formMethod : element.form?.method;
  return {
    ok: true,
    visible,
    tag,
    type,
    name: typeof element.name === "string" && element.name ? element.name.slice(0, 500) : null,
    label,
    placeholder: typeof element.placeholder === "string" && element.placeholder ? element.placeholder.slice(0, 500) : null,
    required: Boolean(element.required),
    value: typeof element.value === "string" ? element.value.slice(0, 8192) : "",
    options: tag === "select" ? Array.from(element.options).slice(0, 100).map((option) => ({ value: option.value.slice(0, 2048), label: option.text.slice(0, 500) })) : [],
    submitLike,
    target,
    formAction: typeof formAction === "string" ? formAction.slice(0, 2048) : "",
    formMethod: typeof formMethod === "string" ? formMethod.slice(0, 20) : "",
    disabled: Boolean(element.disabled),
    readOnly: Boolean(element.readOnly),
    checked: Boolean(element.checked)
  };
}`;

export const HAS_CONFIRMATION_TEXT_FUNCTION = `function(pattern, pendingPattern) {
  const text = String(this.innerText || "");
  // A review-before-send screen ("まだ送信は完了していません", "この内容で送信")
  // mentions completion without being one, so it never counts.
  if (new RegExp(pendingPattern, "i").test(text)) return false;
  return new RegExp(pattern, "i").test(text);
}`;

/**
 * In-page helpers shared by the radio group scan and the checkbox match, so
 * that a candidate means the same thing for every choice control. Matching is
 * an exact comparison against the control value or the trimmed, case-folded
 * label; no partial or fuzzy match is ever made.
 */
const CHOICE_CANDIDATE_HELPERS = `
  const normalizeText = (text) => String(text ?? "").trim().toLowerCase();
  const labelTexts = (element) => {
    const root = element.getRootNode();
    // observe reports several labels, and several aria-labelledby targets, as
    // one joined string each. Only those joined forms are compared, so a
    // candidate can never match a fragment the model was never shown; a
    // question label shared by a whole radio group is one such fragment.
    const labels = Array.from(element.labels ?? []).map((label) => normalizeText(label.textContent)).filter(Boolean).join(" ");
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\\s+/).filter(Boolean)
      .map((id) => normalizeText(root.getElementById?.(id)?.textContent)).filter(Boolean).join(" ");
    return [
      labels,
      labelledBy,
      normalizeText(element.getAttribute("aria-label")),
      normalizeText(element.closest("label")?.textContent),
    ].filter(Boolean);
  };
  const candidateRank = (element, candidates) => {
    const texts = labelTexts(element);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (typeof candidate !== "string" || !candidate) continue;
      if (element.value === candidate || texts.includes(normalizeText(candidate))) return index;
    }
    return -1;
  };
`;

/**
 * Selects the option matching the earliest candidate, by option value or by
 * the same option text `observe` reports. A placeholder option with an empty
 * value is never chosen, because submitting it is the same as choosing nothing.
 * A disabled option, and an option under a disabled optgroup, is skipped so
 * that a candidate the user could never pick does not block a later one.
 */
export const SELECT_OPTION_BY_CANDIDATE_FUNCTION = `function(candidates) {
  if (this.tagName !== "SELECT" || !Array.isArray(candidates)) return false;
  const normalizeText = (text) => String(text ?? "").trim().toLowerCase();
  const isSelectable = (option) => {
    if (option.value === "" || option.disabled) return false;
    const group = option.parentElement;
    return !(group && group.tagName === "OPTGROUP" && group.disabled);
  };
  const options = Array.from(this.options).filter(isSelectable);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const wanted = normalizeText(candidate);
    const match = options.find((option) => option.value === candidate || normalizeText(option.text) === wanted);
    if (!match) continue;
    // Deselecting first keeps a multi-select from carrying an earlier choice.
    for (const option of this.options) option.selected = false;
    match.selected = true;
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}`;

/**
 * Checks the radio only when no other enabled radio of the same group matches
 * an earlier candidate, so the registrant's order decides which one is used
 * even when the DOM order differs. Answers with one of three fixed tokens.
 */
export const SELECT_RADIO_BY_CANDIDATE_FUNCTION = `function(candidates) {
  if (this.tagName !== "INPUT" || this.type !== "radio" || !Array.isArray(candidates)) return "not_candidate";
  ${CHOICE_CANDIDATE_HELPERS}
  const own = candidateRank(this, candidates);
  if (own < 0) return "not_candidate";
  const root = this.getRootNode();
  for (const radio of Array.from(root.querySelectorAll?.('input[type="radio"]') ?? [])) {
    if (radio === this || radio.disabled || radio.name !== this.name || radio.form !== this.form) continue;
    const rank = candidateRank(radio, candidates);
    if (rank >= 0 && rank < own) return "higher_priority_exists";
  }
  if (!this.checked) this.click();
  return this.checked ? "selected" : "not_candidate";
}`;

/** Whether the control's own value or label equals one of the candidates. */
export const MATCHES_CHOICE_CANDIDATE_FUNCTION = `function(candidates) {
  if (!Array.isArray(candidates)) return false;
  ${CHOICE_CANDIDATE_HELPERS}
  return candidateRank(this, candidates) >= 0;
}`;

export const ACTIVATE_SUBMIT_FUNCTION = `function(input, expectedAction, expectedMethod) {
  if (!this.isConnected || this.disabled || !this.form) return false;
  if (input != null && (!input.isConnected || input.form !== this.form)) return false;
  const tag = typeof this.tagName === "string" ? this.tagName.toLowerCase() : "";
  const type = typeof this.type === "string" ? this.type.toLowerCase() : "";
  const submitLike = (tag === "button" && (!type || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type));
  if (!submitLike) return false;
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const target = (this.getAttribute("formtarget") ?? this.form.getAttribute("target") ?? "").trim().toLowerCase();
  if (target && target !== "_self") return false;
  const rawAction = this.hasAttribute("formaction") ? this.formAction : this.form.action;
  const action = new URL(rawAction);
  action.hash = "";
  const method = (this.hasAttribute("formmethod") ? this.formMethod : this.form.method).toUpperCase();
  if (action.toString() !== expectedAction || method !== expectedMethod) return false;
  const nativeClick = HTMLElement.prototype.click;
  if (typeof nativeClick !== "function") return false;
  nativeClick.call(this);
  return true;
}`;

export const SET_CHECKED_VALUE_FUNCTION = `function(checked) {
  if (this.tagName !== "INPUT" || !["checkbox", "radio"].includes(this.type) || typeof checked !== "boolean") return false;
  if (this.type === "radio" && !checked) return false;
  if (this.checked !== checked) this.click();
  return this.checked === checked;
}`;

export const IS_SUBMIT_UNOBSCURED_FUNCTION = `function() {
  if (!this.isConnected || typeof this.getBoundingClientRect !== "function") return false;
  const rect = this.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const root = this.getRootNode?.();
  const hitTestRoot = root && typeof root.elementFromPoint === "function" ? root : this.ownerDocument;
  const hit = hitTestRoot?.elementFromPoint?.(x, y);
  let current = hit;
  while (current) {
    if (current === this) return true;
    const currentRoot = current.getRootNode?.();
    current = current.parentElement ?? currentRoot?.host ?? null;
  }
  return false;
}`;

export const IS_ELEMENT_FOCUSED_FUNCTION = `function() {
  const root = this.getRootNode?.();
  return Boolean(this.isConnected && root && root.activeElement === this);
}`;

export const CHECK_FORM_VALIDITY_FUNCTION = `function() {
  return Boolean(this.form && typeof this.form.checkValidity === "function" && this.form.checkValidity());
}`;

export const READ_FORM_PROHIBITION_REASON_CODES_FUNCTION = `function() {
  const patternSources = ${JSON.stringify(PROHIBITION_TEXT_PATTERN_SOURCES)};
  const texts = [];
  const appendText = (value) => {
    texts.push(String(value ?? ""));
  };
  appendText(this.innerText);
	const headingTexts = [];
	const appendHeadings = (element) => {
		if (!element || headingTexts.length >= 20) return;
		if (element.matches?.("h1, h2, h3, legend")) {
			headingTexts.push(String(element.innerText ?? "").slice(0, 200));
		}
		const nodes = element.querySelectorAll?.("h1, h2, h3, legend");
		const length = Math.min(Number(nodes?.length) || 0, 20);
		for (let index = 0; index < length && headingTexts.length < 20; index += 1) {
			headingTexts.push(String(nodes[index]?.innerText ?? "").slice(0, 200));
		}
	};
	appendHeadings(this);
	headingTexts.push(String(this.ownerDocument?.title ?? "").slice(0, 200));
	const appendPrevious = (element, limit) => {
		let sibling = element?.previousElementSibling;
		for (let count = 0; count < limit && sibling; count += 1) {
			if (sibling.matches?.("form") || sibling.querySelector?.("form")) break;
			if (!["HEADER", "NAV", "FOOTER"].includes(sibling.tagName)) {
				appendText(sibling.innerText);
				appendHeadings(sibling);
			}
			sibling = sibling.previousElementSibling;
		}
	};
	appendPrevious(this, 3);
	let current = this.parentElement;
	for (let depth = 0; depth < 2 && current && current.tagName !== "BODY"; depth += 1) {
		appendPrevious(current, 1);
		current = current.parentElement;
	}
	const host = this.getRootNode?.()?.host ?? null;
	if (host) {
		appendPrevious(host, 1);
		current = host.parentElement;
		for (let depth = 0; depth < 2 && current && current.tagName !== "BODY"; depth += 1) {
			appendPrevious(current, 1);
			current = current.parentElement;
		}
	}
  const detectionTexts = [...texts];
  for (let index = 1; index < texts.length; index += 1) {
    detectionTexts.push(texts[index - 1].slice(-128) + " " + texts[index].slice(0, 128));
  }
  const codes = [];
  for (const rawText of detectionTexts) {
    const text = rawText.replace(/\\s+/g, " ").toLowerCase();
    const withoutExplicitAllowances = patternSources.explicitAllowances.reduce(
      (value, source) => value.replace(new RegExp(source, "g"), " "),
      text,
    );
    if (
      !codes.includes("SALES_PROHIBITED") &&
      patternSources.salesProhibited.some((source) => new RegExp(source).test(withoutExplicitAllowances))
    ) {
      codes.push("SALES_PROHIBITED");
    }
    if (
      !codes.includes("FORM_PURPOSE_INCOMPATIBLE") &&
      patternSources.formPurposeIncompatible.some((source) => new RegExp(source).test(text))
    ) {
      codes.push("FORM_PURPOSE_INCOMPATIBLE");
    }
  }
  for (const rawHeading of headingTexts) {
    if (codes.includes("FORM_PURPOSE_INCOMPATIBLE")) break;
    const heading = rawHeading.replace(/\\s+/g, " ").trim().toLowerCase();
    // A heading longer than this names something besides the form's purpose,
    // and the bound also keeps the filler pattern from backtracking.
    if (heading.length === 0 || heading.length > 32) continue;
    if (patternSources.formPurposeHeading.some((source) => new RegExp(source).test(heading))) {
      codes.push("FORM_PURPOSE_INCOMPATIBLE");
    }
  }
  return codes;
}`;

export const HAS_SAME_FORM_OWNER_FUNCTION = `function(input) {
  return Boolean(this.form && input && input.form === this.form);
}`;

export const IS_COMPOSED_DESCENDANT_FUNCTION = `function(candidate) {
  let current = candidate;
  while (current) {
    if (current === this) return true;
    const root = current.getRootNode?.();
    current = current.parentElement ?? root?.host ?? null;
  }
  return false;
}`;
