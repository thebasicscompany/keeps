import { describe, it, expect } from "vitest";
import { buildDigest } from "@/digests/build";
import { renderDigestEmail } from "@/digests/render";
import type { DigestLoopInput, DigestUserInput } from "@/digests/build";

// ---- fixtures ---------------------------------------------------------------

const USER: DigestUserInput = {
  id: "user-1",
  email: "arav@example.com",
  displayName: "Arav",
};

const NOW = new Date("2026-06-12T09:00:00Z");

const plus1h = new Date(NOW.getTime() + 1 * 60 * 60 * 1000);
const plus12h = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
const plus60h = new Date(NOW.getTime() + 60 * 60 * 60 * 1000);
const minus1h = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
const minus8d = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
const minus12h = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);

function makeLoop(overrides: Partial<DigestLoopInput> & { id: string }): DigestLoopInput {
  return {
    emailThreadId: "thread-1",
    status: "open",
    summary: "A loop",
    dueAt: null,
    nextCheckAt: null,
    updatedAt: NOW,
    lastNudgedAt: null,
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe("renderDigestEmail — roadmap UX sample", () => {
  it("matches the roadmap UX sample shape and tone", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({
        id: "acme",
        status: "open",
        summary: "Acme discount decision is due today.",
        dueAt: plus1h,
        emailThreadId: "t1",
      }),
      makeLoop({
        id: "maya-deck",
        status: "waiting_on_me",
        summary: "You said you would send Maya the deck by Friday.",
        dueAt: plus12h,
        emailThreadId: "t2",
      }),
      makeLoop({
        id: "raj-migration",
        status: "waiting_on_other",
        summary: "Raj has not replied on the migration plan.",
        emailThreadId: "t3",
      }),
    ];

    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model);

    // Header
    expect(result.textBody).toContain("Today in Keeps");

    // AR-9 coverage line present at top
    expect(result.textBody).toContain("Tracking 3 loops across 3 threads — Keeps sees only what you've shared.");

    // Sections match roadmap copy
    expect(result.textBody).toContain("Needs your attention:");
    expect(result.textBody).toContain("1. Acme discount decision is due today.");
    expect(result.textBody).toContain("2. You said you would send Maya the deck by Friday.");
    expect(result.textBody).toContain("Waiting on others:");
    expect(result.textBody).toContain("3. Raj has not replied on the migration plan.");

    // AR-9 capture prompt at close
    expect(result.textBody).toContain("What else is on your plate? Reply and I'll track it.");

    // Footer with reply commands
    expect(result.textBody).toContain("snooze 1 until Monday");
    expect(result.textBody).toContain("done 2");
    expect(result.textBody).toContain("insights");
  });

  it("coverage line appears before any section", () => {
    const loop = makeLoop({ id: "l1", status: "open", nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const { textBody } = renderDigestEmail(model);

    const coveragePos = textBody.indexOf("Tracking");
    const sectionPos = textBody.indexOf("Needs your attention:");
    expect(coveragePos).toBeGreaterThanOrEqual(0);
    expect(sectionPos).toBeGreaterThan(coveragePos);
  });

  it("capture prompt appears after all sections", () => {
    const loop = makeLoop({ id: "l1", status: "open", nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const { textBody } = renderDigestEmail(model);

    const sectionPos = textBody.indexOf("Needs your attention:");
    const capturePos = textBody.indexOf("What else is on your plate?");
    expect(capturePos).toBeGreaterThan(sectionPos);
  });
});

describe("renderDigestEmail — empty digest", () => {
  it("still includes coverage line and capture prompt when no loops", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    const result = renderDigestEmail(model);

    expect(result.textBody).toContain("Tracking 0 loops across 0 threads — Keeps sees only what you've shared.");
    expect(result.textBody).toContain("What else is on your plate? Reply and I'll track it.");
    expect(result.textBody).toContain("Reply: snooze 1 until Monday | done 2 | insights");
    expect(result.textBody).toContain("Nothing to surface right now");
  });

  it("returns empty ordinalToLoopId when no loops", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    const result = renderDigestEmail(model);
    expect(result.ordinalToLoopId).toEqual({});
  });

  it("sets caught-up subject when no loops", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    const result = renderDigestEmail(model);
    expect(result.subject).toContain("all caught up");
  });
});

describe("renderDigestEmail — only recentlyDone", () => {
  it("renders only the recentlyDone section", () => {
    const loop = makeLoop({ id: "l1", status: "done", updatedAt: minus12h, summary: "Sent the invoice." });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const result = renderDigestEmail(model);

    expect(result.textBody).not.toContain("Needs your attention:");
    expect(result.textBody).not.toContain("Waiting on others:");
    expect(result.textBody).not.toContain("Due soon:");
    expect(result.textBody).not.toContain("Stale:");
    expect(result.textBody).toContain("Recently done:");
    expect(result.textBody).toContain("1. Sent the invoice.");
  });
});

describe("renderDigestEmail — all categories present", () => {
  it("renders all five sections with correct labels", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({ id: "na1", status: "open", dueAt: plus12h, emailThreadId: "t1" }),
      makeLoop({ id: "wo1", status: "waiting_on_other", emailThreadId: "t2" }),
      makeLoop({ id: "ds1", status: "open", dueAt: plus60h, emailThreadId: "t3" }),
      makeLoop({ id: "st1", status: "open", updatedAt: minus8d, emailThreadId: "t4" }),
      makeLoop({ id: "rd1", status: "done", updatedAt: minus12h, emailThreadId: "t5" }),
    ];

    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model);

    expect(result.textBody).toContain("Needs your attention:");
    expect(result.textBody).toContain("Waiting on others:");
    expect(result.textBody).toContain("Due soon:");
    expect(result.textBody).toContain("Stale:");
    expect(result.textBody).toContain("Recently done:");
  });
});

describe("renderDigestEmail — dedupe needsAttention over dueSoon", () => {
  it("loop in needsAttention does not appear in dueSoon ordinals", () => {
    // dueAt exactly now+12h => needsAttention only
    const loop = makeLoop({ id: "l1", status: "open", dueAt: plus12h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const result = renderDigestEmail(model);

    // ordinal 1 maps to the loop
    expect(result.ordinalToLoopId[1]).toBe("l1");
    // Only one entry in the map
    expect(Object.keys(result.ordinalToLoopId)).toHaveLength(1);

    // dueSoon section should not appear
    expect(result.textBody).not.toContain("Due soon:");
    expect(result.textBody).toContain("Needs your attention:");
  });
});

describe("renderDigestEmail — ordinal map correctness across sections", () => {
  it("assigns sequential ordinals across all sections in order", () => {
    const loops: DigestLoopInput[] = [
      // needsAttention: ordinals 1, 2
      makeLoop({ id: "na1", status: "open", dueAt: plus1h, summary: "NA1" }),
      makeLoop({ id: "na2", status: "open", dueAt: plus12h, summary: "NA2" }),
      // waitingOnOthers: ordinal 3
      makeLoop({ id: "wo1", status: "waiting_on_other", summary: "WO1" }),
      // recentlyDone: ordinal 4
      makeLoop({ id: "rd1", status: "done", updatedAt: minus12h, summary: "RD1" }),
    ];

    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model);

    expect(result.ordinalToLoopId[1]).toBe("na1");
    expect(result.ordinalToLoopId[2]).toBe("na2");
    expect(result.ordinalToLoopId[3]).toBe("wo1");
    expect(result.ordinalToLoopId[4]).toBe("rd1");
    expect(Object.keys(result.ordinalToLoopId)).toHaveLength(4);
  });

  it("respects ordinalStart option for multi-part composition", () => {
    const loop = makeLoop({ id: "l1", status: "open", nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const result = renderDigestEmail(model, { ordinalStart: 5 });

    expect(result.ordinalToLoopId[5]).toBe("l1");
    expect(result.ordinalToLoopId[1]).toBeUndefined();
  });

  it("ordinal map only contains rendered loops (capped sections excluded)", () => {
    // 7 needsAttention-eligible loops → only 5 rendered
    const loops = Array.from({ length: 7 }, (_, i) =>
      makeLoop({ id: `l${i}`, status: "open", nextCheckAt: minus1h }),
    );
    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model);

    // 5 capped
    expect(Object.keys(result.ordinalToLoopId)).toHaveLength(5);
    for (let i = 1; i <= 5; i++) {
      expect(result.ordinalToLoopId[i]).toBeDefined();
    }
    expect(result.ordinalToLoopId[6]).toBeUndefined();
  });
});

describe("renderDigestEmail — subject line", () => {
  it("counts total rendered loops in subject", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({ id: "l1", status: "open", nextCheckAt: minus1h }),
      makeLoop({ id: "l2", status: "waiting_on_other" }),
    ];
    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model);
    expect(result.subject).toContain("2 loops");
  });

  it("uses singular 'loop' for a single rendered loop", () => {
    const loop = makeLoop({ id: "l1", status: "open", nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const result = renderDigestEmail(model);
    expect(result.subject).toMatch(/1 loop\b/);
    expect(result.subject).not.toContain("1 loops");
  });
});

describe("renderDigestEmail — HTML body", () => {
  it("includes coverage line in HTML", () => {
    const loop = makeLoop({ id: "l1", status: "open", nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const result = renderDigestEmail(model);
    // apostrophe is not escaped in the HTML output (esc() handles &, <, >, " only)
    expect(result.htmlBody).toContain("Keeps sees only what you've shared");
  });

  it("includes capture prompt in HTML", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    const result = renderDigestEmail(model);
    expect(result.htmlBody).toContain("What else is on your plate?");
  });

  it("includes reply commands in HTML", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    const result = renderDigestEmail(model);
    expect(result.htmlBody).toContain("snooze 1 until Monday");
    expect(result.htmlBody).toContain("done 2");
    expect(result.htmlBody).toContain("insights");
  });

  it("uses ordered list with correct start attribute", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({ id: "na1", status: "open", dueAt: plus1h }),
      makeLoop({ id: "wo1", status: "waiting_on_other" }),
    ];
    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model, { ordinalStart: 1 });

    // needsAttention starts at 1, waitingOnOthers starts at 2
    expect(result.htmlBody).toContain('start="1"');
    expect(result.htmlBody).toContain('start="2"');
  });
});

describe("renderDigestEmail — coverage line grammar", () => {
  it("uses singular 'loop' when exactly 1 active loop", () => {
    const loop = makeLoop({ id: "l1", status: "open" });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    const result = renderDigestEmail(model);
    expect(result.textBody).toContain("Tracking 1 loop across");
    expect(result.textBody).not.toContain("1 loops");
  });

  it("uses singular 'thread' when exactly 1 distinct thread", () => {
    const loops = [
      makeLoop({ id: "l1", status: "open", emailThreadId: "t1" }),
      makeLoop({ id: "l2", status: "waiting_on_me", emailThreadId: "t1" }),
    ];
    const model = buildDigest({ user: USER, loops, now: NOW });
    const result = renderDigestEmail(model);
    expect(result.textBody).toContain("across 1 thread —");
    expect(result.textBody).not.toContain("1 threads");
  });
});
