import { describe, it, expect } from "vitest";
import { buildDigest } from "@/digests/build";
import type { DigestLoopInput, DigestUserInput } from "@/digests/build";

// ---- fixtures ---------------------------------------------------------------

const USER: DigestUserInput = {
  id: "user-1",
  email: "arav@example.com",
  displayName: "Arav",
};

const NOW = new Date("2026-06-12T09:00:00Z");

// now + offsets
const plus1h = new Date(NOW.getTime() + 60 * 60 * 1000);
const plus12h = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
const plus30h = new Date(NOW.getTime() + 30 * 60 * 60 * 1000);
const plus48h = new Date(NOW.getTime() + 48 * 60 * 60 * 1000);
const plus60h = new Date(NOW.getTime() + 60 * 60 * 60 * 1000);
const minus1h = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
const minus12h = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);
const minus8d = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
const minus25h = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

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

describe("buildDigest — empty input", () => {
  it("returns all empty sections when given no loops", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    expect(model.needsAttention).toEqual([]);
    expect(model.waitingOnOthers).toEqual([]);
    expect(model.dueSoon).toEqual([]);
    expect(model.stale).toEqual([]);
    expect(model.recentlyDone).toEqual([]);
    expect(model.totalActiveLoops).toBe(0);
    expect(model.distinctActiveThreads).toBe(0);
  });

  it("carries the user and builtAt on empty model", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    expect(model.user).toBe(USER);
    expect(model.builtAt).toBe(NOW);
  });
});

describe("buildDigest — needsAttention", () => {
  it("includes open loop with dueAt <= now+24h", () => {
    const loop = makeLoop({ id: "l1", status: "open", dueAt: plus12h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(1);
    expect(model.needsAttention[0]?.loopId).toBe("l1");
  });

  it("includes waiting_on_me loop with nextCheckAt <= now", () => {
    const loop = makeLoop({ id: "l2", status: "waiting_on_me", nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(1);
    expect(model.needsAttention[0]?.loopId).toBe("l2");
  });

  it("excludes loop with dueAt > now+24h and nextCheckAt null", () => {
    const loop = makeLoop({ id: "l3", status: "open", dueAt: plus30h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(0);
  });

  it("excludes waiting_on_other loops", () => {
    const loop = makeLoop({ id: "l4", status: "waiting_on_other", dueAt: plus12h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(0);
  });

  it("orders by dueAt asc then nextCheckAt asc (nulls last)", () => {
    const l1 = makeLoop({ id: "l1", status: "open", dueAt: plus12h, nextCheckAt: null });
    const l2 = makeLoop({ id: "l2", status: "open", dueAt: plus1h, nextCheckAt: null });
    const l3 = makeLoop({ id: "l3", status: "waiting_on_me", dueAt: null, nextCheckAt: minus1h });
    const model = buildDigest({ user: USER, loops: [l1, l3, l2], now: NOW });
    expect(model.needsAttention.map((e) => e.loopId)).toEqual(["l2", "l1", "l3"]);
  });
});

describe("buildDigest — waitingOnOthers", () => {
  it("includes waiting_on_other loops", () => {
    const loop = makeLoop({ id: "l1", status: "waiting_on_other" });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.waitingOnOthers).toHaveLength(1);
  });

  it("orders by updatedAt asc (longest-waiting first)", () => {
    const l1 = makeLoop({ id: "l1", status: "waiting_on_other", updatedAt: minus12h });
    const l2 = makeLoop({ id: "l2", status: "waiting_on_other", updatedAt: minus1h });
    const model = buildDigest({ user: USER, loops: [l2, l1], now: NOW });
    expect(model.waitingOnOthers.map((e) => e.loopId)).toEqual(["l1", "l2"]);
  });
});

describe("buildDigest — dueSoon", () => {
  it("includes open loop with dueAt between now+24h exclusive and now+72h inclusive", () => {
    const loop = makeLoop({ id: "l1", status: "open", dueAt: plus48h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.dueSoon).toHaveLength(1);
    expect(model.dueSoon[0]?.loopId).toBe("l1");
  });

  it("excludes loop with dueAt exactly at now+24h boundary (belongs to needsAttention)", () => {
    const exactly24h = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const loop = makeLoop({ id: "l1", status: "open", dueAt: exactly24h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    // dueAt == now+24h falls in needsAttention (<=) not dueSoon (>)
    expect(model.needsAttention).toHaveLength(1);
    expect(model.dueSoon).toHaveLength(0);
  });

  it("excludes loop with dueAt > now+72h", () => {
    const past72h = new Date(NOW.getTime() + 73 * 60 * 60 * 1000);
    const loop = makeLoop({ id: "l1", status: "open", dueAt: past72h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.dueSoon).toHaveLength(0);
  });

  it("deduplicates: needsAttention wins when loop is also eligible for dueSoon", () => {
    // Loop with dueAt within 24h triggers needsAttention; it should NOT appear in dueSoon
    const loop = makeLoop({ id: "l1", status: "open", dueAt: plus12h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(1);
    expect(model.dueSoon).toHaveLength(0);
  });
});

describe("buildDigest — stale", () => {
  it("includes open loop with updatedAt < now-7d", () => {
    const loop = makeLoop({ id: "l1", status: "open", updatedAt: minus8d });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.stale).toHaveLength(1);
  });

  it("includes waiting_on_other stale loop (co-exists with waitingOnOthers)", () => {
    const loop = makeLoop({ id: "l1", status: "waiting_on_other", updatedAt: minus8d });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.stale).toHaveLength(1);
    expect(model.waitingOnOthers).toHaveLength(1);
    // same loop appears in both
    expect(model.stale[0]?.loopId).toBe("l1");
    expect(model.waitingOnOthers[0]?.loopId).toBe("l1");
  });

  it("does NOT include needsAttention loop in stale", () => {
    // Loop is stale AND urgent — needsAttention wins, stale excludes it
    const loop = makeLoop({ id: "l1", status: "open", dueAt: plus12h, updatedAt: minus8d });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(1);
    expect(model.stale).toHaveLength(0);
  });

  it("does NOT include dueSoon loop in stale", () => {
    const loop = makeLoop({ id: "l1", status: "open", dueAt: plus48h, updatedAt: minus8d });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.dueSoon).toHaveLength(1);
    expect(model.stale).toHaveLength(0);
  });

  it("excludes done loops from stale", () => {
    const loop = makeLoop({ id: "l1", status: "done", updatedAt: minus8d });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.stale).toHaveLength(0);
  });

  it("orders by updatedAt asc (most stale first)", () => {
    const l1 = makeLoop({ id: "l1", status: "open", updatedAt: minus8d });
    const twoWeeksAgo = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000);
    const l2 = makeLoop({ id: "l2", status: "open", updatedAt: twoWeeksAgo });
    const model = buildDigest({ user: USER, loops: [l1, l2], now: NOW });
    expect(model.stale.map((e) => e.loopId)).toEqual(["l2", "l1"]);
  });
});

describe("buildDigest — recentlyDone", () => {
  it("includes done loop with updatedAt >= now-24h", () => {
    const loop = makeLoop({ id: "l1", status: "done", updatedAt: minus12h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.recentlyDone).toHaveLength(1);
  });

  it("excludes done loop with updatedAt < now-24h", () => {
    const loop = makeLoop({ id: "l1", status: "done", updatedAt: minus25h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.recentlyDone).toHaveLength(0);
  });

  it("orders by updatedAt desc (most recently done first)", () => {
    const l1 = makeLoop({ id: "l1", status: "done", updatedAt: minus12h });
    const l2 = makeLoop({ id: "l2", status: "done", updatedAt: minus1h });
    const model = buildDigest({ user: USER, loops: [l2, l1], now: NOW });
    expect(model.recentlyDone.map((e) => e.loopId)).toEqual(["l2", "l1"]);
  });
});

describe("buildDigest — section cap (>5 loops)", () => {
  it("caps needsAttention at 5", () => {
    const loops = Array.from({ length: 8 }, (_, i) =>
      makeLoop({ id: `l${i}`, status: "open", nextCheckAt: minus1h }),
    );
    const model = buildDigest({ user: USER, loops, now: NOW });
    expect(model.needsAttention).toHaveLength(5);
  });

  it("caps waitingOnOthers at 5", () => {
    const loops = Array.from({ length: 7 }, (_, i) =>
      makeLoop({ id: `l${i}`, status: "waiting_on_other" }),
    );
    const model = buildDigest({ user: USER, loops, now: NOW });
    expect(model.waitingOnOthers).toHaveLength(5);
  });

  it("caps dueSoon at 5", () => {
    const loops = Array.from({ length: 6 }, (_, i) =>
      makeLoop({ id: `l${i}`, status: "open", dueAt: plus48h }),
    );
    const model = buildDigest({ user: USER, loops, now: NOW });
    expect(model.dueSoon).toHaveLength(5);
  });
});

describe("buildDigest — coverage counts", () => {
  it("counts only active statuses (open, waiting_on_me, waiting_on_other)", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({ id: "l1", status: "open" }),
      makeLoop({ id: "l2", status: "waiting_on_me" }),
      makeLoop({ id: "l3", status: "waiting_on_other" }),
      makeLoop({ id: "l4", status: "candidate" }),     // not active
      makeLoop({ id: "l5", status: "snoozed" }),       // not active
      makeLoop({ id: "l6", status: "done" }),          // not active
      makeLoop({ id: "l7", status: "blocked" }),       // not active
    ];
    const model = buildDigest({ user: USER, loops, now: NOW });
    expect(model.totalActiveLoops).toBe(3);
  });

  it("counts distinct thread IDs among active loops", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({ id: "l1", status: "open", emailThreadId: "t1" }),
      makeLoop({ id: "l2", status: "open", emailThreadId: "t1" }),       // same thread
      makeLoop({ id: "l3", status: "waiting_on_other", emailThreadId: "t2" }),
      makeLoop({ id: "l4", status: "done", emailThreadId: "t3" }),       // not active
    ];
    const model = buildDigest({ user: USER, loops, now: NOW });
    expect(model.totalActiveLoops).toBe(3);
    expect(model.distinctActiveThreads).toBe(2); // t1 and t2
  });
});

describe("buildDigest — roadmap UX sample scenario", () => {
  /**
   * Reproduce the roadmap example:
   *   Needs your attention:
   *   1. Acme discount decision is due today.
   *   2. You said you would send Maya the deck by Friday.
   *
   *   Waiting on others:
   *   1. Raj has not replied on the migration plan.
   */
  it("matches roadmap UX sample shape", () => {
    const loops: DigestLoopInput[] = [
      makeLoop({
        id: "acme",
        status: "open",
        summary: "Acme discount decision is due today.",
        dueAt: plus1h, // due in 1h => needsAttention
        emailThreadId: "thread-acme",
      }),
      makeLoop({
        id: "maya-deck",
        status: "waiting_on_me",
        summary: "You said you would send Maya the deck by Friday.",
        dueAt: plus12h, // due in 12h => needsAttention
        emailThreadId: "thread-maya",
      }),
      makeLoop({
        id: "raj-migration",
        status: "waiting_on_other",
        summary: "Raj has not replied on the migration plan.",
        emailThreadId: "thread-raj",
      }),
    ];

    const model = buildDigest({ user: USER, loops, now: NOW });

    expect(model.needsAttention.map((e) => e.loopId)).toEqual(["acme", "maya-deck"]);
    expect(model.waitingOnOthers.map((e) => e.loopId)).toEqual(["raj-migration"]);
    expect(model.dueSoon).toHaveLength(0);
    expect(model.stale).toHaveLength(0);
    expect(model.recentlyDone).toHaveLength(0);
    expect(model.totalActiveLoops).toBe(3);
    expect(model.distinctActiveThreads).toBe(3);
  });
});

describe("buildDigest — only recentlyDone", () => {
  it("produces only recentlyDone section", () => {
    const loop = makeLoop({ id: "l1", status: "done", updatedAt: minus1h });
    const model = buildDigest({ user: USER, loops: [loop], now: NOW });
    expect(model.needsAttention).toHaveLength(0);
    expect(model.waitingOnOthers).toHaveLength(0);
    expect(model.dueSoon).toHaveLength(0);
    expect(model.stale).toHaveLength(0);
    expect(model.recentlyDone).toHaveLength(1);
    expect(model.totalActiveLoops).toBe(0);
  });
});

describe("buildDigest — all categories present", () => {
  it("populates all five sections simultaneously", () => {
    const loops: DigestLoopInput[] = [
      // needsAttention
      makeLoop({ id: "na1", status: "open", dueAt: plus12h, emailThreadId: "t1" }),
      // waitingOnOthers
      makeLoop({ id: "wo1", status: "waiting_on_other", emailThreadId: "t2" }),
      // dueSoon
      makeLoop({ id: "ds1", status: "open", dueAt: plus60h, emailThreadId: "t3" }),
      // stale (and waiting_on_other so also in waitingOnOthers)
      makeLoop({ id: "st1", status: "waiting_on_other", updatedAt: minus8d, emailThreadId: "t4" }),
      // recentlyDone
      makeLoop({ id: "rd1", status: "done", updatedAt: minus12h, emailThreadId: "t5" }),
    ];

    const model = buildDigest({ user: USER, loops, now: NOW });
    expect(model.needsAttention).toHaveLength(1);
    expect(model.waitingOnOthers).toHaveLength(2); // wo1 + st1
    expect(model.dueSoon).toHaveLength(1);
    expect(model.stale).toHaveLength(1);
    expect(model.recentlyDone).toHaveLength(1);
  });
});
