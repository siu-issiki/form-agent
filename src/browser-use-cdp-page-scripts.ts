/**
 * JavaScript source that is evaluated inside the page, kept as strings.
 * Nothing here runs in the Worker; every constant is handed to CDP so that it
 * is compiled in the page's own realm.
 */

import { SUBMISSION_INCOMPLETE_PATTERN } from "./browser-submit-confirmation";
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

// Custom choices are scoped by the control's explicit ARIA relationship. A
// document-wide option search could select another field's answer.
const ARIA_LISTBOX_HELPERS = String.raw`
  const isListboxChoice = (element) => element.getAttribute("aria-haspopup") === "listbox" && (
    (element.tagName === "INPUT" && ["text", "search", ""].includes(element.type) && element.readOnly) ||
    (element.tagName === "BUTTON" && element.type === "button" && element.getAttribute("role") === "combobox")
  );
  const isChoiceVisible = (element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  };
  const listboxOptions = (element) => {
    if (!isListboxChoice(element)) return [];
    const ids = (element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || "").trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1) return [];
    const listbox = element.getRootNode().getElementById?.(ids[0]);
    if (!listbox || listbox.getAttribute("role") !== "listbox" || !isChoiceVisible(listbox)) return [];
    const options = Array.from(listbox.querySelectorAll('[role="option"]')).filter((option) =>
      option.closest('[role="listbox"]') === listbox && !option.disabled && option.getAttribute("aria-disabled") !== "true" && isChoiceVisible(option)
    );
    return options.length <= 100 ? options : [];
  };
  const choiceText = (element) => String(element.innerText ?? element.textContent ?? "").trim();
`;

export const INSPECT_ELEMENT_FUNCTION = String.raw`function() {
  const element = this;
  ${ARIA_LISTBOX_HELPERS}
  if (!element || typeof element.tagName !== "string") return { ok: false };
  const tag = element.tagName.toLowerCase();
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
  const listboxChoice = isListboxChoice(element);
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  // Native choice inputs are often hidden while an associated label paints the
  // control. Only a real, visible label may expose such an input; arbitrary
  // hidden inputs and hidden/inert form sections remain unavailable.
  const visibleChoiceLabel = tag === "input" && ["checkbox", "radio"].includes(type)
    && element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && Array.from(element.labels ?? []).some((label) => {
      if (label.control !== element || label.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const labelRect = label.getBoundingClientRect();
      if (labelRect.width <= 0 || labelRect.height <= 0) return false;
      for (let current = label; current; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        if (currentStyle.display === "none" || currentStyle.visibility === "hidden" || currentStyle.opacity === "0") return false;
      }
      for (let current = element.parentElement; current; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        if (currentStyle.display === "none" || currentStyle.visibility === "hidden" || currentStyle.opacity === "0") return false;
      }
      return true;
    });
  const visible = !element.closest('[hidden], [inert], [aria-hidden="true"]') && ((rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") || visibleChoiceLabel);
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
    tag: listboxChoice ? "select" : tag,
    type: listboxChoice ? "aria-listbox" : type,
    name: typeof element.name === "string" && element.name ? element.name.slice(0, 500) : null,
    label,
    placeholder: typeof element.placeholder === "string" && element.placeholder ? element.placeholder.slice(0, 500) : null,
    required: Boolean(element.required),
    value: listboxChoice && tag === "button" ? choiceText(element).slice(0, 8192) : (typeof element.value === "string" ? element.value.slice(0, 8192) : ""),
    options: tag === "select" ? Array.from(element.options).slice(0, 100).map((option) => ({ value: option.value.slice(0, 2048), label: option.text.slice(0, 500) })) : (listboxChoice ? listboxOptions(element).map((option) => ({ value: choiceText(option).slice(0, 2048), label: choiceText(option).slice(0, 500) })) : []),
    submitLike,
    target,
    formAction: typeof formAction === "string" ? formAction.slice(0, 2048) : "",
    formMethod: typeof formMethod === "string" ? formMethod.slice(0, 20) : "",
    disabled: Boolean(element.disabled) || (listboxChoice && element.getAttribute("aria-disabled") === "true"),
    readOnly: Boolean(element.readOnly),
    checked: Boolean(element.checked)
  };
}`;

/** Read the exact matched text in the same snapshot used for the decision. */
export const READ_SUBMISSION_MESSAGES_FUNCTION = `function(pattern, pendingPattern, failurePattern, previous) {
  const text = String(this.innerText || "");
  // Exclude a result message quoted immediately after an explicit display-example label.
  // Do not reject a page merely for having a FAQ elsewhere or mask a later real result.
  const exampleIntroduction = /(?:^|[\\r\\n])[ \\t]*(?:(?:次|以下)の(?:メッセージ|文言)が表示された場合[^。\\r\\n]{0,80}。|表示例[:：]?)[ \\t]*$/;
  const messages = (pattern) => Array.from(text.matchAll(new RegExp(pattern, "gi"))).filter((match) =>
    !exampleIntroduction.test(text.slice(Math.max(0, match.index - 160), match.index).trimEnd())).map((match) => match[0]);
  const confirmationCandidates = Array.from(new Set(messages(pattern)));
  const candidate = confirmationCandidates[0] ?? "";
  // Formatting changes cannot turn an old receipt into a new submission result.
  // Normalize only identity comparisons; keep exact matches for evidence.
  const candidateIdentity = (value) => value.replace(/\\s+/g, "").toLowerCase();
  const pendingLines = Array.from(new Set(Array.from(text.matchAll(new RegExp(pendingPattern, "gi")), (match) => {
    const start = text.lastIndexOf("\\n", match.index - 1) + 1;
    const end = text.indexOf("\\n", match.index);
    return text.slice(start, end === -1 ? text.length : end).trim();
  })));
  const pendingGuidance = confirmationCandidates.length <= 20 && pendingLines.length <= 20 && pendingLines.every((line) => line.length <= 500) ? pendingLines : [];
  // Only the same body's pre-submit lines may be treated as static instructions.
  // A remaining form (even hidden), control, receipt already present before,
  // or explicit non-completion keeps the original pending veto.
  const staticGuidanceOnly = previous && Array.isArray(previous.pendingGuidance)
    && pendingGuidance.length > 0 && pendingGuidance.every((line) => previous.pendingGuidance.includes(line))
    && candidate !== "" && Array.isArray(previous.confirmationCandidates) && !previous.confirmationCandidates.some((old) => candidateIdentity(old) === candidateIdentity(candidate))
    && !new RegExp(${JSON.stringify(SUBMISSION_INCOMPLETE_PATTERN)}, "i").test(text)
    && typeof this.querySelector === "function" && typeof this.querySelectorAll === "function"
    && !Array.from(this.querySelectorAll('[contenteditable]')).some((element) =>
      String(element.getAttribute("contenteditable")).toLowerCase() !== "false")
    && !this.querySelector('a[href], area[href], [tabindex], iframe, frame, form, input:not([type="hidden"]), textarea, select, button, [role="button"], [role="combobox"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]');
  const confirmation = pendingLines.length > 0 && !staticGuidanceOnly ? "" : candidate;
  const failure = messages(failurePattern)[0] ?? "";
  return { confirmation: confirmation.trim().slice(0, 500), failure: failure.trim().slice(0, 500),
    ...(previous ? { pendingGuidance, confirmationCandidates: confirmationCandidates.slice(0, 20) } : {}) };

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

/** Select only an exact label in the currently visible, explicitly owned listbox. */
export const SELECT_ARIA_LISTBOX_BY_CANDIDATE_FUNCTION = `function(candidates) {
  ${ARIA_LISTBOX_HELPERS}
  if (!isListboxChoice(this) || !Array.isArray(candidates) || this.disabled || this.getAttribute("aria-disabled") === "true" || !isChoiceVisible(this)) return null;
  const options = listboxOptions(this);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const matches = options.filter((option) => choiceText(option).toLowerCase() === candidate.trim().toLowerCase());
    if (matches.length > 1) return null;
    if (!matches.length) continue;
    const match = matches[0];
    const selectedLabel = choiceText(match);
    HTMLElement.prototype.click.call(match);
    return selectedLabel;
  }
  return null;
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
  // Script-driven send buttons still require the reviewed form owner,
  // visible state, action and method checked below.
  if (!submitLike && !(["button", "input"].includes(tag) && type === "button")) return false;
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

/** Commit native change/blur handlers before the next observation and review. */
export const COMMIT_TEXT_INPUT_FUNCTION = `function() {
  HTMLElement.prototype.blur.call(this);
}`;

export const CHECK_FORM_VALIDITY_FUNCTION = `function() {
  if (!this.form) return false;
  // Match native submit semantics. CF7 and similar forms use novalidate to
  // leave conditional-field validation to their own submit handler.
  if (this.form.noValidate === true || this.formNoValidate === true) return true;
  return Boolean(typeof this.form.checkValidity === "function" && this.form.checkValidity());
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
