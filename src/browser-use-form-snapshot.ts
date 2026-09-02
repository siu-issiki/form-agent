/**
 * Page-side description of the form a submission is about to activate.
 *
 * The snapshot exists so that the state a reviewer judged can be compared with
 * the state that is actually submitted. It is built inside the page for two
 * reasons: the DOM `form.elements` collection is the only complete, ordered
 * view of a form (hidden, disabled, and `form`-attribute associated controls
 * included), and the same source can be evaluated together with the click in
 * one call, leaving no window for a page script to run in between.
 *
 * There is exactly one implementation of the canonical form, shared by the
 * read and the activation entry points, so the two can never drift apart.
 */

/** Matches the observation limit, so both views truncate the page alike. */
export const MAX_PAGE_TEXT = 20_000;

const MAX_SNAPSHOT_TEXT = 200;

/**
 * Builds `snapshot` from `this` (a submit control) and `extras`, or leaves it
 * null when the control owns no form. Everything a reviewer can see is
 * included: the form's target, every control's value and metadata, and the
 * document text that carries prohibition wording.
 */
const FORM_SNAPSHOT_SOURCE = `
  const snapshotForm = this.form;
  let snapshot = null;
  if (snapshotForm) {
    const snapshotText = (node) => {
      const value = node && typeof node.textContent === "string" ? node.textContent : "";
      return value.replace(/\\s+/g, " ").trim().slice(0, ${MAX_SNAPSHOT_TEXT});
    };
    const snapshotAttribute = (node, name) => {
      if (!node || typeof node.getAttribute !== "function") return "";
      const value = node.getAttribute(name);
      return typeof value === "string" ? value : "";
    };
    const snapshotLabel = (node) => {
      const aria = snapshotAttribute(node, "aria-label").trim();
      if (aria) return aria.slice(0, ${MAX_SNAPSHOT_TEXT});
      const labelledBy = snapshotAttribute(node, "aria-labelledby").trim();
      const ownerDocument = node ? node.ownerDocument : null;
      if (labelledBy && ownerDocument && typeof ownerDocument.getElementById === "function") {
        const parts = [];
        for (const id of labelledBy.split(/\\s+/)) {
          const referenced = ownerDocument.getElementById(id);
          if (referenced) parts.push(snapshotText(referenced));
        }
        if (parts.length > 0) return parts.join(" ").slice(0, ${MAX_SNAPSHOT_TEXT});
      }
      const labels = node ? node.labels : null;
      if (labels && labels.length > 0) return snapshotText(labels[0]);
      const closest = node && typeof node.closest === "function" ? node.closest("label") : null;
      return closest ? snapshotText(closest) : "";
    };
    const snapshotControls = [];
    const snapshotElements = snapshotForm.elements
      ? Array.prototype.slice.call(snapshotForm.elements)
      : [];
    for (const element of snapshotElements) {
      const tag = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
      const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
      const options = [];
      if (tag === "select" && element.options) {
        for (const option of Array.prototype.slice.call(element.options)) {
          options.push([
            typeof option.value === "string" ? option.value : "",
            snapshotText(option),
            option.selected === true,
          ]);
        }
      }
      snapshotControls.push([
        tag,
        type,
        typeof element.name === "string" ? element.name : "",
        type === "password" || !(typeof element.value === "string") ? "" : element.value,
        element.checked === true,
        element.disabled === true,
        element.required === true,
        snapshotLabel(element),
        options,
      ]);
    }
    const snapshotBody = this.ownerDocument ? this.ownerDocument.body : null;
    const snapshotPageText =
      snapshotBody && typeof snapshotBody.innerText === "string"
        ? snapshotBody.innerText.slice(0, ${MAX_PAGE_TEXT})
        : "";
    snapshot = JSON.stringify([
      typeof snapshotForm.action === "string" ? snapshotForm.action : "",
      typeof snapshotForm.method === "string" ? snapshotForm.method.toLowerCase() : "",
      typeof snapshotForm.enctype === "string" ? snapshotForm.enctype : "",
      typeof snapshotForm.target === "string" ? snapshotForm.target : "",
      Array.isArray(extras) ? extras : [],
      snapshotControls,
      snapshotPageText,
    ]);
  }`;

/** Reads the snapshot without touching the page. */
export const READ_FORM_SNAPSHOT_FUNCTION = `function(extras) {${FORM_SNAPSHOT_SOURCE}
  return snapshot;
}`;

/**
 * Compares the live form against the snapshot the reviewer approved and, only
 * on an exact match, activates the control. Both happen in one synchronous
 * call so no page script can change the form in between.
 */
export const ACTIVATE_SUBMIT_FUNCTION = `function(input, expectedAction, expectedMethod, expectedSnapshot, extras) {${FORM_SNAPSHOT_SOURCE}
  if (typeof expectedSnapshot !== "string" || snapshot !== expectedSnapshot) return false;
  if (!this.isConnected || this.disabled || !this.form || !input?.isConnected || input.form !== this.form) return false;
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
