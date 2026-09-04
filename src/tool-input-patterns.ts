/**
 * The shapes the model-facing tool inputs are allowed to take. The tool schema
 * advertises them to the provider and the trusted handlers re-check them on the
 * way in, so a single definition keeps the advertised contract and the enforced
 * one from drifting apart: a pattern widened in only one place would either
 * reject inputs the schema promised to accept or accept inputs it never
 * advertised. The module stays dependency-free so both sides can import it.
 */

/** An `elementId` handed out by observe and accepted by the element tools. */
export const ELEMENT_ID_PATTERN = /^fa-[a-z0-9-]+$/;

/** How `submit` may activate a submit control. */
export const SUBMIT_ACTIVATION_STRATEGIES = ["dom", "mouse", "enter"] as const;
