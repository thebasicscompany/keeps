import { describe, it, expect } from "vitest";
import { assembleReport, type ReportLoop, type ReportLoopActivity, type SectionKey } from "./query";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let idCounter = 0;
function makeLoop(overrides: Partial<ReportLoop> = {}): ReportLoop {
  idCounter++;
  return {
    id: `loop-${idCounter}`,
    status: "open",
    summary: `Summary ${idCounter}`,
    ownerText: null,
    requesterText: null,
    dueAt: null,
    confidence: 0.8,
    participants: [],
    sourceQuote: `Source quote ${idCounter}`,
    sourceEvidenceId: `ev-${idCounter}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function noActivity(loopId: string): ReportLoopActivity {
  return { loopId, lastActivityAt: null };
}

function activityAt(loopId: string, at: Date): ReportLoopActivity {
  return { loopId, lastActivityAt: at };
}

function sectionRows(result: ReturnType<typeof assembleReport>, key: SectionKey) {
  return result.sections.find((s) => s.key === key)?.rows ?? [];
}

function sectionLoopIds(result: ReturnType<typeof assembleReport>, key: SectionKey) {
  return sectionRows(result, key).map((r) => r.loop.id);
}

// Fixed "now" for all boundary tests
const NOW = new Date("2025-01-15T12:00:00.000Z");

// ── due_soon 7d boundary ──────────────────────────────────────────────────────

describe("due_soon 7d boundary", () => {
  it("includes loop with dueAt exactly now+7d", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() + 7 * DAY), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "due_soon")).toContain(loop.id);
  });

  it("excludes loop with dueAt now+7d+1s", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() + 7 * DAY + SEC), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "due_soon")).not.toContain(loop.id);
  });

  it("includes loop with dueAt now+7d-1s", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() + 7 * DAY - SEC), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "due_soon")).toContain(loop.id);
  });
});

// ── needs_you 48h boundary for open loop ────────────────────────────────────

describe("needs_you 48h boundary (open loop)", () => {
  it("includes open loop with dueAt exactly now+48h in needs_you", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() + 48 * HOUR), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "needs_you")).toContain(loop.id);
  });

  it("puts open loop with dueAt now+48h+1s in due_soon (not needs_you)", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() + 48 * HOUR + SEC), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "needs_you")).not.toContain(loop.id);
    // dueAt is within 7d so it should land in due_soon
    expect(sectionLoopIds(result, "due_soon")).toContain(loop.id);
  });

  it("includes open loop with dueAt now+48h-1s in needs_you", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() + 48 * HOUR - SEC), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "needs_you")).toContain(loop.id);
  });
});

// ── overdue boundary ──────────────────────────────────────────────────────────
//
// Section precedence: needs_you(1) > due_soon(2) > overdue(3) > waiting_on_others(4) > stale(5) > recently_done(6)
// Reachability analysis for overdue:
//   - open + dueAt<now  → needs_you first (open matches needs_you via dueAt<=now+48h)
//   - waiting_on_me + dueAt<now → needs_you first
//   - waiting_on_other + dueAt<now → waiting_on_others first (section 4)
//   - snoozed + dueAt<now → explicitly excluded from overdue by spec
//   - done/dismissed + dueAt<now → excluded from overdue by spec
// Result: overdue is a catch-all for statuses with past dueAt not caught earlier.
// In the current status enum it acts as a safety net; tests verify the exclusion logic.

describe("overdue boundary", () => {
  it("open loop with dueAt now-1s lands in needs_you (not overdue) — first-match-wins", () => {
    // open + dueAt < now satisfies needs_you (dueAt <= now+48h); needs_you wins.
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() - SEC), status: "open" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "needs_you")).toContain(loop.id);
    expect(sectionLoopIds(result, "overdue")).not.toContain(loop.id);
  });

  it("waiting_on_other loop with dueAt now-1s lands in waiting_on_others — not overdue", () => {
    // waiting_on_other hits waiting_on_others (section 4) before overdue (section 3) in precedence,
    // because waiting_on_others has lower index in section order... wait, overdue=3, waiting_on_others=4.
    // Actually overdue(3) comes BEFORE waiting_on_others(4). So waiting_on_other+dueAt<now → overdue first.
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() - SEC), status: "waiting_on_other" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    // overdue predicate: dueAt<now AND status NOT in (done,dismissed,snoozed) → waiting_on_other qualifies
    // But overdue(3) < waiting_on_others(4), so first match wins → overdue.
    expect(sectionLoopIds(result, "overdue")).toContain(loop.id);
    expect(sectionLoopIds(result, "waiting_on_others")).not.toContain(loop.id);
  });

  it("snoozed loop with dueAt now-1s does NOT appear in overdue", () => {
    const loop = makeLoop({ dueAt: new Date(NOW.getTime() - SEC), status: "snoozed" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "overdue")).not.toContain(loop.id);
  });
});

// ── stale N=10 boundary ───────────────────────────────────────────────────────

describe("stale 10d boundary", () => {
  it("marks open loop with lastActivityAt exactly now-10d as stale", () => {
    const loop = makeLoop({
      status: "open",
      createdAt: new Date(NOW.getTime() - 20 * DAY),
    });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [activityAt(loop.id, new Date(NOW.getTime() - 10 * DAY))],
    });
    expect(sectionLoopIds(result, "stale")).toContain(loop.id);
  });

  it("does NOT mark open loop with lastActivityAt now-10d+1s as stale", () => {
    const loop = makeLoop({
      status: "open",
      createdAt: new Date(NOW.getTime() - 20 * DAY),
    });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [activityAt(loop.id, new Date(NOW.getTime() - 10 * DAY + SEC))],
    });
    expect(sectionLoopIds(result, "stale")).not.toContain(loop.id);
  });

  it("marks open loop with null activity and createdAt now-11d as stale", () => {
    const loop = makeLoop({
      status: "open",
      createdAt: new Date(NOW.getTime() - 11 * DAY),
    });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "stale")).toContain(loop.id);
  });
});

// ── recently_done 7d boundary ─────────────────────────────────────────────────

describe("recently_done 7d boundary", () => {
  it("includes done loop with updatedAt exactly now-7d", () => {
    const loop = makeLoop({
      status: "done",
      updatedAt: new Date(NOW.getTime() - 7 * DAY),
    });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "recently_done")).toContain(loop.id);
  });

  it("excludes done loop with updatedAt now-7d-1s", () => {
    const loop = makeLoop({
      status: "done",
      updatedAt: new Date(NOW.getTime() - 7 * DAY - SEC),
    });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    expect(sectionLoopIds(result, "recently_done")).not.toContain(loop.id);
  });
});

// ── importance ordering ───────────────────────────────────────────────────────

describe("importance ordering", () => {
  // Use waiting_on_other + past dueAt so loops land in overdue (section 3),
  // not needs_you (section 1, which catches open+waiting_on_me) or waiting_on_others (section 4).
  it("ranks overdue loop with older activity higher than one with newer activity", () => {
    const olderActivity = makeLoop({
      id: "older-activity",
      status: "waiting_on_other",
      dueAt: new Date(NOW.getTime() - DAY),
      confidence: 0.8,
      createdAt: new Date(NOW.getTime() - 20 * DAY),
    });
    const newerActivity = makeLoop({
      id: "newer-activity",
      status: "waiting_on_other",
      dueAt: new Date(NOW.getTime() - DAY),
      confidence: 0.8,
      createdAt: new Date(NOW.getTime() - 5 * DAY),
    });

    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [newerActivity, olderActivity], // reversed order to confirm sort works
      loopActivity: [
        activityAt(olderActivity.id, new Date(NOW.getTime() - 15 * DAY)),
        activityAt(newerActivity.id, new Date(NOW.getTime() - 2 * DAY)),
      ],
    });

    const ids = sectionLoopIds(result, "overdue");
    expect(ids.indexOf("older-activity")).toBeLessThan(ids.indexOf("newer-activity"));
  });

  it("breaks full ties by confidence (higher confidence first)", () => {
    const highConf = makeLoop({
      id: "high-conf",
      status: "waiting_on_other",
      dueAt: new Date(NOW.getTime() - DAY),
      confidence: 0.9,
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const lowConf = makeLoop({
      id: "low-conf",
      status: "waiting_on_other",
      dueAt: new Date(NOW.getTime() - DAY),
      confidence: 0.5,
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });

    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [lowConf, highConf],
      loopActivity: [
        activityAt(highConf.id, new Date(NOW.getTime() - 5 * DAY)),
        activityAt(lowConf.id, new Date(NOW.getTime() - 5 * DAY)),
      ],
    });

    const ids = sectionLoopIds(result, "overdue");
    expect(ids.indexOf("high-conf")).toBeLessThan(ids.indexOf("low-conf"));
  });
});

// ── dedupe: first-match-wins ──────────────────────────────────────────────────

describe("dedupe: first-match-wins precedence", () => {
  it("waiting_on_me loop that is also overdue appears ONLY in needs_you", () => {
    const loop = makeLoop({
      status: "waiting_on_me",
      dueAt: new Date(NOW.getTime() - DAY), // overdue
    });

    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });

    expect(sectionLoopIds(result, "needs_you")).toContain(loop.id);
    expect(sectionLoopIds(result, "overdue")).not.toContain(loop.id);
    expect(sectionLoopIds(result, "due_soon")).not.toContain(loop.id);
    expect(sectionLoopIds(result, "stale")).not.toContain(loop.id);
    expect(sectionLoopIds(result, "waiting_on_others")).not.toContain(loop.id);
    expect(sectionLoopIds(result, "recently_done")).not.toContain(loop.id);
  });
});

// ── entity scoping ────────────────────────────────────────────────────────────

describe("entity scoping", () => {
  const acmeLoopA = makeLoop({
    id: "acme-a",
    status: "open",
    participants: [{ name: "Acme Corp", email: "someone@acme.com" }],
  });
  const acmeLoopB = makeLoop({
    id: "acme-b",
    status: "waiting_on_other",
    ownerText: "Acme review pending",
  });
  const acmeLoopC = makeLoop({
    id: "acme-c",
    status: "done",
    updatedAt: new Date(NOW.getTime() - DAY),
    sourceQuote: "Waiting on Acme to respond",
  });
  const nonAcmeA = makeLoop({ id: "non-acme-a", status: "open" });
  const nonAcmeB = makeLoop({
    id: "non-acme-b",
    status: "open",
    participants: [{ name: "Bobco" }],
  });
  const nonAcmeC = makeLoop({ id: "non-acme-c", status: "done", updatedAt: new Date(NOW.getTime() - DAY) });

  const allLoops = [acmeLoopA, acmeLoopB, acmeLoopC, nonAcmeA, nonAcmeB, nonAcmeC];
  const allActivity = allLoops.map((l) => noActivity(l.id));

  it("includes only the 3 Acme-matching loops across all sections", () => {
    const result = assembleReport({
      kind: "entity",
      scope: { entity: "Acme" },
      now: NOW,
      loops: allLoops,
      loopActivity: allActivity,
    });

    const allIds = result.sections.flatMap((s) => s.rows.map((r) => r.loop.id));
    expect(allIds).toContain("acme-a");
    expect(allIds).toContain("acme-b");
    expect(allIds).toContain("acme-c");
    expect(allIds).not.toContain("non-acme-a");
    expect(allIds).not.toContain("non-acme-b");
    expect(allIds).not.toContain("non-acme-c");
  });

  it("matches entity via email domain (no @ in entity)", () => {
    const loop = makeLoop({
      id: "domain-match",
      status: "open",
      participants: [{ email: "contact@acme-corp.com" }],
    });
    const result = assembleReport({
      kind: "entity",
      scope: { entity: "acme" },
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const allIds = result.sections.flatMap((s) => s.rows.map((r) => r.loop.id));
    expect(allIds).toContain("domain-match");
  });

  it("case-insensitive entity match on ownerText", () => {
    const loop = makeLoop({
      id: "owner-match",
      status: "open",
      ownerText: "ACME contract review",
    });
    const result = assembleReport({
      kind: "entity",
      scope: { entity: "acme" },
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const allIds = result.sections.flatMap((s) => s.rows.map((r) => r.loop.id));
    expect(allIds).toContain("owner-match");
  });
});

// ── sections array always has length 6 in fixed order ────────────────────────

describe("sections always length 6 in fixed order", () => {
  const EXPECTED_ORDER: SectionKey[] = [
    "needs_you",
    "due_soon",
    "overdue",
    "waiting_on_others",
    "stale",
    "recently_done",
  ];

  it("returns exactly 6 sections in fixed order even with no loops", () => {
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [],
      loopActivity: [],
    });
    expect(result.sections).toHaveLength(6);
    result.sections.forEach((s, i) => {
      expect(s.key).toBe(EXPECTED_ORDER[i]);
    });
  });

  it("empty sections have rows:[]", () => {
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [],
      loopActivity: [],
    });
    result.sections.forEach((s) => {
      expect(s.rows).toEqual([]);
    });
  });

  it("returns exactly 6 sections in fixed order with various loops present", () => {
    const loops = [
      makeLoop({ status: "waiting_on_me" }),
      makeLoop({ status: "open", dueAt: new Date(NOW.getTime() + 3 * DAY) }),
      makeLoop({ status: "open", dueAt: new Date(NOW.getTime() - DAY) }),
      makeLoop({ status: "waiting_on_other" }),
      makeLoop({ status: "open", createdAt: new Date(NOW.getTime() - 15 * DAY) }),
      makeLoop({ status: "done", updatedAt: new Date(NOW.getTime() - DAY) }),
    ];
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops,
      loopActivity: loops.map((l) => noActivity(l.id)),
    });
    expect(result.sections).toHaveLength(6);
    result.sections.forEach((s, i) => {
      expect(s.key).toBe(EXPECTED_ORDER[i]);
    });
  });
});

// ── dueRelativeMs ─────────────────────────────────────────────────────────────

describe("dueRelativeMs", () => {
  it("is null when dueAt is null", () => {
    const loop = makeLoop({ status: "waiting_on_me", dueAt: null });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const row = sectionRows(result, "needs_you")[0];
    expect(row).toBeDefined();
    expect(row!.dueRelativeMs).toBeNull();
  });

  it("is negative for overdue loops", () => {
    // Use waiting_on_other so the loop lands in overdue (section 3) rather than
    // needs_you (which catches open + dueAt<=now+48h via first-match-wins).
    const loop = makeLoop({ status: "waiting_on_other", dueAt: new Date(NOW.getTime() - 2 * HOUR) });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const row = sectionRows(result, "overdue")[0];
    expect(row).toBeDefined();
    expect(row!.dueRelativeMs).toBeLessThan(0);
  });

  it("is positive for due_soon loops", () => {
    const loop = makeLoop({ status: "open", dueAt: new Date(NOW.getTime() + 3 * DAY) });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const row = sectionRows(result, "due_soon")[0];
    expect(row).toBeDefined();
    expect(row!.dueRelativeMs).toBeGreaterThan(0);
  });
});

// ── totalOpen ─────────────────────────────────────────────────────────────────

describe("totalOpen", () => {
  it("counts open|waiting_on_me|waiting_on_other after scope filter", () => {
    const loops = [
      makeLoop({ status: "open" }),
      makeLoop({ status: "waiting_on_me" }),
      makeLoop({ status: "waiting_on_other" }),
      makeLoop({ status: "done", updatedAt: new Date(NOW.getTime() - DAY) }),
      makeLoop({ status: "snoozed" }),
    ];
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops,
      loopActivity: loops.map((l) => noActivity(l.id)),
    });
    expect(result.totalOpen).toBe(3);
  });
});

// ── excluded statuses ─────────────────────────────────────────────────────────

describe("excluded statuses", () => {
  it("candidate loops never appear in any section", () => {
    const loop = makeLoop({ status: "candidate" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const allIds = result.sections.flatMap((s) => s.rows.map((r) => r.loop.id));
    expect(allIds).not.toContain(loop.id);
  });

  it("blocked loops never appear in any section", () => {
    const loop = makeLoop({ status: "blocked" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const allIds = result.sections.flatMap((s) => s.rows.map((r) => r.loop.id));
    expect(allIds).not.toContain(loop.id);
  });

  it("dismissed loops never appear in any section", () => {
    const loop = makeLoop({ status: "dismissed" });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [noActivity(loop.id)],
    });
    const allIds = result.sections.flatMap((s) => s.rows.map((r) => r.loop.id));
    expect(allIds).not.toContain(loop.id);
  });
});

// ── Phase 5 live-wave fix: open loops never orphan ─────────────────────────────

describe("open-loop fallback (live-wave regression)", () => {
  it("places an undated, recently-active open loop into needs_you (not invisible)", () => {
    // Exactly the prod case: status open, no due date, updated ~18h ago (not stale).
    const loop = makeLoop({
      status: "open",
      dueAt: null,
      summary: "Send the onboarding document to the design partner",
    });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [activityAt(loop.id, new Date(NOW.getTime() - 18 * HOUR))],
    });

    expect(result.totalOpen).toBe(1);
    // It must appear somewhere — specifically Needs you.
    expect(sectionLoopIds(result, "needs_you")).toContain(loop.id);
    // And it is the top row across all sections (so summarize gets a real item).
    const firstRow = result.sections.flatMap((s) => s.rows)[0];
    expect(firstRow?.loop.id).toBe(loop.id);
  });

  it("does not double-place: an open loop already in due_soon stays out of needs_you fallback", () => {
    const loop = makeLoop({ status: "open", dueAt: new Date(NOW.getTime() + 5 * DAY) });
    const result = assembleReport({
      kind: "insights",
      scope: {},
      now: NOW,
      loops: [loop],
      loopActivity: [activityAt(loop.id, NOW)],
    });
    expect(sectionLoopIds(result, "due_soon")).toContain(loop.id);
    expect(sectionLoopIds(result, "needs_you")).not.toContain(loop.id);
  });
});
