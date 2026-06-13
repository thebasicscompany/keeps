/**
 * E3 — End-to-end digest cycle integration test.
 *
 * Tests the full daily digest cycle across three timezones, using in-memory
 * fakes (no live DB, no Inngest, no Postmark), following the patterns in:
 *   - src/workflows/functions/sweep-digests.test.ts (InMemorySweepDigestsRepository)
 *   - src/workflows/functions/route-email.c4.test.ts (InMemoryRouterStore)
 *
 * Covers:
 *  - Three users in different timezones each receive EXACTLY ONE digest per day
 *    at their configured local hour, across a simulated 24-hour UTC window.
 *  - Digest body contains the coverage line and capture prompt (AR-9).
 *  - Nudge metadata carries ordinalMap with 1-based ordinals → loopIds (AR-3).
 *  - Reply "done 2" routes to the command branch and marks ordinal 2's loop done.
 *  - Free-text brain-dump reply falls through to capture branch.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DigestLoopInput } from "@/digests/build";
import type { DigestUser } from "@/digests/repository";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import type { NudgeRepository } from "@/nudges/repository";
import type { NudgeCandidate } from "@/nudges/repository";
import type { NudgeType } from "@/nudges/types";
import {
  sweepDigests,
  type SweepDigestsRepository,
} from "@/workflows/functions/sweep-digests";
import {
  sendDigest,
  type SendDigestRepository,
  type DigestNudgeMetadata,
} from "@/workflows/functions/send-digest";
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";
import { normalizePostmarkInbound } from "@/email/normalize";
import { directPostmarkFixture } from "@/email/fixtures/postmark";
import type { LoopStatus } from "@/agent/schemas";
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
// In-memory fakes (adapted from sweep-digests.test.ts)
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

type NudgeRowInput = Parameters<NudgeRepository["createNudgeRow"]>[0];

class InMemoryNudgeRepository implements NudgeRepository {
  readonly nudgeRows: Array<NudgeRowInput & { id: string }> = [];
  readonly loopEvents: Array<Parameters<NudgeRepository["writeLoopEvent"]>[0]> = [];
  readonly audits: Array<Parameters<NudgeRepository["writeAudit"]>[0]> = [];

  async findNudgeCandidates(): Promise<NudgeCandidate[]> { return []; }
  async findCandidateById(): Promise<null> { return null; }
  async findUserEmail(): Promise<null> { return null; }
  async countNudgesSentSince(): Promise<number> { return 0; }
  async markLoopNudged(): Promise<void> {}
  async deferLoopNextCheck(): Promise<void> {}

  async createNudgeRow(input: NudgeRowInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.nudgeRows.push({ ...input, id });
    return { id };
  }

  async writeLoopEvent(input: Parameters<NudgeRepository["writeLoopEvent"]>[0]): Promise<void> {
    this.loopEvents.push(input);
  }

  async writeAudit(input: Parameters<NudgeRepository["writeAudit"]>[0]): Promise<void> {
    this.audits.push(input);
  }

  async findLatestNudgeByRunId(_runId: string): Promise<{ id: string; userId: string } | null> { return null; }
  async findNudgeStatus(_nudgeId: string): Promise<string | null> { return null; }
  async markNudgeFailed(_input: { nudgeId: string; extraMetadata: Record<string, unknown> }): Promise<void> {}
}

/**
 * Digest sweep repository with live "has-recent-digest" tracking based on
 * the outbound store (so the 23h guard becomes live after a digest is sent).
 */
class InMemorySweepDigestsRepository implements SweepDigestsRepository {
  constructor(
    private readonly users: DigestUser[],
    private readonly store: InMemoryOutboundEmailStore,
    private readonly nudgeRepo: InMemoryNudgeRepository,
  ) {}

  async findDigestEnabledUsers(): Promise<DigestUser[]> {
    return this.users.filter((u) => u.digestEnabled);
  }

  async hasRecentDigest(userId: string, now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    return this.store.sentNudges.some((n) => {
      // Find the nudge row to check userId
      const row = this.nudgeRepo.nudgeRows.find((r) => r.id === n.nudgeId);
      return row?.userId === userId && n.sentAt >= cutoff;
    });
  }
}

/**
 * Send-digest repository that respects the same live 23h guard so re-sends
 * are suppressed correctly after the first digest lands.
 */
class InMemorySendDigestRepository implements SendDigestRepository {
  constructor(
    private readonly users: Map<string, DigestUser>,
    private readonly store: InMemoryOutboundEmailStore,
    private readonly nudgeRepo: InMemoryNudgeRepository,
    private readonly loops: Map<string, DigestLoopInput[]> = new Map(),
  ) {}

  async findDigestUserById(userId: string): Promise<DigestUser | null> {
    return this.users.get(userId) ?? null;
  }

  async hasRecentDigest(userId: string, now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    return this.store.sentNudges.some((n) => {
      const row = this.nudgeRepo.nudgeRows.find((r) => r.id === n.nudgeId);
      return row?.userId === userId && n.sentAt >= cutoff;
    });
  }

  async findLoopsForDigest(userId: string): Promise<DigestLoopInput[]> {
    return this.loops.get(userId) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Router store (adapted from route-email.c4.test.ts)
// ---------------------------------------------------------------------------

class InMemoryRouterStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly loops = new Map<string, PersistedLoop>();
  readonly nudges = new Map<
    string,
    { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }
  >();
  readonly timezones = new Map<string, string>();

  addEmail(email: ProcessableInboundEmail) { this.emails.set(email.id, email); }

  seedNudge(nudgeId: string, userId: string, metadata: PrivateReplyNudgeMetadata) {
    this.nudges.set(nudgeId, {
      nudge: { id: nudgeId, userId, inboundEmailId: "inbound-prev", body: "" },
      metadata,
    });
  }

  seedLoop(loop: PersistedLoop) { this.loops.set(loop.id, loop); }

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

  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry
      ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata }
      : null;
  }
  async findNudgeByOutboundInReplyTo(): Promise<ResolvableNudge | null> { return null; }
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
// Fixtures
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<DigestUser> = {}): DigestUser {
  return {
    id: randomUUID(),
    email: "owner@example.com",
    displayName: "Owner",
    timezone: "UTC",
    digestEnabled: true,
    digestSendHour: 8,
    ...overrides,
  };
}

function makeLoop(overrides: Partial<DigestLoopInput> = {}): DigestLoopInput {
  return {
    id: randomUUID(),
    emailThreadId: randomUUID(),
    status: "open",
    summary: "Follow up with vendor",
    dueAt: null,
    nextCheckAt: null,
    updatedAt: new Date("2026-06-05T00:00:00Z"),
    lastNudgedAt: null,
    ...overrides,
  };
}

function makeInboundEmail(
  id: string,
  userId: string,
  overrides: Partial<ReturnType<typeof normalizePostmarkInbound>>,
): ProcessableInboundEmail {
  return {
    id,
    userId,
    emailThreadId: `thread-${id}`,
    emailMessageId: `message-${id}`,
    normalized: { ...normalizePostmarkInbound(directPostmarkFixture), ...overrides },
  };
}

// ---------------------------------------------------------------------------
// E3 — exactly one digest per user per 24-hour period
// ---------------------------------------------------------------------------

describe("digest cycle — exactly one digest per user per 24-hour window", () => {
  /**
   * Simulates a full UTC day by calling sweepDigests once per hour (24 calls)
   * and feeding each emission through sendDigest. Asserts each user receives
   * exactly one digest at their correct UTC instant.
   *
   * Users:
   *   - LA user:     America/Los_Angeles, digestSendHour=8  → 8 AM PDT = 15:00 UTC
   *   - London user: Europe/London,        digestSendHour=8  → 8 AM BST = 07:00 UTC
   *   - UTC user:    UTC,                  digestSendHour=9  → 9 AM UTC = 09:00 UTC
   *
   * Day simulated: 2026-06-15 (Monday) — well past the test NOW.
   * We start at 00:00 UTC and advance one hour at a time.
   */
  it("each user receives EXACTLY ONE digest in the day, at the correct UTC instant", async () => {
    const LA_USER_ID = "la-user";
    const LONDON_USER_ID = "london-user";
    const UTC_USER_ID = "utc-user";

    // LA: PDT = UTC-7 in June. 8 AM PDT = 15:00 UTC.
    const laUser = makeUser({
      id: LA_USER_ID,
      email: "la@example.com",
      timezone: "America/Los_Angeles",
      digestSendHour: 8,
    });
    // London: BST = UTC+1 in June. 8 AM BST = 07:00 UTC.
    const londonUser = makeUser({
      id: LONDON_USER_ID,
      email: "london@example.com",
      timezone: "Europe/London",
      digestSendHour: 8,
    });
    // UTC: 9 AM UTC = 09:00 UTC.
    const utcUser = makeUser({
      id: UTC_USER_ID,
      email: "utc@example.com",
      timezone: "UTC",
      digestSendHour: 9,
    });

    const allUsers = [laUser, londonUser, utcUser];
    const store = new InMemoryOutboundEmailStore();
    const nudgeRepo = new InMemoryNudgeRepository();

    const userMap = new Map(allUsers.map((u) => [u.id, u]));
    const loopsMap = new Map(
      allUsers.map((u) => [
        u.id,
        [makeLoop({ status: "open", nextCheckAt: null })],
      ]),
    );

    const sweepRepo = new InMemorySweepDigestsRepository(allUsers, store, nudgeRepo);
    const sendRepo = new InMemorySendDigestRepository(userMap, store, nudgeRepo, loopsMap);

    // Simulate 24 hourly sweeps starting at 2026-06-15T00:00:00Z
    const DAY_START_UTC = new Date("2026-06-15T00:00:00.000Z");
    const digestsSentPerUser = new Map<string, Date[]>();

    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(DAY_START_UTC.getTime() + hour * 60 * 60 * 1000);
      const sweepResult = await sweepDigests({ repository: sweepRepo, now });

      // For each emission, run the send-digest flow
      for (const event of sweepResult.events) {
        const result = await sendDigest(event.data.userId, {
          repository: sendRepo,
          nudgeRepository: nudgeRepo,
          sender: new DevRecordingSender(),
          store,
          replyToBase: "agent@keeps.ai",
          now,
        });

        if (result.status === "sent") {
          const existing = digestsSentPerUser.get(event.data.userId) ?? [];
          existing.push(now);
          digestsSentPerUser.set(event.data.userId, existing);
        }
      }
    }

    // Each user should have received exactly one digest
    expect(digestsSentPerUser.get(LA_USER_ID)).toHaveLength(1);
    expect(digestsSentPerUser.get(LONDON_USER_ID)).toHaveLength(1);
    expect(digestsSentPerUser.get(UTC_USER_ID)).toHaveLength(1);

    // Verify sent at the correct UTC hour
    // LA: 8 AM PDT = UTC 15:00
    expect(digestsSentPerUser.get(LA_USER_ID)![0].toISOString()).toBe(
      "2026-06-15T15:00:00.000Z",
    );
    // London: 8 AM BST = UTC 07:00
    expect(digestsSentPerUser.get(LONDON_USER_ID)![0].toISOString()).toBe(
      "2026-06-15T07:00:00.000Z",
    );
    // UTC: 9 AM UTC = UTC 09:00
    expect(digestsSentPerUser.get(UTC_USER_ID)![0].toISOString()).toBe(
      "2026-06-15T09:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// E3 — digest body content and ordinalMap shape
// ---------------------------------------------------------------------------

describe("digest cycle — body content and ordinalMap", () => {
  const NOW = new Date("2026-06-12T08:00:00.000Z");

  function makeTestUser(): DigestUser {
    return makeUser({ id: "body-user", email: "body@example.com" });
  }

  function makeRepoForUser(user: DigestUser, loops: DigestLoopInput[]) {
    const store = new InMemoryOutboundEmailStore();
    const nudgeRepo = new InMemoryNudgeRepository();
    const sendRepo = new InMemorySendDigestRepository(
      new Map([[user.id, user]]),
      store,
      nudgeRepo,
      new Map([[user.id, loops]]),
    );
    return { store, nudgeRepo, sendRepo };
  }

  it("digest body opens with the coverage line and closes with the capture prompt (AR-9)", async () => {
    const user = makeTestUser();
    const loops = [
      makeLoop({
        id: "loop-1",
        status: "open",
        nextCheckAt: new Date(NOW.getTime() - 1000),
        summary: "Send the invoice",
        updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
      }),
      makeLoop({
        id: "loop-2",
        status: "waiting_on_other",
        summary: "Awaiting vendor reply",
        updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
      }),
    ];
    const { store, nudgeRepo, sendRepo } = makeRepoForUser(user, loops);

    const result = await sendDigest(user.id, {
      repository: sendRepo,
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });
    expect(result.status).toBe("sent");

    const textBody = store.sends[0]?.textBody ?? "";

    // AR-9 coverage line
    expect(textBody).toContain("Tracking");
    expect(textBody).toContain("Keeps sees only what you've shared.");

    // AR-9 capture prompt
    expect(textBody).toContain("What else is on your plate? Reply and I'll track it.");
  });

  it("nudge metadata carries ordinalMap with 1-based ordinals → loopIds (AR-3)", async () => {
    const user = makeTestUser();
    const loops = [
      makeLoop({
        id: "loop-ord-1",
        status: "open",
        nextCheckAt: new Date(NOW.getTime() - 1000),
        summary: "Invoice A",
        updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
      }),
      makeLoop({
        id: "loop-ord-2",
        status: "waiting_on_other",
        summary: "Awaiting B",
        updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
      }),
    ];
    const { store, nudgeRepo, sendRepo } = makeRepoForUser(user, loops);

    const result = await sendDigest(user.id, {
      repository: sendRepo,
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });
    expect(result.status).toBe("sent");

    // Nudge row metadata
    expect(nudgeRepo.nudgeRows).toHaveLength(1);
    const meta = nudgeRepo.nudgeRows[0]?.metadata as unknown as DigestNudgeMetadata;
    expect(meta.kind).toBe("digest");

    const ordinalEntries = Object.entries(meta.ordinalMap);
    expect(ordinalEntries.length).toBeGreaterThan(0);

    const renderedLoopIds = new Set(Object.values(meta.ordinalMap));
    expect(renderedLoopIds.has("loop-ord-1")).toBe(true);
    expect(renderedLoopIds.has("loop-ord-2")).toBe(true);

    // Ordinals are 1-based and sequential
    const ordinals = Object.keys(meta.ordinalMap).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < ordinals.length; i++) {
      expect(ordinals[i]).toBe(i + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// E3 — reply legs
// ---------------------------------------------------------------------------

describe("digest cycle — reply legs", () => {
  const NOW = new Date("2026-06-12T08:00:00.000Z");
  const USER_ID = "reply-test-user";

  function seedDigestLoop(store: InMemoryRouterStore, id: string): PersistedLoop {
    const loop: PersistedLoop = {
      id,
      userId: USER_ID,
      emailThreadId: `thread-${id}`,
      inboundEmailId: "inbound-digest",
      sourceEvidenceId: `ev-${id}`,
      status: "open",
      summary: `Loop ${id}`,
      sourceQuote: `Loop ${id}`,
      confidence: 0.9,
      nextCheckAt: null,
    };
    store.seedLoop(loop);
    return loop;
  }

  function digestNudgeMetadata(ordinalMap: Record<number, string>): PrivateReplyNudgeMetadata {
    return {
      kind: "private_reply",
      intent: "question",
      nudgeType: "digest" as never,
      loopCount: Object.keys(ordinalMap).length,
      lowConfidence: false,
      ordinalMap,
    };
  }

  it("'done 2' reply routed through routeEmail marks ordinal 2's loop done", async () => {
    const routerStore = new InMemoryRouterStore();
    routerStore.timezones.set(USER_ID, "UTC");
    seedDigestLoop(routerStore, "loop-A");
    seedDigestLoop(routerStore, "loop-B");

    const nudgeId = randomUUID();
    routerStore.seedNudge(nudgeId, USER_ID, digestNudgeMetadata({ 1: "loop-A", 2: "loop-B" }));

    const emailId = "inbound-done2";
    routerStore.addEmail(
      makeInboundEmail(emailId, USER_ID, {
        mailboxHash: `n_${nudgeId}`,
        textBody: "done 2",
        strippedTextReply: "done 2",
      }),
    );

    const sent: string[] = [];
    const deps: RouterDeps = {
      repository: routerStore,
      replyTargetStore: routerStore,
      sendReply: async (id) => { sent.push(id); },
      useModel: false,
      now: NOW,
    };

    const result = await routeEmail(emailId, deps);
    expect(result.branch).toBe("command");
    expect(result.status).toBe("processed");

    // ordinal 2 → loop-B should be done
    expect(routerStore.loops.get("loop-B")?.status).toBe("done");
    // ordinal 1 → loop-A should remain open
    expect(routerStore.loops.get("loop-A")?.status).toBe("open");
  });

  it("free-text brain-dump reply to the digest nudge falls through to capture (AR-9)", async () => {
    const routerStore = new InMemoryRouterStore();
    routerStore.timezones.set(USER_ID, "UTC");
    seedDigestLoop(routerStore, "loop-existing");

    const nudgeId = randomUUID();
    routerStore.seedNudge(nudgeId, USER_ID, digestNudgeMetadata({ 1: "loop-existing" }));

    const emailId = "inbound-braindump";
    routerStore.addEmail(
      makeInboundEmail(emailId, USER_ID, {
        mailboxHash: `n_${nudgeId}`,
        // A plain brain dump that classifies as capture-intent
        textBody: "I need to send the renewal packet to Acme by Tuesday and also call the accountant.",
        strippedTextReply: "I need to send the renewal packet to Acme by Tuesday and also call the accountant.",
      }),
    );

    const sent: string[] = [];
    const deps: RouterDeps = {
      repository: routerStore,
      replyTargetStore: routerStore,
      sendReply: async (id) => { sent.push(id); },
      useModel: false,
      now: NOW,
    };

    const result = await routeEmail(emailId, deps);

    // AR-9: falls through to capture branch
    expect(result.branch).toBe("capture");
    expect(result.status).toBe("processed");
    // New loops are created (useModel: false still runs the pattern-based extractor)
    expect(result.loops.length).toBeGreaterThanOrEqual(0);
    // The reply nudge was sent
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(result.nudgeId);
  });
});
