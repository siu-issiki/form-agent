import { SUBMISSION_INCOMPLETE_PATTERN } from "./browser-submit-confirmation";
import type { CdpDomNode } from "./browser-use-cdp-dom";
import { READ_SUBMISSION_MESSAGES_FUNCTION } from "./browser-use-cdp-page-scripts";

// Native controls have browser-owned shadow roots even in an ordinary form.
// They do not hide author-defined receipts; author roots and child frames still do.
export function canInspectCf7ReceiptDocument(node: CdpDomNode): boolean {
	return (
		!node.contentDocument &&
		!["IFRAME", "FRAME"].includes(node.nodeName.toUpperCase()) &&
		!(node.shadowRoots ?? []).some(
			(root) => root.shadowRootType !== "user-agent",
		) &&
		(node.children ?? []).every(canInspectCf7ReceiptDocument)
	);
}

export interface Cf7ReceiptSnapshot {
	pendingGuidance: string[];
	confirmationCandidates: string[];
	sentMarker: boolean;
	responseEmpty: boolean;
	hadEnteredText: boolean;
	confirmation: string;
}

// Return a node, not an ID supplied by page markup. The driver pins its CDP backend ID.
export const GET_SUBMITTED_CF7_FORM_FUNCTION = `function() {
  // CF7_SUBMITTED_FORM
  const form = this.form;
  return form && form.isConnected && form.matches("form.wpcf7-form")
    && form.getRootNode() === form.ownerDocument ? form : null;
}`;

/** CF7 5.x clears the submitted form and adds both success markers on mail_sent. */
export const READ_CF7_SCOPED_RECEIPT_FUNCTION = `function(pattern, pendingPattern, failurePattern, previous) {
  // CF7_SCOPED_RECEIPT
  if (!this.isConnected || this.tagName !== "FORM" || !this.matches("form.wpcf7-form")
    || this.getRootNode() !== this.ownerDocument) return null;
  const outputs = Array.from(this.querySelectorAll(".wpcf7-response-output"));
  if (outputs.length !== 1 || outputs[0].closest("form") !== this) return null;
  const output = outputs[0];
  const body = this.ownerDocument.body;
  if (!body) return null;
  const read = (${READ_SUBMISSION_MESSAGES_FUNCTION});
  const global = read.call(body, pattern, pendingPattern, failurePattern, {});
  const local = read.call(output, pattern, pendingPattern, failurePattern, {});
  const textInputs = Array.from(this.querySelectorAll("input, textarea")).filter((input) =>
    input.tagName === "TEXTAREA" || ["text", "email", "tel", "url", "search", "number"].includes(input.type));
  const sentMarker = this.classList.contains("sent") && output.classList.contains("wpcf7-mail-sent-ok");
  const status = this.getAttribute("data-status");
  const failedState = ["invalid", "unaccepted", "spam", "aborted", "failed", "submitting"].some((name) => this.classList.contains(name))
    || (status !== null && status !== "sent");
  const responseEmpty = String(output.innerText || "").trim() === "";
  const hadEnteredText = textInputs.some((input) => String(input.value) !== "");
  const identity = (value) => value.replace(/\\s+/g, "").toLowerCase();
  const candidate = local.confirmation;
  const rect = output.getBoundingClientRect();
  let visible = rect.width > 0 && rect.height > 0;
  let ancestor = output;
  let depth = 0;
  while (ancestor && visible && depth++ < 100) {
    const style = getComputedStyle(ancestor);
    visible = !ancestor.hidden && !ancestor.inert && style.display !== "none"
      && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
    ancestor = ancestor.parentElement;
  }
  if (ancestor) visible = false;
  const bodyText = String(body.innerText || "");
  const outputText = String(output.innerText || "").trim();
  const outputIndex = outputText ? bodyText.indexOf(outputText) : -1;
  const exampleIntroduction = /(?:^|[\\r\\n])[ \\t]*(?:(?:次|以下)の(?:メッセージ|文言)が表示された場合[^。\\r\\n]{0,80}。|表示例[:：]?)[ \\t]*$/;
  const uniquelyVisibleResult = outputIndex >= 0 && bodyText.lastIndexOf(outputText) === outputIndex
    && !exampleIntroduction.test(bodyText.slice(Math.max(0, outputIndex - 160), outputIndex).trimEnd());
  const sameGuidance = previous && global.pendingGuidance.length > 0
    && global.pendingGuidance.length === previous.pendingGuidance.length
    && global.pendingGuidance.every((line) => previous.pendingGuidance.includes(line));
  const confirmation = previous && !previous.sentMarker && previous.responseEmpty && previous.hadEnteredText
    && sameGuidance && sentMarker && !failedState && visible && uniquelyVisibleResult && textInputs.length > 0 && !hadEnteredText
    && candidate && global.confirmationCandidates.includes(candidate)
    && !previous.confirmationCandidates.some((old) => identity(old) === identity(candidate))
    && !global.failure && !local.failure
    && !new RegExp(${JSON.stringify(SUBMISSION_INCOMPLETE_PATTERN)}, "i").test(String(body.innerText || ""))
    ? candidate : "";
  return { pendingGuidance: global.pendingGuidance, confirmationCandidates: global.confirmationCandidates,
    sentMarker, responseEmpty, hadEnteredText, confirmation };
}`;
