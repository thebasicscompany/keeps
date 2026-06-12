/**
 * Pure selector functions for nudge eligibility and scheduling.
 *
 * All time-dependent functions take an injected `now: Date` argument so they
 * are fully unit-testable without mocking global `Date`.
 *
 * NOTE: NudgeEligibilityLoop is a LOCAL structural type — do NOT import Loop
 * from @/db/schema here. Another agent is extending that type in parallel.
 */

import {
  CANDIDATE_RE_ASK_AFTER_HOURS,
  DEFAULT_NEXT_NUDGE_WINDOW_DAYS,
  NUDGE_COOLDOWN_HOURS,
} from "@/nudges/policy";

/**
 * Structural type used by the nudge selector functions. Mirrors the columns
 * that will exist on `loops` after the Phase 3 A1 migration, but is kept
 * local so A3 and A1 can land in parallel without import coupling.
 */
export type NudgeEligibilityLoop = {
  id: string;
  status: string;
  createdAt: Date;
  nextCheckAt: Date | null;
  lastNudgedAt: Date | null;
  nudgeCount: number;
};

/** Statuses that are terminal or paused — never nudge these. */
const INELIGIBLE_STATUSES = new Set(["done", "dismissed", "blocked", "snoozed"]);

/**
 * Returns true when a loop should receive a nudge right now.
 *
 * Rules (Deliverable #6):
 * 1. Terminal/paused statuses (`done`, `dismissed`, `blocked`, `snoozed`) → never eligible.
 * 2. Per-loop cooldown: ineligible if `lastNudgedAt` is within the last
 *    `NUDGE_COOLDOWN_HOURS` hours.
 * 3. A null `nextCheckAt` is NEVER eligible (no scheduled check window).
 * 4. `candidate`: eligible only if `createdAt` is older than
 *    `CANDIDATE_RE_ASK_AFTER_HOURS` AND `nudgeCount === 0` AND
 *    `nextCheckAt <= now`.
 * 5. `open`, `waiting_on_me`, `waiting_on_other`: eligible when
 *    `nextCheckAt` is non-null and `<= now`.
 */
export function isEligibleForNudge(
  loop: NudgeEligibilityLoop,
  options: { now: Date },
): boolean {
  const { now } = options;

  // Rule 1 — terminal / paused status
  if (INELIGIBLE_STATUSES.has(loop.status)) {
    return false;
  }

  // Rule 2 — per-loop cooldown
  if (loop.lastNudgedAt !== null) {
    const cooldownMs = NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (now.getTime() - loop.lastNudgedAt.getTime() < cooldownMs) {
      return false;
    }
  }

  // Rule 3 — null nextCheckAt is never eligible
  if (loop.nextCheckAt === null) {
    return false;
  }

  // Rule 4 — candidate re-ask
  if (loop.status === "candidate") {
    const ageMs = now.getTime() - loop.createdAt.getTime();
    const requiredAgeMs = CANDIDATE_RE_ASK_AFTER_HOURS * 60 * 60 * 1000;
    const ageOk = ageMs >= requiredAgeMs;
    const neverNudged = loop.nudgeCount === 0;
    const windowOpen = loop.nextCheckAt.getTime() <= now.getTime();
    return ageOk && neverNudged && windowOpen;
  }

  // Rule 5 — open / waiting_on_me / waiting_on_other (and any future active status)
  return loop.nextCheckAt.getTime() <= now.getTime();
}

/**
 * Splits an ordered list of eligible loops into those that will be nudged and
 * those that will be deferred, honouring the per-user daily cap.
 *
 * @param loops     Loops already filtered to eligible (via `isEligibleForNudge`).
 * @param options
 *   - `sentTodayCount` — nudges already sent to this user today (from the DB).
 *   - `cap`            — max nudges per day (default: `MAX_NUDGES_PER_USER_PER_DAY`).
 * @returns `{ toNudge, toDefer }` — original order is preserved.
 */
export function enforceDailyCap<T extends NudgeEligibilityLoop>(
  loops: T[],
  options: { sentTodayCount: number; cap: number },
): { toNudge: T[]; toDefer: T[] } {
  const { sentTodayCount, cap } = options;
  const remainingSlots = Math.max(0, cap - sentTodayCount);

  return {
    toNudge: loops.slice(0, remainingSlots),
    toDefer: loops.slice(remainingSlots),
  };
}

/**
 * Returns the UTC `Date` at which a loop's next check window should open
 * after a nudge has been sent.
 *
 * Currently uses `DEFAULT_NEXT_NUDGE_WINDOW_DAYS` for all statuses; this
 * function is the single place to later introduce status-specific overrides
 * without touching call sites.
 */
export function advanceNextCheckAt(
  _loop: NudgeEligibilityLoop,
  now: Date,
): Date {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + DEFAULT_NEXT_NUDGE_WINDOW_DAYS);
  return next;
}
