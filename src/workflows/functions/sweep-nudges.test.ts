/**
 * Unit tests for sweepNudges pure core.
 *
 * All tests use in-memory fakes — no live DB, no Inngest.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_RE_ASK_AFTER_HOURS,
  MAX_NUDGES_PER_USER_PER_DAY,
  NUDGE_COOLDOWN_HOURS,
} from "@/nudges/policy";
import type { NudgeCandidate, NudgeRepository } from "@/nudges/repository";
import type { NudgeType } from "@/nudges/types";
import { sweepNudges } from "@/workflows/functions/sweep-nudges";

// ---------------------------------------------------------------------------
// In-memory fake NudgeRepository
// ---------------------------------------------------------------------------

type DeferredEntry = { loopId: string; nextCheckAt: Date; now: Date };
type NudgeRowInput = Parameters<NudgeRepository["createNudgeRow"]>[0];
type LoopEventInput = Parameters<NudgeRepository["writeLoopEvent"]>[0];
type AuditInput = Parameters<NudgeRepository["writeAudit"]>[0];
type MarkNudgedInput = Parameters<NudgeRepository["markLoopNudged"]>[0];

class InMemoryNudgeRepository implements NudgeRepository {
  readonly candidates: NudgeCandidate[] = [];
  readonly nudgesSentSince = new Map<string, number>(); // userId → count
  readonly deferred: DeferredEntry[] = [];
  readonly nudgeRows: NudgeRowInput[] = [];
  readonly loopEvents: LoopEventInput[] = [];
  readonly audits: AuditInput[] = [];
  readonly markedNudged: MarkNudgedInput[] = [];

  async findNudgeCandidates(_now: Date): Promise<NudgeCandidate[]> {
    return [...this.candidates];
  }

  async findCandidateById(loopId: string): Promise<NudgeCandidate | null> {
    return this.candidates.find((c) => c.id === loopId) ?? null;
  }

  async findUserEmail(userId: string): Promise<string | null> {
    return `${userId}@example.com`;
  }

  async countNudgesSentSince(userId: string, _since: Date): Promise<number> {
    return this.nudgesSentSince.get(userId) ?? 0;
  }

  async markLoopNudged(input: MarkNudgedInput): Promise<void> {
    this.markedNudged.push(input);
  }

  async deferLoopNextCheck(input: DeferredEntry): Promise<void> {
    this.deferred.push(input);
  }

  async createNudgeRow(input: NudgeRowInput): Promise<{ id: string }> {
    this.nudgeRows.push(input);
    return { id: randomUUID() };
  }

  async writeLoopEvent(input: LoopEventInput): Promise<void> {
    this.loopEvents.push(input);
  }

  async writeAudit(input: AuditInput): Promise<void> {
    this.audits.push(input);
  }

  async findLatestNudgeByRunId(_runId: string): Promise<{ id: string; userId: string } | null> {
    return null;
  }

  async findNudgeStatus(_nudgeId: string): Promise<string | null> {
    return null;
  }

  async markNudgeFailed(_input: { nudgeId: string; extraMetadata: Record<string, unknown> }): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-12T12:00:00.000Z");
const USER_ID = "user-aaa";
const USER_ID_2 = "user-bbb";

function makeCandidate(overrides: Partial<NudgeCandidate> = {}): NudgeCandidate {
  return {
    id: randomUUID(),
    userId: USER_ID,
    status: "open",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    nextCheckAt: new Date("2026-06-12T10:00:00.000Z"), // in the past
    lastNudgedAt: null,
    nudgeCount: 0,
    summary: "Follow up on invoice",
    userTimezone: "UTC",
    ...overrides,
  };
}

function makeCandidateLoop(overrides: Partial<NudgeCandidate> = {}): NudgeCandidate {
  const candidateAgeMs = (CANDIDATE_RE_ASK_AFTER_HOURS + 1) * 60 * 60 * 1000;
  return makeCandidate({
    status: "candidate",
    createdAt: new Date(NOW.getTime() - candidateAgeMs),
    nudgeCount: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("sweepNudges — happy path", () => {
  it("emits one loop.nudge_due event for each eligible loop", async () => {
    const repo = new InMemoryNudgeRepository();
    const loop1 = makeCandidate({ id: "loop-1" });
    const loop2 = makeCandidate({ id: "loop-2" });
    repo.candidates.push(loop1, loop2);

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.data.loopId)).toContain("loop-1");
    expect(result.events.map((e) => e.data.loopId)).toContain("loop-2");
  });

  it("sets event name to 'loop.nudge_due'", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(makeCandidate());

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events[0]?.name).toBe("loop.nudge_due");
  });

  it("populates userId, loopId, scheduledFor in event data", async () => {
    const repo = new InMemoryNudgeRepository();
    const loop = makeCandidate({ id: "loop-x", userId: USER_ID });
    repo.candidates.push(loop);

    const result = await sweepNudges({ repository: repo, now: NOW });

    const ev = result.events[0];
    expect(ev?.data.userId).toBe(USER_ID);
    expect(ev?.data.loopId).toBe("loop-x");
    expect(ev?.data.scheduledFor).toBe(NOW.toISOString());
  });

  it("sets reason 'next_check_due' for open/waiting loops", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(makeCandidate({ status: "open" }));
    repo.candidates.push(makeCandidate({ id: randomUUID(), status: "waiting_on_me" }));
    repo.candidates.push(makeCandidate({ id: randomUUID(), status: "waiting_on_other" }));

    const result = await sweepNudges({ repository: repo, now: NOW });

    for (const ev of result.events) {
      expect(ev.data.reason).toBe("next_check_due");
    }
  });

  it("sets reason 'candidate_re_ask' for eligible candidate loops", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(makeCandidateLoop());

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events[0]?.data.reason).toBe("candidate_re_ask");
  });

  it("reports candidateCount from DB pre-filter", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(makeCandidate(), makeCandidate({ id: randomUUID() }));

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.candidateCount).toBe(2);
  });

  it("returns empty events and zero deferred when no candidates", async () => {
    const repo = new InMemoryNudgeRepository();

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
    expect(result.deferredLoopIds).toHaveLength(0);
    expect(result.candidateCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ineligible loops skipped
// ---------------------------------------------------------------------------

describe("sweepNudges — ineligible loops not emitted", () => {
  for (const status of ["done", "dismissed", "blocked", "snoozed"] as const) {
    it(`skips status="${status}"`, async () => {
      const repo = new InMemoryNudgeRepository();
      repo.candidates.push(makeCandidate({ status }));

      const result = await sweepNudges({ repository: repo, now: NOW });

      expect(result.events).toHaveLength(0);
    });
  }

  it("skips loops still within cooldown window", async () => {
    const repo = new InMemoryNudgeRepository();
    const recentlyNudged = new Date(
      NOW.getTime() - (NUDGE_COOLDOWN_HOURS - 1) * 60 * 60 * 1000,
    );
    repo.candidates.push(makeCandidate({ lastNudgedAt: recentlyNudged }));

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
  });

  it("skips candidate loops that are too young (< 48h)", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(
      makeCandidate({
        status: "candidate",
        createdAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000), // only 12h old
        nudgeCount: 0,
      }),
    );

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
  });

  it("skips candidate loops that have already been nudged (nudgeCount > 0)", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(makeCandidateLoop({ nudgeCount: 1 }));

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
  });

  it("skips loops with nextCheckAt in the future", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(
      makeCandidate({
        nextCheckAt: new Date(NOW.getTime() + 60_000), // 1 min future
      }),
    );

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
  });

  it("skips loops with null nextCheckAt", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.candidates.push(makeCandidate({ nextCheckAt: null }));

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Daily cap enforcement
// ---------------------------------------------------------------------------

describe("sweepNudges — daily cap", () => {
  it("defers loops over the daily cap and adds their ids to deferredLoopIds", async () => {
    const repo = new InMemoryNudgeRepository();
    // Already at cap
    repo.nudgesSentSince.set(USER_ID, MAX_NUDGES_PER_USER_PER_DAY);
    const loop = makeCandidate();
    repo.candidates.push(loop);

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(0);
    expect(result.deferredLoopIds).toContain(loop.id);
  });

  it("defers only the loops beyond the cap (partial cap fill)", async () => {
    const repo = new InMemoryNudgeRepository();
    const alreadySent = MAX_NUDGES_PER_USER_PER_DAY - 1; // 1 slot remaining
    repo.nudgesSentSince.set(USER_ID, alreadySent);

    // Push MAX+1 candidates
    for (let i = 0; i < MAX_NUDGES_PER_USER_PER_DAY + 1; i++) {
      repo.candidates.push(makeCandidate({ id: `loop-${i}` }));
    }

    const result = await sweepNudges({ repository: repo, now: NOW });

    // Only 1 slot remaining → 1 event, MAX remaining deferred
    expect(result.events).toHaveLength(1);
    expect(result.deferredLoopIds).toHaveLength(MAX_NUDGES_PER_USER_PER_DAY);
  });

  it("calls deferLoopNextCheck for each deferred loop", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.nudgesSentSince.set(USER_ID, MAX_NUDGES_PER_USER_PER_DAY); // cap full
    const loop = makeCandidate();
    repo.candidates.push(loop);

    await sweepNudges({ repository: repo, now: NOW });

    expect(repo.deferred).toHaveLength(1);
    expect(repo.deferred[0]?.loopId).toBe(loop.id);
  });

  it("deferred nextCheckAt is tomorrow local 9 AM (UTC tz: 09:00 UTC next day)", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.nudgesSentSince.set(USER_ID, MAX_NUDGES_PER_USER_PER_DAY);
    // UTC timezone so tomorrow 9 AM = 2026-06-13T09:00:00.000Z
    repo.candidates.push(makeCandidate({ userTimezone: "UTC" }));

    await sweepNudges({ repository: repo, now: NOW });

    expect(repo.deferred[0]?.nextCheckAt.toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("deferred nextCheckAt is DST-correct for America/Los_Angeles in summer (tomorrow 9 AM PDT = 16:00 UTC)", async () => {
    const repo = new InMemoryNudgeRepository();
    repo.nudgesSentSince.set(USER_ID, MAX_NUDGES_PER_USER_PER_DAY);
    // now = 2026-06-12T12:00:00Z (05:00 PDT); next day = 2026-06-13; 9 AM PDT = 16:00 UTC
    repo.candidates.push(makeCandidate({ userTimezone: "America/Los_Angeles" }));

    await sweepNudges({ repository: repo, now: NOW });

    expect(repo.deferred[0]?.nextCheckAt.toISOString()).toBe("2026-06-13T16:00:00.000Z");
  });

  it("handles multiple users independently — each gets their own cap check", async () => {
    const repo = new InMemoryNudgeRepository();
    // user-aaa: at cap
    repo.nudgesSentSince.set(USER_ID, MAX_NUDGES_PER_USER_PER_DAY);
    // user-bbb: fresh
    repo.nudgesSentSince.set(USER_ID_2, 0);

    const loop1 = makeCandidate({ id: "loop-a", userId: USER_ID });
    const loop2 = makeCandidate({ id: "loop-b", userId: USER_ID_2 });
    repo.candidates.push(loop1, loop2);

    const result = await sweepNudges({ repository: repo, now: NOW });

    // user-aaa deferred; user-bbb emitted
    expect(result.events.map((e) => e.data.loopId)).toContain("loop-b");
    expect(result.events.map((e) => e.data.loopId)).not.toContain("loop-a");
    expect(result.deferredLoopIds).toContain("loop-a");
    expect(result.deferredLoopIds).not.toContain("loop-b");
  });
});
