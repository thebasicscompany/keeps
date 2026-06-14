import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LoopCandidate,
  LoopExtractionResult,
  LoopStatus,
} from "@/agent/schemas";
import type { ExtractionContext } from "@/agent/extraction-context";
import type { NormalizedEmail } from "@/email/normalize";

// Mock extraction so we can hand crafted loops (carrying reconciliation fields)
// to the partition+apply logic without driving a real model or the deterministic
// extractor. The decider itself (src/agent/reconcile.ts) is REAL and unmocked —
// these tests verify how processInboundEmailForLoops APPLIES its decisions.
vi.mock("@/agent/extract-loops", () => ({
  extractLoops: vi.fn(),
}));

import { extractLoops } from "@/agent/extract-loops";
import {
  processInboundEmailForLoops,
  type LoopProcessingRepository,
  type LoopToPersist,
  type OpenLoopContext,
  type PersistedLoop,
  type PersistedNudge,
  type PrivateReplyNudgeMetadata,
  type ProcessableInboundEmail,
} from "@/loops/service";

const extractLoopsMock = vi.mocked(extractLoops);

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildEmail(overrides: Partial<ProcessableInboundEmail> = {}): ProcessableInboundEmail {
  const normalized: NormalizedEmail = {
    provider: "fixture",
    providerMessageId: "msg-1",
    mailboxHash: null,
    from: { email: "maya@acme.com", name: "Maya" },
    to: [{ email: "agent@keeps.ai", name: "Keeps" }],
    cc: [],
    subject: "Renewal packet",
    textBody: "Following up on the renewal packet.",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-12T09:00:00.000Z",
  };

  return {
    id: "inbound-1",
    userId: "user-1",
    emailThreadId: "thread-1",
    emailMessageId: "msg-1",
    normalized,
    ...overrides,
  };
}

function buildLoop(overrides: Partial<LoopCandidate> = {}): LoopCandidate {
  return {
    summary: "Send the renewal packet.",
    kind: "commitment",
    status: "open",
    basis: "explicit_commitment",
    ownerText: "Maya",
    requesterText: "Keeps",
    dueDateText: null,
    dueAt: null,
    nextCheckAt: null,
    dueDateUncertainty: "missing",
    confidence: 0.9,
    explicitness: "explicit",
    participants: [],
    source: { quote: "Send the renewal packet.", startOffset: 0, endOffset: 24 },
    ambiguityFlags: [],
    reconcilesLoopRef: null,
    reconcileAction: "create",
    reconcileConfidence: 0,
    reconcileEvidence: null,
    ...overrides,
  };
}

function buildExtraction(loops: LoopCandidate[], overrides: Partial<LoopExtractionResult> = {}): LoopExtractionResult {
  return {
    intent: "capture",
    emailSummary: "summary",
    loops,
    clarifyingQuestion: null,
    suggestedPrivateReply: "ok",
    ...overrides,
  };
}

// A CompactLoop candidate the decider can reconcile against.
function buildCandidate(overrides: Partial<ExtractionContext["openLoops"][number]> = {}): ExtractionContext["openLoops"][number] {
  return {
    id: "candidate-loop-1",
    refId: "L1",
    summary: "Send the renewal packet to Acme.",
    status: "open",
    ownerText: "Maya",
    requesterText: "Keeps",
    emailThreadId: "thread-1",
    entityIds: ["entity-maya"],
    dueAt: null,
    updatedAt: "2026-06-10T09:00:00.000Z",
    generators: ["thread"],
    score: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Context-aware fake repository
// ---------------------------------------------------------------------------

type RecordedReconcileEvent = {
  userId: string;
  loopId: string;
  eventType: "reconciled" | "reconcile_suggested";
  metadata: Record<string, unknown>;
};

type MutateCall = {
  loopId: string;
  status: LoopStatus;
  eventType: string;
  source?: string;
};

class FakeRepo implements LoopProcessingRepository {
  private readonly emails = new Map<string, ProcessableInboundEmail>();
  private readonly loops = new Map<string, PersistedLoop>();
  readonly persisted: LoopToPersist[] = [];
  readonly reconcileEvents: RecordedReconcileEvent[] = [];
  readonly mutateCalls: MutateCall[] = [];
  readonly nudgeMetadata = new Map<string, PrivateReplyNudgeMetadata>();
  private context: OpenLoopContext = { openLoops: [], knownEntities: [], participantEntityIds: [] };
  private nextId = 1;
  // Set false to simulate a pre-B2b fake without loadOpenLoopContext.
  contextEnabled = true;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  // Pre-seed an existing loop the decider can reconcile against.
  addExistingLoop(loop: PersistedLoop) {
    this.loops.set(loop.id, loop);
  }

  setContext(context: OpenLoopContext) {
    this.context = context;
  }

  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }

  async findLoopsByInboundEmailId(): Promise<PersistedLoop[]> {
    return [];
  }

  async persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    return input.loops.map((candidate) => {
      this.persisted.push(candidate);
      const loop: PersistedLoop = {
        id: `loop-${this.nextId++}`,
        userId: input.email.userId,
        emailThreadId: input.email.emailThreadId,
        inboundEmailId: input.email.id,
        sourceEvidenceId: `evidence-${this.nextId++}`,
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
    const id = `nudge-${this.nextId++}`;
    this.nudgeMetadata.set(id, input.metadata);
    return { id, userId: input.userId, inboundEmailId: input.inboundEmailId, body: input.body };
  }

  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    const id = `nudge-${this.nextId++}`;
    return { id, userId: input.userId, inboundEmailId: input.inboundEmailId, body: input.body };
  }

  async listCommandableLoops(): Promise<PersistedLoop[]> {
    return [...this.loops.values()];
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
    if (!existing) {
      throw new Error(`Missing loop ${input.loopId}`);
    }
    this.mutateCalls.push({
      loopId: input.loopId,
      status: input.status,
      eventType: input.eventType,
      source: input.source,
    });
    const updated: PersistedLoop = { ...existing, status: input.status, nextCheckAt: input.nextCheckAt ?? existing.nextCheckAt };
    this.loops.set(updated.id, updated);
    return updated;
  }

  async recordLoopCorrection(): Promise<void> {}

  async loadOpenLoopContext(): Promise<OpenLoopContext> {
    if (!this.contextEnabled) {
      throw new Error("loadOpenLoopContext should not be called when context disabled");
    }
    return this.context;
  }

  async recordReconciliationEvent(input: RecordedReconcileEvent): Promise<void> {
    this.reconcileEvents.push(input);
  }
}

// A pre-B2b fake WITHOUT the new methods — proves backward-compat (no context,
// no provenance writes, all-creates).
class LegacyFakeRepo implements LoopProcessingRepository {
  private readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly persisted: LoopToPersist[] = [];
  readonly nudgeMetadata = new Map<string, PrivateReplyNudgeMetadata>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }

  async findLoopsByInboundEmailId(): Promise<PersistedLoop[]> {
    return [];
  }

  async persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    return input.loops.map((candidate) => {
      this.persisted.push(candidate);
      return {
        id: `loop-${this.nextId++}`,
        userId: input.email.userId,
        emailThreadId: input.email.emailThreadId,
        inboundEmailId: input.email.id,
        sourceEvidenceId: `evidence-${this.nextId++}`,
        status: candidate.status,
        summary: candidate.summary,
        sourceQuote: candidate.source.quote,
        confidence: candidate.confidence,
        nextCheckAt: null,
      } satisfies PersistedLoop;
    });
  }

  async createPrivateReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge> {
    const id = `nudge-${this.nextId++}`;
    this.nudgeMetadata.set(id, input.metadata);
    return { id, userId: input.userId, inboundEmailId: input.inboundEmailId, body: input.body };
  }

  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    return { id: `nudge-${this.nextId++}`, userId: input.userId, inboundEmailId: input.inboundEmailId, body: input.body };
  }

  async listCommandableLoops(): Promise<PersistedLoop[]> {
    return [];
  }

  async updateLoopFromCommand(): Promise<PersistedLoop> {
    throw new Error("not used");
  }

  async recordLoopCorrection(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processInboundEmailForLoops — three-band reconciliation apply", () => {
  beforeEach(() => {
    extractLoopsMock.mockReset();
  });

  it("(a) AUTO update: mutates the existing loop (confirm), records 'reconciled', persists NO new loop", async () => {
    const repo = new FakeRepo();
    repo.addEmail(buildEmail());
    repo.addExistingLoop({
      id: "candidate-loop-1",
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-0",
      sourceEvidenceId: "evidence-0",
      status: "open",
      summary: "Send the renewal packet to Acme.",
      sourceQuote: "",
      confidence: 0.9,
      nextCheckAt: null,
    });
    repo.setContext({ openLoops: [buildCandidate()], knownEntities: [], participantEntityIds: ["entity-maya"] });

    extractLoopsMock.mockResolvedValue(
      buildExtraction([
        buildLoop({
          summary: "Send the renewal packet to Acme this week.",
          reconcilesLoopRef: "L1",
          reconcileAction: "update",
          reconcileConfidence: 0.9,
          reconcileEvidence: "same thread + same renewal packet deliverable",
        }),
      ]),
    );

    const result = await processInboundEmailForLoops({ inboundEmailId: "inbound-1", repository: repo, useModel: true });
    if (result.status !== "processed") throw new Error("expected processed");

    // No new loop persisted for the reconciled candidate.
    expect(repo.persisted).toHaveLength(0);
    expect(result.loops).toHaveLength(0);
    // mutateLoopState called with confirm (→ open) on the candidate, source auto_reconcile.
    expect(repo.mutateCalls).toEqual([
      { loopId: "candidate-loop-1", status: "open", eventType: "confirmed", source: "auto_reconcile" },
    ]);
    // 'reconciled' provenance recorded.
    expect(repo.reconcileEvents).toHaveLength(1);
    expect(repo.reconcileEvents[0]).toMatchObject({
      loopId: "candidate-loop-1",
      eventType: "reconciled",
      metadata: { action: "update", absorbedSummary: "Send the renewal packet to Acme this week." },
    });
    expect(result.reconciliations).toHaveLength(1);
    expect(result.reconciliations[0]?.action).toBe("update");
  });

  it("(b) AUTO close: mutates with mark_done (→ done)", async () => {
    const repo = new FakeRepo();
    repo.addEmail(buildEmail());
    repo.addExistingLoop({
      id: "candidate-loop-1",
      userId: "user-1",
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-0",
      sourceEvidenceId: "evidence-0",
      status: "open",
      summary: "Send the renewal packet to Acme.",
      sourceQuote: "",
      confidence: 0.9,
      nextCheckAt: null,
    });
    repo.setContext({ openLoops: [buildCandidate()], knownEntities: [], participantEntityIds: ["entity-maya"] });

    extractLoopsMock.mockResolvedValue(
      buildExtraction([
        buildLoop({
          summary: "Sent the renewal packet to Acme — done.",
          reconcilesLoopRef: "L1",
          reconcileAction: "close",
          reconcileConfidence: 0.95,
          reconcileEvidence: "same thread + renewal packet now delivered",
        }),
      ]),
    );

    const result = await processInboundEmailForLoops({ inboundEmailId: "inbound-1", repository: repo, useModel: true });
    if (result.status !== "processed") throw new Error("expected processed");

    expect(repo.persisted).toHaveLength(0);
    expect(repo.mutateCalls).toEqual([
      { loopId: "candidate-loop-1", status: "done", eventType: "marked_done", source: "auto_reconcile" },
    ]);
    expect(repo.reconcileEvents[0]).toMatchObject({ eventType: "reconciled", metadata: { action: "close" } });
    expect(result.reconciliations[0]?.action).toBe("close");
  });

  it("(c) ASK: persists a SUPPRESSED loop + 'reconcile_suggested' event, ask text in reply, NOT in ordinalMap", async () => {
    const repo = new FakeRepo();
    repo.addEmail(buildEmail());
    repo.addExistingLoop({
      id: "candidate-loop-1",
      userId: "user-1",
      emailThreadId: "thread-other",
      inboundEmailId: "inbound-0",
      sourceEvidenceId: "evidence-0",
      status: "open",
      summary: "Send the renewal packet to Acme.",
      sourceQuote: "",
      confidence: 0.9,
      nextCheckAt: null,
    });
    // sameEntity (entity overlap) but cross-thread + a 'close' below the close bar
    // ⇒ the decider downgrades to ASK.
    repo.setContext({
      openLoops: [buildCandidate({ emailThreadId: "thread-other" })],
      knownEntities: [],
      participantEntityIds: ["entity-maya"],
    });

    extractLoopsMock.mockResolvedValue(
      buildExtraction([
        buildLoop({
          summary: "Send the renewal packet to Acme.",
          reconcilesLoopRef: "L1",
          reconcileAction: "close",
          reconcileConfidence: 0.95,
          reconcileEvidence: "same counterparty Acme + renewal packet",
        }),
      ]),
    );

    const result = await processInboundEmailForLoops({ inboundEmailId: "inbound-1", repository: repo, useModel: true });
    if (result.status !== "processed") throw new Error("expected processed");

    // The suppressed loop persisted with status 'suppressed'.
    expect(repo.persisted).toHaveLength(1);
    expect(repo.persisted[0]?.status).toBe("suppressed");
    // It is NOT in the normal loops result / ordinalMap.
    expect(result.loops).toHaveLength(0);
    const nudgeMeta = [...repo.nudgeMetadata.values()][0];
    expect(nudgeMeta?.loopCount).toBe(0);
    expect(nudgeMeta?.ordinalMap).toEqual({});
    // No reconcile mutate happened.
    expect(repo.mutateCalls).toHaveLength(0);
    // 'reconcile_suggested' event references the candidate.
    expect(repo.reconcileEvents).toHaveLength(1);
    expect(repo.reconcileEvents[0]).toMatchObject({
      eventType: "reconcile_suggested",
      metadata: { candidateLoopId: "candidate-loop-1" },
    });
    // Ask text in the reply.
    expect(result.privateReply).toContain("Reply YES to merge or NO to keep separate");
    expect(result.suggestedReconciliations).toHaveLength(1);
  });

  it("(d) CREATE: a model 'create' proposal persists normally (unchanged path)", async () => {
    const repo = new FakeRepo();
    repo.addEmail(buildEmail());
    repo.setContext({ openLoops: [buildCandidate()], knownEntities: [], participantEntityIds: ["entity-maya"] });

    extractLoopsMock.mockResolvedValue(
      buildExtraction([buildLoop({ summary: "Brand new commitment.", confidence: 0.9 })]),
    );

    const result = await processInboundEmailForLoops({ inboundEmailId: "inbound-1", repository: repo, useModel: true });
    if (result.status !== "processed") throw new Error("expected processed");

    expect(repo.persisted).toHaveLength(1);
    expect(repo.persisted[0]?.status).toBe("open");
    expect(result.loops).toHaveLength(1);
    expect(repo.mutateCalls).toHaveLength(0);
    expect(repo.reconcileEvents).toHaveLength(0);
    expect(result.reconciliations).toHaveLength(0);
    expect(result.suggestedReconciliations).toHaveLength(0);
  });

  it("(e) backward-compat: empty context ⇒ all create, no provenance writes", async () => {
    const repo = new FakeRepo();
    repo.addEmail(buildEmail());
    // Empty context (default): even an 'update' proposal must fall back to create
    // because there is no candidate to resolve the ref against.
    repo.setContext({ openLoops: [], knownEntities: [], participantEntityIds: [] });

    extractLoopsMock.mockResolvedValue(
      buildExtraction([
        buildLoop({
          summary: "Send the renewal packet.",
          confidence: 0.9,
          reconcilesLoopRef: "L1",
          reconcileAction: "update",
          reconcileConfidence: 0.99,
          reconcileEvidence: "same thread",
        }),
      ]),
    );

    const result = await processInboundEmailForLoops({ inboundEmailId: "inbound-1", repository: repo, useModel: true });
    if (result.status !== "processed") throw new Error("expected processed");

    expect(repo.persisted).toHaveLength(1);
    expect(repo.persisted[0]?.status).toBe("open");
    expect(repo.mutateCalls).toHaveLength(0);
    expect(repo.reconcileEvents).toHaveLength(0);
    expect(result.reconciliations).toHaveLength(0);
    expect(result.suggestedReconciliations).toHaveLength(0);
  });

  it("(e2) legacy fake without loadOpenLoopContext ⇒ extractLoops gets empty context, all create", async () => {
    const repo = new LegacyFakeRepo();
    repo.addEmail(buildEmail());

    extractLoopsMock.mockResolvedValue(
      buildExtraction([buildLoop({ summary: "Send the renewal packet.", confidence: 0.9 })]),
    );

    const result = await processInboundEmailForLoops({ inboundEmailId: "inbound-1", repository: repo, useModel: true });
    if (result.status !== "processed") throw new Error("expected processed");

    // extractLoops was handed an empty context.
    const passedContext = extractLoopsMock.mock.calls[0]?.[0].context;
    expect(passedContext).toEqual({ openLoops: [], knownEntities: [] });
    expect(repo.persisted).toHaveLength(1);
    expect(result.loops).toHaveLength(1);
    expect(result.reconciliations).toHaveLength(0);
    expect(result.suggestedReconciliations).toHaveLength(0);
  });
});
