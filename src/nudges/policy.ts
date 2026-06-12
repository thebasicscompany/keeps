/**
 * Nudge cadence constants — the ONLY knobs for tuning nudge behavior in the
 * codebase. Change one constant here and re-run tests to retune the product.
 *
 * Rationale for defaults (Phase 3, Deliverable #6):
 *   - Founder ICP is in meetings all day; daily nudges feel noisy.
 *   - 24 h cooldown + 5/day cap means a heavy-state user gets at most a
 *     digest + 5 nudges = 6 outbound emails per day.
 *   - Candidate re-ask at 48 h lets the user ignore the first confirmation
 *     prompt but still get one follow-up.
 *   - 3-day default window keeps loops from going completely stale between
 *     sweeps without spamming.
 */

/** Minimum hours between successive nudges for the same loop. */
export const NUDGE_COOLDOWN_HOURS = 24;

/** Maximum nudge emails sent per user per local calendar day. Digest does NOT count. */
export const MAX_NUDGES_PER_USER_PER_DAY = 5;

/**
 * Hours after a `candidate` loop's `createdAt` before it is eligible for a
 * one-time re-ask nudge (only when `nudgeCount === 0`).
 */
export const CANDIDATE_RE_ASK_AFTER_HOURS = 48;

/**
 * Default number of days to advance `nextCheckAt` after a nudge is sent.
 * Status-specific overrides can be layered on top in `advanceNextCheckAt`.
 */
export const DEFAULT_NEXT_NUDGE_WINDOW_DAYS = 3;
