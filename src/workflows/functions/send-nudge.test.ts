/**
 * Unit tests for the send-nudge pure core (sendNudgeEmail + checkNudge + composeNudge).
 *
 * All tests use in-memory fakes — no live DB, no Inngest, no Postmark.
 * Architecture mirrors send-activation-email.test.ts.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import {
  CANDIDATE_RE_ASK_AFTER_HOURS,
  MAX_NUDGES_PER_USER_PER_DAY,
  NUDGE_COOLDOWN_HOURS,
  DEFAULT_NEXT_NUDGE_WINDOW_DAYS,
} from "@/nudges/policy";
import type { NudgeCandidate, NudgeRepository } from "@/nudges/repository";
import type { NudgeType } from "@/nudges/types";
import {
  checkNudge,
  composeNudge,
  sendNudgeEmail,
} from "@/workflows/functions/send-nudge";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

type RecordedSend = Parameters<OutboundEmailStore["recordSend"]>[0];

class InMemoryOutboundEmailStore implements OutboundEmailStore {
  readonly sends: RecordedSend[] = [];
  readonly sentNudges: { nudgeId: string; sentAt: Date }[] = [];

  async recordSend(input: RecordedSend): Promise<void> {
    this.sends.push(input);
  }

  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    this.sentNudges.push(input);
  }
}

type DeferredEntry = { loopId: string; nextCheckAt: Date; now: Date };
type NudgeRowInput = Parameters<NudgeRepository["createNudgeRow"]>[0];
type LoopEventInput = Parameters<NudgeRepository["writeLoopEvent"]>[0];
type AuditInput = Parameters<NudgeRepository["writeAudit"]>[0];
type MarkNudgedInput = Parameters<NudgeRepository["markLoopNudged"]>[0];

class InMemoryNudgeRepository implements NudgeRepository {
  readonly candidatesById = new Map<string, NudgeCandidate>();
  readonly userEmails = new Map<string, string>();
  nudgesSentCount = 0;
  readonly deferred: DeferredEntry[] = [];
  readonly nudgeRows: (NudgeRowInput & { id: string })[] = [];
  readonly loopEvents: LoopEventInput[] = [];
  readonly audits: AuditInput[] = [];
  readonly markedNudged: MarkNudgedInput[] = [];

  addCandidate(c: NudgeCandidate) {
    this.candidatesById.set(c.id, c);
  }

  addUserEmail(userId: string, email: string) {
    this.userEmails.set(userId, email);
  }

  async findNudgeCandidates(_now: Date): Promise<NudgeCandidate[]> {
    return [...this.candidatesById.values()];
  }

  async findCandidateById(loopId: string): Promise<NudgeCandidate | null> {
    return this.candidatesById.get(loopId) ?? null;
  }

  async findUserEmail(userId: string): Promise<string | null> {
    return this.userEmails.get(userId) ?? null;
  }

  async countNudgesSentSince(_userId: string, _since: Date): Promise<number> {
    return this.nudgesSentCount;
  }

  async markLoopNudged(input: MarkNudgedInput): Promise<void> {
    this.markedNudged.push(input);
  }

  async deferLoopNextCheck(input: DeferredEntry): Promise<void> {
    this.deferred.push(input);
  }

  async createNudgeRow(input: NudgeRowInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.nudgeRows.push({ ...input, id });
    return { id };
  }

  async writeLoopEvent(input: LoopEventInput): Promise<void> {
    this.loopEvents.push(input);
  }

  async writeAudit(input: AuditInput): Promise<void> {
    this.audits.push(input);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-12T12:00:00.000Z");
const USER_ID = "user-001";
const USER_EMAIL = "owner@example.com";
const REPLY_TO_BASE = "agent@keeps.ai";

function makeCandidate(overrides: Partial<NudgeCandidate> = {}): NudgeCandidate {
  return {
    id: randomUUID(),
    userId: USER_ID,
    status: "open",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    nextCheckAt: new Date("2026-06-12T10:00:00.000Z"),
    lastNudgedAt: null,
    nudgeCount: 0,
    summary: "Follow up on the renewal packet",
    userTimezone: "UTC",
    ...overrides,
  };
}

function makeRepo(loop?: NudgeCandidate): InMemoryNudgeRepository {
  const repo = new InMemoryNudgeRepository();
  if (loop) {
    repo.addCandidate(loop);
  }
  repo.addUserEmail(USER_ID, USER_EMAIL);
  return repo;
}

function makeOptions(
  repo: InMemoryNudgeRepository,
  store: InMemoryOutboundEmailStore,
  overrides: { now?: Date } = {},
) {
  return {
    repository: repo,
    sender: new DevRecordingSender(),
    store,
    replyToBase: REPLY_TO_BASE,
    now: overrides.now ?? NOW,
  };
}

// ---------------------------------------------------------------------------
// Happy path — email recorded with right Reply-To and mailboxHash
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — happy path", () => {
  it("returns status=sent for an eligible loop", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(result.status).toBe("sent");
  });

  it("sends exactly one email to the owner's address (PRIVACY GUARD)", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]?.toEmail).toBe(USER_EMAIL);
  });

  it("Reply-To is set to agent+n_<nudgeId>@keeps.ai (top-level field)", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));
    if (result.status !== "sent") throw new Error("expected sent");

    const sent = store.sends[0];
    expect(sent?.replyTo).toBe(`agent+n_${result.nudgeId}@keeps.ai`);
    // Must NOT be in headers — Postmark rejects Reply-To in the Headers array
    expect(sent?.headers?.["Reply-To"]).toBeUndefined();
  });

  it("mailboxHash is n_<nudgeId>", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));
    if (result.status !== "sent") throw new Error("expected sent");

    expect(store.sends[0]?.mailboxHash).toBe(`n_${result.nudgeId}`);
  });

  it("subject starts with 'Checking in:'", async () => {
    const loop = makeCandidate({ summary: "Send the renewal packet" });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(store.sends[0]?.subject).toMatch(/^Checking in:/);
  });

  it("text body includes the loop summary", async () => {
    const loop = makeCandidate({ summary: "Review the contract terms" });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(store.sends[0]?.textBody).toContain("Review the contract terms");
  });

  it("text body includes reply command hints (done, snooze, dismiss)", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    const body = store.sends[0]?.textBody ?? "";
    expect(body).toContain("done 1");
    expect(body).toContain("snooze 1");
    expect(body).toContain("dismiss 1");
  });
});

// ---------------------------------------------------------------------------
// Loop stamped — last_nudged_at set, nudge_count incremented, next_check_at advanced
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — loop bookkeeping", () => {
  it("calls markLoopNudged with the correct loopId", async () => {
    const loop = makeCandidate({ id: "loop-xyz" });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(repo.markedNudged).toHaveLength(1);
    expect(repo.markedNudged[0]?.loopId).toBe("loop-xyz");
  });

  it("advances next_check_at by DEFAULT_NEXT_NUDGE_WINDOW_DAYS (3 days)", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    const expectedNextCheck = new Date(
      NOW.getTime() + DEFAULT_NEXT_NUDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(repo.markedNudged[0]?.nextCheckAt.getTime()).toBe(expectedNextCheck.getTime());
  });

  it("stamps markLoopNudged with the injected now timestamp", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(repo.markedNudged[0]?.now).toEqual(NOW);
  });

  it("marks nudge row as sent via store.markNudgeSent", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));
    if (result.status !== "sent") throw new Error("expected sent");

    expect(store.sentNudges).toHaveLength(1);
    expect(store.sentNudges[0]?.nudgeId).toBe(result.nudgeId);
    expect(store.sentNudges[0]?.sentAt).toEqual(NOW);
  });
});

// ---------------------------------------------------------------------------
// loop_events 'nudged' written
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — loop_events", () => {
  it("writes a loop_events row with eventType='nudged'", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(repo.loopEvents).toHaveLength(1);
    expect(repo.loopEvents[0]?.eventType).toBe("nudged");
    expect(repo.loopEvents[0]?.loopId).toBe(loop.id);
  });
});

// ---------------------------------------------------------------------------
// Audit log written
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — audit", () => {
  it("writes a nudge.sent audit row", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));
    if (result.status !== "sent") throw new Error("expected sent");

    expect(repo.audits).toHaveLength(1);
    expect(repo.audits[0]?.action).toBe("nudge.sent");
    expect(repo.audits[0]?.userId).toBe(USER_ID);
    expect(repo.audits[0]?.metadata.nudgeId).toBe(result.nudgeId);
    expect(repo.audits[0]?.metadata.loopId).toBe(loop.id);
    expect(repo.audits[0]?.metadata.providerMessageId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AR-3 ordinalMap — metadata shape for reply resolution
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — AR-3 nudge metadata (ordinalMap)", () => {
  it("stores ordinalMap with {1: loopId} in nudge row metadata", async () => {
    const loop = makeCandidate({ id: "loop-ar3" });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    const nudgeRow = repo.nudgeRows[0];
    expect(nudgeRow?.metadata).toBeDefined();
    const meta = nudgeRow?.metadata as Record<string, unknown>;
    expect(meta.ordinalMap).toBeDefined();
    const ordinalMap = meta.ordinalMap as Record<string | number, string>;
    expect(ordinalMap[1]).toBe("loop-ar3");
  });

  it("nudge row metadata has kind='nudge'", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    const meta = repo.nudgeRows[0]?.metadata as Record<string, unknown>;
    expect(meta.kind).toBe("nudge");
  });
});

// ---------------------------------------------------------------------------
// Suppression cases
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — cooldown suppression", () => {
  it("returns suppressed_ineligible when loop is within cooldown", async () => {
    const recentlyNudged = new Date(
      NOW.getTime() - (NUDGE_COOLDOWN_HOURS - 1) * 60 * 60 * 1000,
    );
    const loop = makeCandidate({ lastNudgedAt: recentlyNudged });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(result.status).toBe("suppressed_ineligible");
    expect(store.sends).toHaveLength(0);
    expect(repo.nudgeRows).toHaveLength(0);
  });

  it("does NOT write a nudge row when suppressed", async () => {
    const recentlyNudged = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago
    const loop = makeCandidate({ lastNudgedAt: recentlyNudged });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(repo.nudgeRows).toHaveLength(0);
  });
});

describe("sendNudgeEmail — daily cap suppression", () => {
  it("returns suppressed_daily_cap when cap is hit", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    repo.nudgesSentCount = MAX_NUDGES_PER_USER_PER_DAY; // cap exhausted
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(result.status).toBe("suppressed_daily_cap");
    expect(store.sends).toHaveLength(0);
  });
});

describe("sendNudgeEmail — terminal status suppression", () => {
  for (const status of ["done", "dismissed", "blocked", "snoozed"] as const) {
    it(`returns suppressed_ineligible for status="${status}"`, async () => {
      const loop = makeCandidate({ status });
      const repo = makeRepo(loop);
      const store = new InMemoryOutboundEmailStore();

      const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

      expect(result.status).toBe("suppressed_ineligible");
      expect(store.sends).toHaveLength(0);
    });
  }
});

describe("sendNudgeEmail — loop not found", () => {
  it("returns suppressed_not_found when loop does not exist", async () => {
    const repo = makeRepo(); // no candidates
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail("no-such-loop", makeOptions(repo, store));

    expect(result.status).toBe("suppressed_not_found");
    expect(store.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Candidate re-ask suppression
// ---------------------------------------------------------------------------

describe("sendNudgeEmail — candidate loop rules", () => {
  it("suppresses a candidate loop that is too young (< 48h)", async () => {
    const tooYoung = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);
    const loop = makeCandidate({ status: "candidate", createdAt: tooYoung, nudgeCount: 0 });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(result.status).toBe("suppressed_ineligible");
  });

  it("suppresses a candidate loop that has already been nudged once", async () => {
    const ageMs = (CANDIDATE_RE_ASK_AFTER_HOURS + 1) * 60 * 60 * 1000;
    const loop = makeCandidate({
      status: "candidate",
      createdAt: new Date(NOW.getTime() - ageMs),
      nudgeCount: 1,
    });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(result.status).toBe("suppressed_ineligible");
  });

  it("sends a candidate loop that is old enough and has never been nudged", async () => {
    const ageMs = (CANDIDATE_RE_ASK_AFTER_HOURS + 1) * 60 * 60 * 1000;
    const loop = makeCandidate({
      status: "candidate",
      createdAt: new Date(NOW.getTime() - ageMs),
      nudgeCount: 0,
      nextCheckAt: new Date(NOW.getTime() - 1),
    });
    const repo = makeRepo(loop);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loop.id, makeOptions(repo, store));

    expect(result.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// composeNudge — subject truncation
// ---------------------------------------------------------------------------

describe("composeNudge", () => {
  it("truncates a long summary to 60 chars with ellipsis in subject", () => {
    const longSummary = "A".repeat(80);
    const loop = makeCandidate({ summary: longSummary });
    const { subject } = composeNudge(loop);

    // Subject should be 'Checking in: ' + up to 57 chars + '…'
    expect(subject.startsWith("Checking in:")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual("Checking in: ".length + 58); // 57 + ellipsis
    expect(subject).toContain("…");
  });

  it("does not truncate a short summary", () => {
    const shortSummary = "Short task";
    const loop = makeCandidate({ summary: shortSummary });
    const { subject } = composeNudge(loop);

    expect(subject).toBe(`Checking in: ${shortSummary}`);
  });

  it("ordinalMap has ordinal 1 → loopId", () => {
    const loop = makeCandidate({ id: "loop-compose" });
    const { metadata } = composeNudge(loop);

    expect(metadata.ordinalMap[1]).toBe("loop-compose");
  });
});

// ---------------------------------------------------------------------------
// checkNudge — isolated unit
// ---------------------------------------------------------------------------

describe("checkNudge", () => {
  it("returns clear for an eligible loop with a known user email", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);

    const result = await checkNudge(loop.id, { repository: repo, now: NOW });

    expect(result.status).toBe("clear");
  });

  it("returns suppressed_not_found when loop id does not exist", async () => {
    const repo = makeRepo();

    const result = await checkNudge("ghost-loop", { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_not_found");
  });

  it("returns suppressed_not_found when user email cannot be resolved", async () => {
    const loop = makeCandidate({ userId: "user-no-email" });
    const repo = new InMemoryNudgeRepository();
    repo.addCandidate(loop);
    // No email registered for this user

    const result = await checkNudge(loop.id, { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_not_found");
  });

  it("returns suppressed_ineligible for a snoozed loop", async () => {
    const loop = makeCandidate({ status: "snoozed" });
    const repo = makeRepo(loop);

    const result = await checkNudge(loop.id, { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_ineligible");
  });

  it("returns suppressed_daily_cap when the cap is exhausted", async () => {
    const loop = makeCandidate();
    const repo = makeRepo(loop);
    repo.nudgesSentCount = MAX_NUDGES_PER_USER_PER_DAY;

    const result = await checkNudge(loop.id, { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_daily_cap");
  });

  it("exposes loop and toEmail in the clear result", async () => {
    const loop = makeCandidate({ id: "loop-clear" });
    const repo = makeRepo(loop);

    const result = await checkNudge(loop.id, { repository: repo, now: NOW });
    if (result.status !== "clear") throw new Error("expected clear");

    expect(result.loop.id).toBe("loop-clear");
    expect(result.toEmail).toBe(USER_EMAIL);
  });
});
