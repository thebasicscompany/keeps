import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
import type { ApprovalRepository, ApprovalRequestWithDraft } from "@/approvals/repository";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";
import type { DigestLoopInput } from "@/digests/build";
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
import type { AnswerQuestionPorts } from "@/workflows/functions/handlers/answer-question";
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";

/**
 * C4 integration-style tests through routeEmail with in-memory fakes (no live DB/Inngest),
 * following the process-email.test.ts pattern. A single store backs both the loop
 * repository and the reply-target store so capture/reply round-trips share state.
 */
class InMemoryRouterStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly loops = new Map<string, PersistedLoop>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  readonly timezones = new Map<string, string>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
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

class InMemoryApprovalRepository implements ApprovalRepository {
  readonly requests = new Map<string, ApprovalRequest>();
  readonly drafts = new Map<string, Draft>();
  readonly metadataAppends: { id: string; patch: Record<string, unknown> }[] = [];

  seed(request: ApprovalRequest) {
    this.requests.set(request.id, request);
  }

  async insertDraft(input: NewDraft): Promise<Draft> {
    const draft: Draft = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      actionKind: input.actionKind,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      sourceLoopId: input.sourceLoopId ?? null,
      requiresLogin: input.requiresLogin ?? false,
      createdAt: new Date(),
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }
  async insertApprovalRequest(): Promise<ApprovalRequest> {
    throw new Error("not used");
  }
  async findApprovalById(id: string): Promise<ApprovalRequestWithDraft | null> {
    const request = this.requests.get(id);
    if (!request) return null;
    const draft = this.drafts.get(request.draftId) ?? {
      id: request.draftId,
      userId: request.userId,
      actionKind: request.actionKind,
      payload: {},
      sourceLoopId: null,
      requiresLogin: false,
      createdAt: new Date(),
    };
    return { ...request, draft };
  }
  async findApprovalByTokenHash(): Promise<ApprovalRequestWithDraft | null> {
    return null;
  }
  async updateApprovalDecision(input: {
    id: string;
    status: "approved" | "rejected" | "cancelled" | "expired";
    decidedAt: Date;
    decisionChannel: string;
    decisionMetadata?: Record<string, unknown>;
    updatedAt: Date;
  }): Promise<ApprovalRequest | null> {
    const existing = this.requests.get(input.id);
    if (!existing || existing.status !== "pending") return null;
    const updated: ApprovalRequest = {
      ...existing,
      status: input.status,
      decidedAt: input.decidedAt,
      decisionChannel: input.decisionChannel,
      decisionMetadata: (input.decisionMetadata ?? {}) as Record<string, unknown>,
      updatedAt: input.updatedAt,
    };
    this.requests.set(input.id, updated);
    return updated;
  }
  async findPendingExpired(): Promise<ApprovalRequest[]> {
    return [];
  }
  async appendDecisionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<ApprovalRequest | null> {
    this.metadataAppends.push({ id, patch });
    const existing = this.requests.get(id);
    if (!existing || existing.status !== "pending") return null;
    const updated: ApprovalRequest = {
      ...existing,
      decisionMetadata: { ...(existing.decisionMetadata as Record<string, unknown>), ...patch },
    };
    this.requests.set(id, updated);
    return updated;
  }
}

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: overrides.id ?? randomUUID(),
    userId: "user-1",
    draftId: randomUUID(),
    actionKind: "test_action",
    status: "pending",
    tokenHash: "hash",
    expiresAt: new Date("2026-06-19T12:00:00.000Z"),
    decidedAt: null,
    decisionChannel: null,
    decisionMetadata: {},
    createdAt: new Date("2026-06-12T12:00:00.000Z"),
    updatedAt: new Date("2026-06-12T12:00:00.000Z"),
    ...overrides,
  };
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

const NOW = new Date("2026-06-12T16:00:00.000Z");

function makeQuestionPorts(loops: DigestLoopInput[]): AnswerQuestionPorts {
  return {
    async loadUser(userId) {
      return { id: userId, email: "user@example.com", displayName: "User", timezone: "America/Los_Angeles" };
    },
    async findLoopsForDigest() {
      return loops;
    },
    createDigestReplyNudge: undefined as never, // set per-test via store binding below
  };
}

function makeDeps(
  store: InMemoryRouterStore,
  sent: string[],
  extra: Partial<RouterDeps> = {},
): RouterDeps {
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

function digestMetadata(ordinalMap: Record<number, string>): PrivateReplyNudgeMetadata {
  return {
    kind: "private_reply",
    intent: "question",
    nudgeType: "digest",
    loopCount: Object.keys(ordinalMap).length,
    lowConfidence: false,
    ordinalMap,
  };
}

// ---------------------------------------------------------------------------
// Question branch (Deliverable #9)
// ---------------------------------------------------------------------------

describe("routeEmail — question/insights branch", () => {
  it("answers a fresh 'insights' email with a digest-style nudge, persists the ordinal map, and emits report.requested", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-insights", { textBody: "insights", strippedTextReply: "insights" }));

    const digestLoops: DigestLoopInput[] = [
      {
        id: "loop-A",
        emailThreadId: "thread-1",
        status: "open",
        summary: "Send the renewal packet.",
        dueAt: null,
        nextCheckAt: new Date("2026-06-11T00:00:00.000Z"), // next_check_at <= now → needsAttention
        updatedAt: NOW,
        lastNudgedAt: null,
      },
      {
        id: "loop-B",
        emailThreadId: "thread-2",
        status: "waiting_on_other",
        summary: "Awaiting legal sign-off.",
        dueAt: null,
        nextCheckAt: null,
        updatedAt: NOW,
        lastNudgedAt: null,
      },
    ];

    const ports = makeQuestionPorts(digestLoops);
    ports.createDigestReplyNudge = (input) => store.createPrivateReplyNudge(input);

    const result = await routeEmail("inbound-insights", makeDeps(store, sent, { questionPorts: ports }));

    expect(result.branch).toBe("question");
    expect(result.status).toBe("processed");
    expect(sent).toEqual([result.nudgeId]);

    // The persisted nudge carries the renderer's ordinal → loopId map (AR-3).
    const nudge = store.nudges.get(result.nudgeId as string);
    expect(nudge?.metadata.ordinalMap[1]).toBe("loop-A");
    expect(Object.values(nudge?.metadata.ordinalMap ?? {})).toContain("loop-B");

    // report.requested (stub) + email.classified are emitted, in that order.
    expect(result.events.map((e) => e.name)).toEqual(["report.requested", "email.classified"]);
    expect(result.events[0]).toMatchObject({
      name: "report.requested",
      data: { kind: "insights", requestedVia: "email_question", inboundEmailId: "inbound-insights" },
    });
  });

  it("follow-up 'done 2' to the answer nudge resolves ordinal 2 from its stored map", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-insights", { textBody: "insights", strippedTextReply: "insights" }));
    // Seed loops in the store so the command branch can update them.
    store.loops.set("loop-A", {
      id: "loop-A",
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-x",
      sourceEvidenceId: "ev-A",
      status: "open",
      summary: "First.",
      sourceQuote: "First.",
      confidence: 0.9,
      nextCheckAt: null,
    });
    store.loops.set("loop-B", {
      id: "loop-B",
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-x",
      sourceEvidenceId: "ev-B",
      status: "open",
      summary: "Second.",
      sourceQuote: "Second.",
      confidence: 0.9,
      nextCheckAt: null,
    });
    const digestLoops: DigestLoopInput[] = [
      { id: "loop-A", emailThreadId: "thread-1", status: "open", summary: "First.", dueAt: null, nextCheckAt: new Date("2026-06-11T00:00:00.000Z"), updatedAt: NOW, lastNudgedAt: null },
      { id: "loop-B", emailThreadId: "thread-1", status: "open", summary: "Second.", dueAt: null, nextCheckAt: new Date("2026-06-11T00:00:00.000Z"), updatedAt: NOW, lastNudgedAt: null },
    ];
    const ports = makeQuestionPorts(digestLoops);
    ports.createDigestReplyNudge = (input) => store.createPrivateReplyNudge(input);

    const answer = await routeEmail("inbound-insights", makeDeps(store, sent, { questionPorts: ports }));
    const answerNudgeId = answer.nudgeId as string;

    store.addEmail(
      makeEmail("inbound-done", {
        mailboxHash: `n_${answerNudgeId}`,
        textBody: "done 2",
        strippedTextReply: "done 2",
      }),
    );
    const reply = await routeEmail("inbound-done", makeDeps(store, sent, { questionPorts: ports }));

    expect(reply.branch).toBe("command");
    // ordinal 2 → the loop the renderer listed second.
    const secondLoopId = store.nudges.get(answerNudgeId)?.metadata.ordinalMap[2];
    expect(store.loops.get(secondLoopId as string)?.status).toBe("done");
  });

  it("falls back politely for a non-insights question", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.addEmail(
      makeEmail("inbound-q", {
        textBody: "what's the weather like?",
        strippedTextReply: "what's the weather like?",
      }),
    );

    const result = await routeEmail("inbound-q", makeDeps(store, sent, { questionPorts: makeQuestionPorts([]) }));

    expect(result.branch).toBe("question");
    expect(result.loops).toEqual([]);
    const nudge = store.nudges.get(result.nudgeId as string);
    expect(nudge?.nudge.body).toBe("I can't answer that yet — I'll learn to in a future update.");
  });
});

// ---------------------------------------------------------------------------
// Approval branch (Deliverable #13) — nudge-type dispatch precedes intent
// ---------------------------------------------------------------------------

describe("routeEmail — approval branch", () => {
  function setupApproval(replyText: string, approval = makeApproval()) {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    const approvalRepo = new InMemoryApprovalRepository();
    approvalRepo.seed(approval);

    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", {
      kind: "private_reply",
      intent: "approval",
      nudgeType: "approval",
      loopCount: 0,
      lowConfidence: false,
      ordinalMap: {},
      approvalId: approval.id,
    });
    store.addEmail(
      makeEmail("inbound-approval", {
        mailboxHash: `n_${nudgeId}`,
        textBody: replyText,
        strippedTextReply: replyText,
      }),
    );
    const emitted: { name: string }[] = [];
    const deps = makeDeps(store, sent, {
      approvalRepository: approvalRepo,
      approvalEmit: async (name) => {
        emitted.push({ name });
      },
    });
    return { store, sent, approvalRepo, approval, deps, emitted };
  }

  it("'approve' decides the approval approved and dispatches REGARDLESS of classified intent", async () => {
    const { approvalRepo, approval, deps, store, sent } = setupApproval("approve");
    const result = await routeEmail("inbound-approval", deps);

    expect(result.branch).toBe("approval");
    expect(approvalRepo.requests.get(approval.id)?.status).toBe("approved");
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toContain("Approved");
    expect(sent).toEqual([result.nudgeId]);
  });

  it("'reject 1' decides rejected even though it classifies as command", async () => {
    const { approvalRepo, approval, deps } = setupApproval("reject 1");
    const result = await routeEmail("inbound-approval", deps);
    expect(result.branch).toBe("approval");
    expect(approvalRepo.requests.get(approval.id)?.status).toBe("rejected");
  });

  it("'cancel' decides cancelled", async () => {
    const { approvalRepo, approval, deps } = setupApproval("cancel");
    const result = await routeEmail("inbound-approval", deps);
    expect(result.branch).toBe("approval");
    expect(approvalRepo.requests.get(approval.id)?.status).toBe("cancelled");
  });

  it("'edit: ...' records the edit, keeps the approval pending, and does NOT decide", async () => {
    const { approvalRepo, approval, deps, store, sent } = setupApproval("edit: change the date to Friday");
    const result = await routeEmail("inbound-approval", deps);

    expect(result.branch).toBe("approval");
    expect(approvalRepo.requests.get(approval.id)?.status).toBe("pending");
    expect(approvalRepo.metadataAppends).toHaveLength(1);
    expect(approvalRepo.metadataAppends[0]?.patch).toMatchObject({ editText: "change the date to Friday" });
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toContain("stays pending");
    expect(sent).toHaveLength(1);
  });

  it("unknown approval command explains the valid commands", async () => {
    const { deps, store } = setupApproval("maybe later");
    const result = await routeEmail("inbound-approval", deps);
    expect(result.branch).toBe("approval");
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toMatch(/approve, reject, cancel, or edit/);
  });

  it("already-decided approval replies with 'This approval was already <status>.'", async () => {
    const { deps, store } = setupApproval("approve", makeApproval({ status: "approved" }));
    const result = await routeEmail("inbound-approval", deps);
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toBe("This approval was already approved.");
  });

  it("expired-by-clock approval replies with the expired one-liner", async () => {
    const expired = makeApproval({ expiresAt: new Date("2026-06-12T12:00:00.000Z") }); // before NOW
    const { deps, store } = setupApproval("approve", expired);
    const result = await routeEmail("inbound-approval", deps);
    expect(store.nudges.get(result.nudgeId as string)?.nudge.body).toContain("expired");
  });
});

// ---------------------------------------------------------------------------
// Digest reply handling (Deliverables #15, #8/AR-9)
// ---------------------------------------------------------------------------

describe("routeEmail — digest reply commands and free-text fallthrough", () => {
  function seedDigestLoop(store: InMemoryRouterStore, id: string): PersistedLoop {
    const loop: PersistedLoop = {
      id,
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-digest",
      sourceEvidenceId: `ev-${id}`,
      status: "open",
      summary: `Loop ${id}.`,
      sourceQuote: `Loop ${id}.`,
      confidence: 0.9,
      nextCheckAt: null,
    };
    store.loops.set(id, loop);
    return loop;
  }

  it("'done 2' on a digest nudge resolves ordinal 2 from the digest's stored map", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    seedDigestLoop(store, "loop-1");
    seedDigestLoop(store, "loop-2");
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", digestMetadata({ 1: "loop-1", 2: "loop-2" }));
    store.addEmail(
      makeEmail("inbound-cmd", { mailboxHash: `n_${nudgeId}`, textBody: "done 2", strippedTextReply: "done 2" }),
    );

    const result = await routeEmail("inbound-cmd", makeDeps(store, sent));

    expect(result.branch).toBe("command");
    expect(store.loops.get("loop-2")?.status).toBe("done");
    expect(store.loops.get("loop-1")?.status).toBe("open");
  });

  it("'snooze 1 until Monday' on a digest reply sets snoozed + user-local Monday 9 AM next_check_at (America/Los_Angeles)", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    store.timezones.set("user-1", "America/Los_Angeles");
    seedDigestLoop(store, "loop-1");
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", digestMetadata({ 1: "loop-1" }));
    store.addEmail(
      makeEmail("inbound-snooze", {
        mailboxHash: `n_${nudgeId}`,
        textBody: "snooze 1 until Monday",
        strippedTextReply: "snooze 1 until Monday",
      }),
    );

    const result = await routeEmail("inbound-snooze", makeDeps(store, sent));

    expect(result.branch).toBe("command");
    const loop = store.loops.get("loop-1");
    expect(loop?.status).toBe("snoozed");
    // NOW = 2026-06-12T16:00Z = Fri 09:00 PDT → next Monday 09:00 PDT = 2026-06-15T16:00:00Z.
    expect(loop?.nextCheckAt?.toISOString()).toBe("2026-06-15T16:00:00.000Z");
  });

  it("a free-text brain-dump reply to a digest nudge falls through to capture and creates loops", async () => {
    const store = new InMemoryRouterStore();
    const sent: string[] = [];
    seedDigestLoop(store, "loop-1");
    const nudgeId = randomUUID();
    store.seedNudge(nudgeId, "user-1", digestMetadata({ 1: "loop-1" }));
    // A plain brain dump that classifies as capture-intent (no command/question prefix).
    store.addEmail(
      makeEmail("inbound-braindump", {
        mailboxHash: `n_${nudgeId}`,
        textBody: "I'll send the renewal packet to Acme by Tuesday.",
        strippedTextReply: "I'll send the renewal packet to Acme by Tuesday.",
      }),
    );

    const result = await routeEmail("inbound-braindump", makeDeps(store, sent));

    expect(result.branch).toBe("capture");
    expect(result.status).toBe("processed");
    expect(result.loops.length).toBeGreaterThan(0);
    // The newly captured loops are tied to the brain-dump inbound, not the digest nudge.
    expect(result.loops.every((l) => l.inboundEmailId === "inbound-braindump")).toBe(true);
  });
});
