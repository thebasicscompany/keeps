/**
 * E1 — End-to-end nudge cycle integration test.
 *
 * Tests the full cycle: sweepNudges → sendNudgeEmail → reply (snooze) via
 * routeEmail, using in-memory fakes only (no live DB, no Inngest, no Postmark).
 *
 * Fakes are adapted from the patterns in:
 *   - src/workflows/functions/send-nudge.test.ts (InMemoryNudgeRepository)
 *   - src/workflows/functions/route-email.c4.test.ts (InMemoryRouterStore)
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import { DEFAULT_NEXT_NUDGE_WINDOW_DAYS } from "@/nudges/policy";
import type { NudgeCandidate, NudgeRepository } from "@/nudges/repository";
import type { NudgeType } from "@/nudges/types";
import { sweepNudges } from "@/workflows/functions/sweep-nudges";
import { sendNudgeEmail } from "@/workflows/functions/send-nudge";
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";
import type { LoopStatus } from "@/agent/schemas";
import { normalizePostmarkInbound } from "@/email/normalize";
import { directPostmarkFixture } from "@/email/fixtures/postmark";
import type {
  LoopProcessingRepository,
  LoopToPersist,
  PersistedLoop,
  PersistedNudge,
  PrivateReplyNudgeMetadata,
  ProcessableInboundEmail,
} from "@/loops/service";
import type { ReplyTargetStore, ResolvableNudge } from "@/loops/resolve-reply-target";

// ---------------------------------------------------------------------------
// In-memory fakes (adapted from send-nudge.test.ts and route-email.c4.test.ts)
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

/**
 * A richer in-memory nudge repository that supports:
 *  - mutable loop state (so cooldown / snooze assertions work)
 *  - snooze mutation via a dedicated method (called by the router's command branch
 *    through updateLoopFromCommand on the router store, but we also need a way to
 *    update the nudge-candidate state so sweepNudges sees the new status)
 */
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
    this.candidatesById.set(c.id, { ...c });
  }

  addUserEmail(userId: string, email: string) {
    this.userEmails.set(userId, email);
  }

  /** Mutates a candidate in place (simulates DB update for cooldown/snooze). */
  updateCandidate(loopId: string, patch: Partial<NudgeCandidate>) {
    const existing = this.candidatesById.get(loopId);
    if (existing) {
      this.candidatesById.set(loopId, { ...existing, ...patch });
    }
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
    // Mutate the in-memory candidate so subsequent sweeps see updated state.
    this.updateCandidate(input.loopId, {
      lastNudgedAt: input.now,
      nudgeCount: (this.candidatesById.get(input.loopId)?.nudgeCount ?? 0) + 1,
      nextCheckAt: input.nextCheckAt,
    });
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
// Router store — backs both LoopProcessingRepository and ReplyTargetStore so
// the snooze command can look up loops and update them, mirroring the pattern
// in route-email.c4.test.ts.
// ---------------------------------------------------------------------------

class InMemoryRouterStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly loops = new Map<string, PersistedLoop>();
  readonly nudges = new Map<
    string,
    { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }
  >();
  readonly timezones = new Map<string, string>();

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  seedNudge(nudgeId: string, userId: string, metadata: PrivateReplyNudgeMetadata) {
    this.nudges.set(nudgeId, {
      nudge: { id: nudgeId, userId, inboundEmailId: "inbound-prev", body: "" },
      metadata,
    });
  }

  seedLoop(loop: PersistedLoop) {
    this.loops.set(loop.id, loop);
  }

  // --- LoopProcessingRepository ---
  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }
  async findLoopsByInboundEmailId(id: string): Promise<PersistedLoop[]> {
    return [...this.loops.values()].filter((l) => l.inboundEmailId === id);
  }
  async persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    return input.loops.map((candidate) => {
      const loop: PersistedLoop = {
        id: randomUUID(),
        userId: input.email.userId,
        emailThreadId: input.email.emailThreadId,
        inboundEmailId: input.email.id,
        sourceEvidenceId: randomUUID(),
        status: candidate.status,
        summary: candidate.summary,
        sourceQuote: candidate.source.quote,
        confidence: candidate.confidence,
        nextCheckAt: candidate.nextCheckAt ? new Date(candidate.nextCheckAt) : null,
      };
      this.loops.set(loop.id, loop);
      return loop;
    });
  }
  async createPrivateReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge> {
    return this._storeNudge(input.userId, input.inboundEmailId, input.body, input.metadata);
  }
  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    return this._storeNudge(input.userId, input.inboundEmailId, input.body, {
      kind: "private_reply",
      intent: input.intent,
      loopCount: 0,
      lowConfidence: false,
      ordinalMap: {},
    });
  }
  async listCommandableLoops(): Promise<PersistedLoop[]> {
    throw new Error("listCommandableLoops must not be called by the router");
  }
  async updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
  }): Promise<PersistedLoop> {
    const existing = this.loops.get(input.loopId);
    if (!existing) throw new Error(`Missing loop ${input.loopId}`);
    const updated: PersistedLoop = {
      ...existing,
      status: input.status,
      nextCheckAt: input.nextCheckAt ?? existing.nextCheckAt,
    };
    this.loops.set(updated.id, updated);
    return updated;
  }
  async recordLoopCorrection(): Promise<void> {}
  async findUserTimezone(userId: string): Promise<string | null> {
    return this.timezones.get(userId) ?? null;
  }

  // --- ReplyTargetStore ---
  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry
      ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata }
      : null;
  }
  async findNudgeByOutboundInReplyTo(): Promise<ResolvableNudge | null> {
    return null;
  }
  async findLoopsByIds(loopIds: string[]): Promise<PersistedLoop[]> {
    return loopIds.flatMap((id) => {
      const loop = this.loops.get(id);
      return loop ? [loop] : [];
    });
  }

  private _storeNudge(
    userId: string,
    inboundEmailId: string,
    body: string,
    metadata: PrivateReplyNudgeMetadata,
  ): PersistedNudge {
    const nudge: PersistedNudge = { id: randomUUID(), userId, inboundEmailId, body };
    this.nudges.set(nudge.id, { nudge, metadata });
    return nudge;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPLY_TO_BASE = "agent@keeps.ai";
const USER_ID = "user-nudge-cycle-001";
const USER_EMAIL = "owner@example.com";
const USER_TZ = "America/Los_Angeles";

// "now" is a Wednesday at 12:00 UTC. In Los Angeles (UTC-7, PDT in June) that
// is Wed 05:00 PDT. Next Monday 09:00 PDT = Mon 2026-06-15 09:00 PDT = UTC 16:00.
const NOW = new Date("2026-06-10T12:00:00.000Z"); // Wednesday

function makeCandidate(
  id: string,
  overrides: Partial<NudgeCandidate> = {},
): NudgeCandidate {
  return {
    id,
    userId: USER_ID,
    status: "open",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    nextCheckAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h before NOW → due
    lastNudgedAt: null,
    nudgeCount: 0,
    summary: "Follow up on the renewal packet",
    userTimezone: USER_TZ,
    ...overrides,
  };
}

function makeEmail(
  id: string,
  userId: string,
  overrides: Partial<ReturnType<typeof normalizePostmarkInbound>>,
): ProcessableInboundEmail {
  return {
    id,
    userId,
    emailThreadId: "thread-nudge-cycle",
    emailMessageId: `message-${id}`,
    normalized: { ...normalizePostmarkInbound(directPostmarkFixture), ...overrides },
  };
}

// ---------------------------------------------------------------------------
// E1 — nudge cycle
// ---------------------------------------------------------------------------

describe("nudge cycle — sweep → send → cooldown → snooze", () => {
  it("sweep emits exactly one loop.nudge_due for a past-due open loop", async () => {
    const loopId = randomUUID();
    const repo = new InMemoryNudgeRepository();
    repo.addCandidate(makeCandidate(loopId));
    repo.addUserEmail(USER_ID, USER_EMAIL);

    const result = await sweepNudges({ repository: repo, now: NOW });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe("loop.nudge_due");
    expect(result.events[0]?.data.loopId).toBe(loopId);
  });

  it("sendNudgeEmail sends an email with a plus-routed n_<nudgeId> Reply-To", async () => {
    const loopId = randomUUID();
    const repo = new InMemoryNudgeRepository();
    repo.addCandidate(makeCandidate(loopId));
    repo.addUserEmail(USER_ID, USER_EMAIL);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loopId, {
      repository: repo,
      sender: new DevRecordingSender(),
      store,
      replyToBase: REPLY_TO_BASE,
      now: NOW,
    });

    expect(result.status).toBe("sent");
    if (result.status !== "sent") return;

    // Outbound email recorded
    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]?.toEmail).toBe(USER_EMAIL);
    expect(store.sends[0]?.replyTo).toBe(`agent+n_${result.nudgeId}@keeps.ai`);
    expect(store.sends[0]?.mailboxHash).toBe(`n_${result.nudgeId}`);
  });

  it("sendNudgeEmail stamps loop bookkeeping: lastNudgedAt, nudgeCount++, nextCheckAt +3d, nudged event, audit", async () => {
    const loopId = randomUUID();
    const repo = new InMemoryNudgeRepository();
    repo.addCandidate(makeCandidate(loopId));
    repo.addUserEmail(USER_ID, USER_EMAIL);
    const store = new InMemoryOutboundEmailStore();

    const result = await sendNudgeEmail(loopId, {
      repository: repo,
      sender: new DevRecordingSender(),
      store,
      replyToBase: REPLY_TO_BASE,
      now: NOW,
    });
    expect(result.status).toBe("sent");

    // markLoopNudged was called
    expect(repo.markedNudged).toHaveLength(1);
    expect(repo.markedNudged[0]?.loopId).toBe(loopId);
    expect(repo.markedNudged[0]?.now).toEqual(NOW);

    // nextCheckAt advances by DEFAULT_NEXT_NUDGE_WINDOW_DAYS (3 days)
    const expectedNextCheck = new Date(
      NOW.getTime() + DEFAULT_NEXT_NUDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(repo.markedNudged[0]?.nextCheckAt.getTime()).toBe(expectedNextCheck.getTime());

    // markNudgeSent was called on the store
    if (result.status === "sent") {
      expect(store.sentNudges).toHaveLength(1);
      expect(store.sentNudges[0]?.nudgeId).toBe(result.nudgeId);
      expect(store.sentNudges[0]?.sentAt).toEqual(NOW);
    }

    // loop_events 'nudged' written
    expect(repo.loopEvents).toHaveLength(1);
    expect(repo.loopEvents[0]?.eventType).toBe("nudged");
    expect(repo.loopEvents[0]?.loopId).toBe(loopId);

    // audit 'nudge.sent' written
    expect(repo.audits).toHaveLength(1);
    expect(repo.audits[0]?.action).toBe("nudge.sent");
    expect(repo.audits[0]?.userId).toBe(USER_ID);
    if (result.status === "sent") {
      expect(repo.audits[0]?.metadata.nudgeId).toBe(result.nudgeId);
    }
    expect(repo.audits[0]?.metadata.loopId).toBe(loopId);

    // nudge metadata has ordinalMap { 1: loopId }
    const meta = repo.nudgeRows[0]?.metadata as Record<string, unknown>;
    const ordinalMap = meta?.ordinalMap as Record<number, string>;
    expect(ordinalMap[1]).toBe(loopId);
    expect(meta?.kind).toBe("nudge");
  });

  it("second sweep at the same now is suppressed by cooldown (loop just nudged)", async () => {
    const loopId = randomUUID();
    const repo = new InMemoryNudgeRepository();
    repo.addCandidate(makeCandidate(loopId));
    repo.addUserEmail(USER_ID, USER_EMAIL);
    const store = new InMemoryOutboundEmailStore();

    // First sweep + send
    await sendNudgeEmail(loopId, {
      repository: repo,
      sender: new DevRecordingSender(),
      store,
      replyToBase: REPLY_TO_BASE,
      now: NOW,
    });

    // After markLoopNudged, the in-memory candidate has lastNudgedAt = NOW
    // and nextCheckAt = NOW + 3d. Both make it ineligible for another nudge.

    // Second sweep at the same instant
    const secondSweep = await sweepNudges({ repository: repo, now: NOW });

    // The loop now has nextCheckAt = NOW + 3d which is > NOW, so the SQL
    // pre-filter returns nothing. Even if it did return something, the cooldown
    // would suppress it. Verify no events emitted.
    expect(secondSweep.events).toHaveLength(0);
  });

  it("snooze leg: 'snooze 1 until Monday' via routeEmail sets status=snoozed and next_check_at to user-local Monday 9 AM (LA TZ), and the subsequent sweep does NOT emit for the snoozed loop", async () => {
    // Wednesday 2026-06-10T12:00:00Z = Wed 05:00 PDT
    // Next Monday 09:00 PDT = 2026-06-15T16:00:00Z
    const SNOOZE_NOW = new Date("2026-06-10T12:00:00.000Z");
    const EXPECTED_SNOOZE_UTC = new Date("2026-06-15T16:00:00.000Z");

    const loopId = "loop-snooze-la";

    // Set up the nudge repo for the sweep
    const nudgeRepo = new InMemoryNudgeRepository();
    nudgeRepo.addCandidate(makeCandidate(loopId));
    nudgeRepo.addUserEmail(USER_ID, USER_EMAIL);

    // Send the nudge first (to get the nudgeId)
    const store = new InMemoryOutboundEmailStore();
    const sendResult = await sendNudgeEmail(loopId, {
      repository: nudgeRepo,
      sender: new DevRecordingSender(),
      store,
      replyToBase: REPLY_TO_BASE,
      now: SNOOZE_NOW,
    });
    expect(sendResult.status).toBe("sent");
    if (sendResult.status !== "sent") return;

    const nudgeId = sendResult.nudgeId;

    // Set up the router store so the command can look up the loop and update it
    const routerStore = new InMemoryRouterStore();
    routerStore.timezones.set(USER_ID, USER_TZ);
    // Seed the loop in the router store
    routerStore.seedLoop({
      id: loopId,
      userId: USER_ID,
      emailThreadId: "thread-nudge-cycle",
      inboundEmailId: "inbound-orig",
      sourceEvidenceId: "ev-1",
      status: "open",
      summary: "Follow up on the renewal packet",
      sourceQuote: "Follow up on the renewal packet",
      confidence: 0.9,
      nextCheckAt: null,
    });
    // Seed the nudge with ordinalMap so the router knows loopId → ordinal 1
    routerStore.seedNudge(nudgeId, USER_ID, {
      kind: "private_reply",
      intent: "nudge",
      nudgeType: "nudge" as never,
      loopCount: 1,
      lowConfidence: false,
      ordinalMap: { 1: loopId },
    });

    // The inbound reply email references the nudge via mailboxHash
    const snoozeEmailId = "inbound-snooze-reply";
    routerStore.addEmail(
      makeEmail(snoozeEmailId, USER_ID, {
        mailboxHash: `n_${nudgeId}`,
        textBody: "snooze 1 until Monday",
        strippedTextReply: "snooze 1 until Monday",
      }),
    );

    const sent: string[] = [];
    const deps: RouterDeps = {
      repository: routerStore,
      replyTargetStore: routerStore,
      sendReply: async (id) => { sent.push(id); },
      useModel: false,
      now: SNOOZE_NOW,
    };

    const routeResult = await routeEmail(snoozeEmailId, deps);
    expect(routeResult.branch).toBe("command");
    expect(routeResult.status).toBe("processed");

    // Loop should be snoozed with next_check_at = Monday 09:00 PDT
    const updatedLoop = routerStore.loops.get(loopId);
    expect(updatedLoop?.status).toBe("snoozed");
    expect(updatedLoop?.nextCheckAt?.toISOString()).toBe(EXPECTED_SNOOZE_UTC.toISOString());

    // Now reflect the snooze in the nudge repo's candidate so sweepNudges sees it
    nudgeRepo.updateCandidate(loopId, {
      status: "snoozed",
      nextCheckAt: EXPECTED_SNOOZE_UTC,
    });

    // Third sweep: snoozed loop MUST NOT be swept
    const thirdSweep = await sweepNudges({ repository: nudgeRepo, now: SNOOZE_NOW });
    expect(thirdSweep.events).toHaveLength(0);
  });
});
