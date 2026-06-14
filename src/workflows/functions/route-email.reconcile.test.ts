import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
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
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";

/**
 * Phase 7 B2c — dispatch tests for the ask-confirm reply handler, through routeEmail with
 * in-memory fakes (mirroring route-email.c4.test.ts). A single store backs both the loop
 * repository and the reply-target store so the suppressed/candidate loops and the
 * originating nudge metadata round-trip in one place.
 */

type RecordedReconcileEvent = {
  userId: string;
  loopId: string;
  eventType: "reconciled" | "reconcile_suggested" | "superseded";
  metadata: Record<string, unknown>;
};

class InMemoryStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly loops = new Map<string, PersistedLoop>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  readonly reconcileEvents: RecordedReconcileEvent[] = [];
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  seedLoop(loop: PersistedLoop) {
    this.loops.set(loop.id, loop);
  }

  seedNudge(nudgeId: string, userId: string, metadata: PrivateReplyNudgeMetadata) {
    this.nudges.set(nudgeId, {
      nudge: { id: nudgeId, userId, inboundEmailId: "inbound-prev", body: "" },
      metadata,
    });
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
        id: this.allocateId("loop"),
        userId: input.email.userId,
        emailThreadId: input.email.emailThreadId,
        inboundEmailId: input.email.id,
        sourceEvidenceId: this.allocateId("evidence"),
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
    return this.storeNudge(input.userId, input.inboundEmailId, input.body, input.metadata);
  }
  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    return this.storeNudge(input.userId, input.inboundEmailId, input.body, {
      kind: "private_reply",
      intent: input.intent,
      loopCount: 0,
      lowConfidence: false,
      ordinalMap: {},
    });
  }
  async listCommandableLoops(): Promise<PersistedLoop[]> {
    // The router always passes nudge-scoped loops, so this should never be hit.
    return [];
  }
  async updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
    source?: "email_command" | "report_row_action" | "auto_reconcile";
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
  async recordReconciliationEvent(input: RecordedReconcileEvent): Promise<void> {
    this.reconcileEvents.push(input);
  }

  // --- ReplyTargetStore ---
  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata } : null;
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

  private storeNudge(
    userId: string,
    inboundEmailId: string,
    body: string,
    metadata: PrivateReplyNudgeMetadata,
  ): PersistedNudge {
    const nudge: PersistedNudge = { id: randomUUID(), userId, inboundEmailId, body };
    this.nudges.set(nudge.id, { nudge, metadata });
    return nudge;
  }
  private allocateId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }
}

function makeEmail(id: string, overrides: Partial<NormalizedEmail>): ProcessableInboundEmail {
  return {
    id,
    userId: "user-1",
    emailThreadId: "thread-1",
    emailMessageId: `message-${id}`,
    normalized: { ...normalizePostmarkInbound(directPostmarkFixture), ...overrides },
  };
}

function makeLoop(id: string, status: LoopStatus, overrides: Partial<PersistedLoop> = {}): PersistedLoop {
  return {
    id,
    userId: "user-1",
    emailThreadId: "thread-1",
    inboundEmailId: "inbound-prev",
    sourceEvidenceId: `ev-${id}`,
    status,
    summary: `Loop ${id}.`,
    sourceQuote: `Loop ${id}.`,
    confidence: 0.6,
    nextCheckAt: null,
    ...overrides,
  };
}

function reconcileMetadata(
  pairs: { suppressedLoopId: string; candidateLoopId: string }[],
): PrivateReplyNudgeMetadata {
  return {
    kind: "private_reply",
    intent: "capture",
    loopCount: 0,
    lowConfidence: false,
    ordinalMap: {},
    pendingReconciliations: pairs,
  };
}

const NOW = new Date("2026-06-12T16:00:00.000Z");

function makeDeps(store: InMemoryStore, sent: string[], extra: Partial<RouterDeps> = {}): RouterDeps {
  return {
    repository: store,
    replyTargetStore: store,
    sendReply: async (nudgeId: string) => {
      sent.push(nudgeId);
    },
    useModel: false,
    now: NOW,
    ...extra,
  };
}

describe("routeEmail — reconcile-confirm (Phase 7 B2c)", () => {
  it("(a) YES merges: suppressed loop dismissed + candidate confirmed + 'superseded' event + confirm reply", async () => {
    const store = new InMemoryStore();
    const sent: string[] = [];
    store.seedLoop(makeLoop("suppressed-1", "suppressed"));
    store.seedLoop(makeLoop("candidate-1", "candidate"));
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", reconcileMetadata([
      { suppressedLoopId: "suppressed-1", candidateLoopId: "candidate-1" },
    ]));
    store.addEmail(makeEmail("inbound-yes", { mailboxHash: `n_${nudgeId}`, textBody: "yes", strippedTextReply: "yes" }));

    const result = await routeEmail("inbound-yes", makeDeps(store, sent));

    expect(result.branch).toBe("command");
    expect(store.loops.get("suppressed-1")?.status).toBe("dismissed");
    expect(store.loops.get("candidate-1")?.status).toBe("open");

    const superseded = store.reconcileEvents.find((e) => e.eventType === "superseded");
    expect(superseded).toMatchObject({
      loopId: "suppressed-1",
      eventType: "superseded",
      metadata: { supersededBy: "candidate-1", confirmedByUser: true },
    });

    expect(sent).toEqual([result.nudgeId]);
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toContain("Merged");
    // Two loop.updated events (dismiss + confirm) plus the email.classified.
    expect(result.events.map((e) => e.name)).toEqual([
      "email.classified",
      "loop.updated",
      "loop.updated",
    ]);
  });

  it("(b) NO keeps separate: suppressed loop promoted to 'open' + provenance event + reply", async () => {
    const store = new InMemoryStore();
    const sent: string[] = [];
    store.seedLoop(makeLoop("suppressed-2", "suppressed"));
    store.seedLoop(makeLoop("candidate-2", "candidate"));
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", reconcileMetadata([
      { suppressedLoopId: "suppressed-2", candidateLoopId: "candidate-2" },
    ]));
    store.addEmail(makeEmail("inbound-no", { mailboxHash: `n_${nudgeId}`, textBody: "no", strippedTextReply: "no" }));

    const result = await routeEmail("inbound-no", makeDeps(store, sent));

    expect(result.branch).toBe("command");
    expect(store.loops.get("suppressed-2")?.status).toBe("open");
    // The candidate is left untouched when kept separate.
    expect(store.loops.get("candidate-2")?.status).toBe("candidate");

    const kept = store.reconcileEvents.find((e) => e.metadata.keptSeparate === true);
    expect(kept).toMatchObject({
      loopId: "suppressed-2",
      eventType: "reconciled",
      metadata: { keptSeparate: true, confirmedByUser: true, candidateLoopId: "candidate-2" },
    });

    expect(sent).toEqual([result.nudgeId]);
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toContain("separate");
  });

  it("(c) a YES reply on a nudge with NO pendingReconciliations falls through to normal handling", async () => {
    const store = new InMemoryStore();
    const sent: string[] = [];
    const nudgeId = randomUUID();
    // A plain capture/command nudge — no pending asks.
    store.seedNudge(nudgeId, "user-1", {
      kind: "private_reply",
      intent: "capture",
      loopCount: 0,
      lowConfidence: false,
      ordinalMap: {},
    });
    store.addEmail(makeEmail("inbound-bareyes", { mailboxHash: `n_${nudgeId}`, textBody: "yes", strippedTextReply: "yes" }));

    const result = await routeEmail("inbound-bareyes", makeDeps(store, sent));

    // Reconcile-confirm did NOT fire (no superseded/keptSeparate events written).
    expect(store.reconcileEvents).toEqual([]);
    // "yes" classifies as capture intent → capture branch (unchanged behavior).
    expect(result.branch).toBe("capture");
  });

  it("(d) an unrelated command ('done 1') on a nudge that HAS pending asks is NOT hijacked — parses as a normal command", async () => {
    const store = new InMemoryStore();
    const sent: string[] = [];
    // The nudge lists a real loop at ordinal 1 (so 'done 1' resolves) AND carries a pending ask.
    store.seedLoop(makeLoop("listed-1", "open"));
    store.seedLoop(makeLoop("suppressed-3", "suppressed"));
    store.seedLoop(makeLoop("candidate-3", "candidate"));
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", {
      kind: "private_reply",
      intent: "capture",
      loopCount: 1,
      lowConfidence: false,
      ordinalMap: { 1: "listed-1" },
      pendingReconciliations: [{ suppressedLoopId: "suppressed-3", candidateLoopId: "candidate-3" }],
    });
    store.addEmail(makeEmail("inbound-done", { mailboxHash: `n_${nudgeId}`, textBody: "done 1", strippedTextReply: "done 1" }));

    const result = await routeEmail("inbound-done", makeDeps(store, sent));

    // The command branch ran (not reconcile-confirm): 'done 1' marked the listed loop done,
    // and the suppressed/candidate loops were left untouched.
    expect(result.branch).toBe("command");
    expect(store.loops.get("listed-1")?.status).toBe("done");
    expect(store.loops.get("suppressed-3")?.status).toBe("suppressed");
    expect(store.loops.get("candidate-3")?.status).toBe("candidate");
    expect(store.reconcileEvents).toEqual([]);
  });

  it("applies YES to ALL listed pending pairs", async () => {
    const store = new InMemoryStore();
    const sent: string[] = [];
    store.seedLoop(makeLoop("suppressed-a", "suppressed"));
    store.seedLoop(makeLoop("candidate-a", "candidate"));
    store.seedLoop(makeLoop("suppressed-b", "suppressed"));
    store.seedLoop(makeLoop("candidate-b", "candidate"));
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", reconcileMetadata([
      { suppressedLoopId: "suppressed-a", candidateLoopId: "candidate-a" },
      { suppressedLoopId: "suppressed-b", candidateLoopId: "candidate-b" },
    ]));
    store.addEmail(makeEmail("inbound-yesall", { mailboxHash: `n_${nudgeId}`, textBody: "merge", strippedTextReply: "merge" }));

    await routeEmail("inbound-yesall", makeDeps(store, sent));

    expect(store.loops.get("suppressed-a")?.status).toBe("dismissed");
    expect(store.loops.get("candidate-a")?.status).toBe("open");
    expect(store.loops.get("suppressed-b")?.status).toBe("dismissed");
    expect(store.loops.get("candidate-b")?.status).toBe("open");
    expect(store.reconcileEvents.filter((e) => e.eventType === "superseded")).toHaveLength(2);
  });
});
