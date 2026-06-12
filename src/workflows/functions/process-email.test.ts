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
import type {
  ReplyTargetStore,
  ResolvableNudge,
} from "@/loops/resolve-reply-target";
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";

/**
 * A single in-memory store that backs both the `LoopProcessingRepository` the router
 * writes through and the `ReplyTargetStore` it resolves replies against, so a capture
 * run and a later reply share the same loops/nudges state (full round-trip).
 */
class InMemoryRouterStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly loops = new Map<string, PersistedLoop>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  readonly corrections: { userId: string; loopId: string; commandText: string }[] = [];
  /** in_reply_to provider message id → nudge id, as the outbound recorder would store. */
  readonly outboundByInReplyTo = new Map<string, string>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  // --- LoopProcessingRepository ---

  async findInboundEmailById(inboundEmailId: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(inboundEmailId) ?? null;
  }

  async findLoopsByInboundEmailId(inboundEmailId: string): Promise<PersistedLoop[]> {
    return [...this.loops.values()].filter((loop) => loop.inboundEmailId === inboundEmailId);
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
    if (!existing) {
      throw new Error(`Missing loop ${input.loopId}`);
    }
    const updated: PersistedLoop = {
      ...existing,
      status: input.status,
      nextCheckAt: input.nextCheckAt ?? existing.nextCheckAt,
    };
    this.loops.set(updated.id, updated);
    return updated;
  }

  async recordLoopCorrection(input: { userId: string; loopId: string; commandText: string }): Promise<void> {
    this.corrections.push(input);
  }

  // --- ReplyTargetStore ---

  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata } : null;
  }

  async findNudgeByOutboundInReplyTo(inReplyTo: string): Promise<ResolvableNudge | null> {
    const nudgeId = this.outboundByInReplyTo.get(inReplyTo);
    return nudgeId ? this.findNudgeById(nudgeId) : null;
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
    // UUID-shaped so the reply resolver's `^n_[0-9a-f-]+$` mailbox-hash pattern matches.
    const nudge: PersistedNudge = { id: randomUUID(), userId, inboundEmailId, body };
    this.nudges.set(nudge.id, { nudge, metadata });
    return nudge;
  }

  private allocateId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }
}

function makeEmail(id: string, fixtureOverrides: Partial<NormalizedEmail>): ProcessableInboundEmail {
  return {
    id,
    userId: "user-1",
    emailThreadId: "thread-1",
    emailMessageId: `message-${id}`,
    normalized: { ...normalizePostmarkInbound(directPostmarkFixture), ...fixtureOverrides },
  };
}

function makeDeps(store: InMemoryRouterStore, sent: string[]): RouterDeps {
  return {
    repository: store,
    replyTargetStore: store,
    sendReply: async (nudgeId: string) => {
      sent.push(nudgeId);
    },
    useModel: false,
  };
}

describe("routeEmail branch dispatch", () => {
  it("dispatches capture for a plain capture email", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-cap", {}));

    const result = await routeEmail("inbound-cap", makeDeps(store, sent));

    expect(result.branch).toBe("capture");
    expect(result.status).toBe("processed");
    expect(result.loops.length).toBeGreaterThan(0);
    expect(sent).toEqual([result.nudgeId]);
    expect(result.events.some((event) => event.name === "loop.created")).toBe(true);
  });

  it("dispatches command for a dismiss reply and emits classified with branch", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    // Seed a loop and a nudge whose ordinalMap lists it as #1.
    const loop: PersistedLoop = {
      id: "loop-x",
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-prev",
      sourceEvidenceId: "evidence-x",
      status: "open",
      summary: "Send the renewal packet.",
      sourceQuote: "Send the renewal packet.",
      confidence: 0.9,
      nextCheckAt: null,
    };
    const cmdNudgeId = "11111111-1111-1111-1111-111111111111";
    store.loops.set(loop.id, loop);
    store.nudges.set(cmdNudgeId, {
      nudge: { id: cmdNudgeId, userId: "user-1", inboundEmailId: "inbound-prev", body: "" },
      metadata: { kind: "private_reply", intent: "capture", loopCount: 1, lowConfidence: false, ordinalMap: { 1: loop.id } },
    });
    store.addEmail(
      makeEmail("inbound-cmd", {
        mailboxHash: `n_${cmdNudgeId}`,
        textBody: "dismiss 1",
        strippedTextReply: "dismiss 1",
      }),
    );

    const result = await routeEmail("inbound-cmd", makeDeps(store, sent));

    expect(result.branch).toBe("command");
    expect(store.loops.get("loop-x")?.status).toBe("dismissed");
    expect(result.events[0]).toMatchObject({
      name: "email.classified",
      data: { intent: "command", branch: "command" },
    });
    expect(sent).toHaveLength(1);
  });

  it("dispatches correction and records a loop correction", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    const loop: PersistedLoop = {
      id: "loop-c",
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-prev",
      sourceEvidenceId: "evidence-c",
      status: "open",
      summary: "Vendor pricing follow-up.",
      sourceQuote: "Vendor pricing follow-up.",
      confidence: 0.9,
      nextCheckAt: null,
    };
    const corrNudgeId = "22222222-2222-2222-2222-222222222222";
    store.loops.set(loop.id, loop);
    store.nudges.set(corrNudgeId, {
      nudge: { id: corrNudgeId, userId: "user-1", inboundEmailId: "inbound-prev", body: "" },
      metadata: { kind: "private_reply", intent: "capture", loopCount: 1, lowConfidence: false, ordinalMap: { 1: loop.id } },
    });
    store.addEmail(
      makeEmail("inbound-corr", {
        mailboxHash: `n_${corrNudgeId}`,
        textBody: "correct: Sam owns this, not me",
        strippedTextReply: "correct: Sam owns this, not me",
      }),
    );

    const result = await routeEmail("inbound-corr", makeDeps(store, sent));

    expect(result.branch).toBe("correction");
    expect(store.corrections).toEqual([
      { userId: "user-1", loopId: "loop-c", commandText: "correct: Sam owns this, not me" },
    ]);
    expect(sent).toHaveLength(1);
  });

  it("dispatches question with a stub reply", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(
      makeEmail("inbound-q", {
        textBody: "what are my open loops?",
        strippedTextReply: "what are my open loops?",
      }),
    );

    const result = await routeEmail("inbound-q", makeDeps(store, sent));

    expect(result.branch).toBe("question");
    expect(result.loops).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(result.events).toEqual([
      expect.objectContaining({ name: "email.classified", data: expect.objectContaining({ branch: "question" }) }),
    ]);
  });

  it("dispatches approval with a stub reply", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(
      makeEmail("inbound-a", {
        textBody: "approve",
        strippedTextReply: "approve",
      }),
    );

    const result = await routeEmail("inbound-a", makeDeps(store, sent));

    expect(result.branch).toBe("approval");
    expect(sent).toHaveLength(1);
  });
});

describe("routeEmail idempotency", () => {
  it("returns already_processed and creates zero new rows on re-run", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-idem", {}));

    const first = await routeEmail("inbound-idem", makeDeps(store, sent));
    const loopCountAfterFirst = store.loops.size;
    const nudgeCountAfterFirst = store.nudges.size;

    const second = await routeEmail("inbound-idem", makeDeps(store, sent));

    expect(first.status).toBe("processed");
    expect(second.status).toBe("already_processed");
    expect(second.events).toEqual([]);
    expect(store.loops.size).toBe(loopCountAfterFirst);
    expect(store.nudges.size).toBe(nudgeCountAfterFirst);
    // The second run sent no new reply.
    expect(sent).toHaveLength(1);
  });
});

describe("routeEmail reply round-trip", () => {
  it("capture → nudge sent → reply with MailboxHash + 'dismiss 1' dismisses loop #1", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    const deps = makeDeps(store, sent);

    // 1. Capture: a plain email that produces at least one loop and a private-reply nudge.
    store.addEmail(makeEmail("inbound-rt", {}));
    const capture = await routeEmail("inbound-rt", deps);
    expect(capture.status).toBe("processed");
    expect(capture.nudgeId).not.toBeNull();
    const nudgeId = capture.nudgeId as string;
    const listedLoopId = capture.loops[0]?.id;
    expect(listedLoopId).toBeTruthy();

    // 2. The nudge's ordinalMap lists the captured loop as #1.
    const nudgeEntry = store.nudges.get(nudgeId);
    expect(nudgeEntry?.metadata.ordinalMap[1]).toBe(listedLoopId);

    // 3. Simulated reply addressed to that nudge with "dismiss 1".
    store.addEmail(
      makeEmail("inbound-reply", {
        mailboxHash: `n_${nudgeId}`,
        textBody: "dismiss 1",
        strippedTextReply: "dismiss 1",
      }),
    );
    const reply = await routeEmail("inbound-reply", deps);

    expect(reply.branch).toBe("command");
    expect(store.loops.get(listedLoopId as string)?.status).toBe("dismissed");
  });
});
