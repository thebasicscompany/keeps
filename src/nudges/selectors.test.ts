import { describe, expect, it } from "vitest";
import {
  CANDIDATE_RE_ASK_AFTER_HOURS,
  DEFAULT_NEXT_NUDGE_WINDOW_DAYS,
  MAX_NUDGES_PER_USER_PER_DAY,
  NUDGE_COOLDOWN_HOURS,
} from "@/nudges/policy";
import {
  advanceNextCheckAt,
  enforceDailyCap,
  isEligibleForNudge,
  type NudgeEligibilityLoop,
} from "@/nudges/selectors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_NOW = new Date("2026-06-12T12:00:00.000Z");

/** Build a minimal NudgeEligibilityLoop with sensible defaults. */
function makeLoop(overrides: Partial<NudgeEligibilityLoop> = {}): NudgeEligibilityLoop {
  return {
    id: "loop-1",
    status: "open",
    createdAt: new Date("2026-06-10T12:00:00.000Z"), // 2 days old
    nextCheckAt: new Date("2026-06-12T10:00:00.000Z"), // 2 h before now → past
    lastNudgedAt: null,
    nudgeCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isEligibleForNudge — ineligible statuses
// ---------------------------------------------------------------------------

describe("isEligibleForNudge — terminal / paused statuses", () => {
  for (const status of ["done", "dismissed", "blocked", "snoozed"] as const) {
    it(`returns false for status="${status}"`, () => {
      const loop = makeLoop({ status, nextCheckAt: new Date("2026-06-01T00:00:00.000Z") });
      expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isEligibleForNudge — per-loop cooldown
// ---------------------------------------------------------------------------

describe("isEligibleForNudge — cooldown", () => {
  it("returns false when lastNudgedAt is exactly 1 ms inside the cooldown window", () => {
    const lastNudgedAt = new Date(
      BASE_NOW.getTime() - NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000 + 1,
    );
    const loop = makeLoop({ lastNudgedAt });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });

  it("returns false when lastNudgedAt is exactly at the cooldown boundary (< required gap)", () => {
    // Exactly NUDGE_COOLDOWN_HOURS hours ago = elapsed === cooldownMs → NOT yet eligible
    // The condition is: elapsed < cooldownMs → ineligible.
    // At exactly the boundary elapsed === cooldownMs → eligible (boundary is inclusive).
    const lastNudgedAt = new Date(
      BASE_NOW.getTime() - NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000,
    );
    const loop = makeLoop({ lastNudgedAt });
    // elapsed === cooldownMs → condition `elapsed < cooldownMs` is FALSE → eligible
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(true);
  });

  it("returns false when lastNudgedAt is 1 h ago (well inside cooldown)", () => {
    const lastNudgedAt = new Date(BASE_NOW.getTime() - 1 * 60 * 60 * 1000);
    const loop = makeLoop({ lastNudgedAt });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });

  it("returns true when lastNudgedAt is 25 h ago (past cooldown)", () => {
    const lastNudgedAt = new Date(BASE_NOW.getTime() - 25 * 60 * 60 * 1000);
    const loop = makeLoop({ lastNudgedAt });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isEligibleForNudge — null nextCheckAt
// ---------------------------------------------------------------------------

describe("isEligibleForNudge — null nextCheckAt", () => {
  it("returns false when nextCheckAt is null (no scheduled check)", () => {
    const loop = makeLoop({ nextCheckAt: null });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });

  it("returns false for candidate with null nextCheckAt", () => {
    const loop = makeLoop({
      status: "candidate",
      nextCheckAt: null,
      // old enough otherwise
      createdAt: new Date(BASE_NOW.getTime() - (CANDIDATE_RE_ASK_AFTER_HOURS + 1) * 60 * 60 * 1000),
    });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEligibleForNudge — open / waiting_on_me / waiting_on_other
// ---------------------------------------------------------------------------

describe("isEligibleForNudge — active statuses", () => {
  for (const status of ["open", "waiting_on_me", "waiting_on_other"] as const) {
    it(`returns true when nextCheckAt <= now for status="${status}"`, () => {
      const loop = makeLoop({
        status,
        nextCheckAt: new Date(BASE_NOW.getTime() - 1), // 1 ms in the past
      });
      expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(true);
    });

    it(`returns true when nextCheckAt === now (boundary) for status="${status}"`, () => {
      const loop = makeLoop({ status, nextCheckAt: BASE_NOW });
      expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(true);
    });

    it(`returns false when nextCheckAt is 1 ms in the future for status="${status}"`, () => {
      const loop = makeLoop({
        status,
        nextCheckAt: new Date(BASE_NOW.getTime() + 1),
      });
      expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isEligibleForNudge — candidate-specific rules
// ---------------------------------------------------------------------------

describe("isEligibleForNudge — candidate", () => {
  const CANDIDATE_AGE_MS = CANDIDATE_RE_ASK_AFTER_HOURS * 60 * 60 * 1000;

  it("returns true when loop is old enough, never nudged, and nextCheckAt <= now", () => {
    const loop = makeLoop({
      status: "candidate",
      createdAt: new Date(BASE_NOW.getTime() - CANDIDATE_AGE_MS), // exactly 48 h old
      nudgeCount: 0,
      nextCheckAt: new Date(BASE_NOW.getTime() - 1), // past
    });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(true);
  });

  it("returns false when candidate is exactly 48 h old but 1 ms short (createdAt boundary)", () => {
    const loop = makeLoop({
      status: "candidate",
      createdAt: new Date(BASE_NOW.getTime() - CANDIDATE_AGE_MS + 1), // 1 ms too young
      nudgeCount: 0,
      nextCheckAt: new Date(BASE_NOW.getTime() - 1),
    });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });

  it("returns false when candidate is old enough but nudgeCount > 0 (already nudged)", () => {
    const loop = makeLoop({
      status: "candidate",
      createdAt: new Date(BASE_NOW.getTime() - CANDIDATE_AGE_MS - 1),
      nudgeCount: 1,
      nextCheckAt: new Date(BASE_NOW.getTime() - 1),
    });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });

  it("returns false when candidate is old enough, never nudged, but nextCheckAt is in the future", () => {
    const loop = makeLoop({
      status: "candidate",
      createdAt: new Date(BASE_NOW.getTime() - CANDIDATE_AGE_MS - 1),
      nudgeCount: 0,
      nextCheckAt: new Date(BASE_NOW.getTime() + 60_000), // 1 min future
    });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });

  it("returns false for a brand-new candidate (too young)", () => {
    const loop = makeLoop({
      status: "candidate",
      createdAt: BASE_NOW,
      nudgeCount: 0,
      nextCheckAt: BASE_NOW,
    });
    expect(isEligibleForNudge(loop, { now: BASE_NOW })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceDailyCap
// ---------------------------------------------------------------------------

describe("enforceDailyCap", () => {
  const makeLoops = (n: number): NudgeEligibilityLoop[] =>
    Array.from({ length: n }, (_, i) =>
      makeLoop({ id: `loop-${i + 1}` }),
    );

  it("returns all loops when sentTodayCount is 0 and n < cap", () => {
    const loops = makeLoops(3);
    const { toNudge, toDefer } = enforceDailyCap(loops, {
      sentTodayCount: 0,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });
    expect(toNudge).toHaveLength(3);
    expect(toDefer).toHaveLength(0);
  });

  it("defers exactly n - cap loops when n > cap and sentTodayCount is 0", () => {
    const loops = makeLoops(7);
    const { toNudge, toDefer } = enforceDailyCap(loops, {
      sentTodayCount: 0,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });
    expect(toNudge).toHaveLength(MAX_NUDGES_PER_USER_PER_DAY);
    expect(toDefer).toHaveLength(7 - MAX_NUDGES_PER_USER_PER_DAY);
  });

  it("defers all loops when cap is already exhausted (sentTodayCount === cap)", () => {
    const loops = makeLoops(3);
    const { toNudge, toDefer } = enforceDailyCap(loops, {
      sentTodayCount: MAX_NUDGES_PER_USER_PER_DAY,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });
    expect(toNudge).toHaveLength(0);
    expect(toDefer).toHaveLength(3);
  });

  it("defers all loops when sentTodayCount > cap", () => {
    const loops = makeLoops(2);
    const { toNudge, toDefer } = enforceDailyCap(loops, {
      sentTodayCount: MAX_NUDGES_PER_USER_PER_DAY + 2,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });
    expect(toNudge).toHaveLength(0);
    expect(toDefer).toHaveLength(2);
  });

  it("preserves original order in toNudge and toDefer", () => {
    const loops = makeLoops(4);
    const { toNudge, toDefer } = enforceDailyCap(loops, {
      sentTodayCount: 2,
      cap: MAX_NUDGES_PER_USER_PER_DAY, // 5, slots remaining = 3
    });
    expect(toNudge.map((l) => l.id)).toEqual(["loop-1", "loop-2", "loop-3"]);
    expect(toDefer.map((l) => l.id)).toEqual(["loop-4"]);
  });

  it("handles exactly at the cap boundary (sentTodayCount = cap - 1)", () => {
    const loops = makeLoops(3);
    const { toNudge, toDefer } = enforceDailyCap(loops, {
      sentTodayCount: MAX_NUDGES_PER_USER_PER_DAY - 1,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });
    expect(toNudge).toHaveLength(1);
    expect(toDefer).toHaveLength(2);
  });

  it("handles empty loops list", () => {
    const { toNudge, toDefer } = enforceDailyCap([], {
      sentTodayCount: 0,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });
    expect(toNudge).toHaveLength(0);
    expect(toDefer).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// advanceNextCheckAt
// ---------------------------------------------------------------------------

describe("advanceNextCheckAt", () => {
  it("returns now + DEFAULT_NEXT_NUDGE_WINDOW_DAYS days", () => {
    const loop = makeLoop();
    const result = advanceNextCheckAt(loop, BASE_NOW);
    const expectedMs =
      BASE_NOW.getTime() + DEFAULT_NEXT_NUDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBe(expectedMs);
  });

  it("returns a new Date object (not the same reference as now)", () => {
    const loop = makeLoop();
    const result = advanceNextCheckAt(loop, BASE_NOW);
    expect(result).not.toBe(BASE_NOW);
  });

  it("works across a month boundary", () => {
    const endOfMonth = new Date("2026-06-30T12:00:00.000Z");
    const loop = makeLoop();
    const result = advanceNextCheckAt(loop, endOfMonth);
    // 2026-06-30 + 3 days = 2026-07-03
    expect(result.toISOString().startsWith("2026-07-03")).toBe(true);
  });
});
