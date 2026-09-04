export const MAX_TURNS = 40;

/**
 * Extra turns granted once, after a denied pre-submit review, so the agent can
 * still fill, observe, and submit even when the denial lands on a late turn.
 */
export const CORRECTION_TURNS = 3;

/**
 * One provider request per agent turn, plus the correction turns, plus at most
 * two pre-submit reviews (the first denial allows exactly one correction). The
 * counter is shared by the executor and the reviewer through D1, so both
 * consume the same budget.
 */
export const MAX_PROVIDER_REQUESTS = MAX_TURNS + CORRECTION_TURNS + 2;
