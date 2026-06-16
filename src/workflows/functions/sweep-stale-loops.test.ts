import { describe, it, expect } from "vitest";
import { sweepStaleLoops, type StaleLoopRepository, type StaleLoopCandidate } from "@/workflows/functions/sweep-stale-loops";

function repo(candidates: StaleLoopCandidate[]): StaleLoopRepository {
  return { findStaleLoopCandidates: async () => candidates };
}

const NOW = new Date("2026-06-16T09:30:00Z");

describe("sweepStaleLoops (pure core)", () => {
  it("emits one automation.triggered per candidate with a deterministic per-day idempotency key", async () => {
    const { events } = await sweepStaleLoops({
      now: NOW,
      repository: repo([
        { loopId: "l1", userId: "u1", summary: "Acme renewal", standingGrantId: "g1", staleDays: 7 },
        { loopId: "l2", userId: "u1", summary: "Beta follow-up", standingGrantId: "g1", staleDays: 14 },
      ]),
    });
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("automation.triggered");
    expect(events[0].data).toMatchObject({
      userId: "u1",
      recipeKey: "stale_loop_followup",
      triggerKind: "loop_stale",
      triggerRef: "l1",
      standingGrantId: "g1",
      idempotencyKey: "automation:stale_loop_followup:l1:2026-06-16",
      context: { staleDays: 7 },
    });
    expect(events[1].data.context).toEqual({ staleDays: 14 });
  });

  it("no candidates → no events", async () => {
    const { events, candidateCount } = await sweepStaleLoops({ now: NOW, repository: repo([]) });
    expect(events).toEqual([]);
    expect(candidateCount).toBe(0);
  });

  it("idempotency key is stable within a day, changes across days (one trigger/loop/day)", async () => {
    const c: StaleLoopCandidate[] = [{ loopId: "l1", userId: "u1", summary: "x", standingGrantId: "g1", staleDays: 7 }];
    const a = await sweepStaleLoops({ now: new Date("2026-06-16T01:00:00Z"), repository: repo(c) });
    const b = await sweepStaleLoops({ now: new Date("2026-06-16T23:00:00Z"), repository: repo(c) });
    const next = await sweepStaleLoops({ now: new Date("2026-06-17T01:00:00Z"), repository: repo(c) });
    expect(a.events[0].data.idempotencyKey).toBe(b.events[0].data.idempotencyKey);
    expect(a.events[0].data.idempotencyKey).not.toBe(next.events[0].data.idempotencyKey);
  });
});
