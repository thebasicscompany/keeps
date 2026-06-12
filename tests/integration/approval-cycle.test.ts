/**
 * E2 — End-to-end approval cycle integration test.
 *
 * Tests the full approval lifecycle using real service/execute code over in-memory
 * fakes, following the patterns in src/workflows/functions/handle-approval.test.ts.
 *
 * Covers:
 *  - createApprovalRequest → event emitted, token returned, hash stored
 *  - prepareApproval → email body contains approve+cancel URLs, metadata exactly { approvalId }
 *  - decideApproval('approved') → executeApprovedDraft → audit 'approval.executed', handler runs once
 *  - Second decide ('rejected') → already_decided, no second event
 *  - Expiry: pending approval with past expires_at → sweepApprovalExpiry → expired, notice sent;
 *    second sweep → nothing; expireOnTimeout on already-expired → already_decided
 *  - Negative: executeApprovedDraft on still-pending (never approved) → denied
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashApprovalToken } from "@/approvals/tokens";
import { createApprovalRequest, decideApproval, rotateApprovalToken } from "@/approvals/service";
import { registerAction } from "@/approvals/actions/registry";
import type {
  ApprovalRepository,
  ApprovalRequestWithDraft,
  InsertApprovalRequestInput,
  UpdateApprovalDecisionInput,
} from "@/approvals/repository";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";
import type { ApprovalDraftLoader } from "@/approvals/execute";
import { executeApprovedDraft, type ApprovalAuditWriter, type ApprovalErrorEmailSender } from "@/approvals/execute";
import {
  prepareApproval,
  expireOnTimeout,
  type ApprovalLifecycleAuditWriter,
  type OwnerEmailResolver,
} from "@/workflows/functions/handle-approval";
import {
  sweepApprovalExpiry,
  expireOneApproval,
} from "@/workflows/functions/sweep-approval-expiry";
import type { NudgeRepository } from "@/nudges/repository";
import type { NudgeType } from "@/nudges/types";
import type { NudgeCandidate } from "@/nudges/repository";

// ---------------------------------------------------------------------------
// In-memory fakes (adapted from handle-approval.test.ts)
// ---------------------------------------------------------------------------

class FakeApprovalRepository implements ApprovalRepository {
  readonly drafts = new Map<string, Draft>();
  readonly requests = new Map<string, ApprovalRequest>();

  seedDraft(draft: Draft) {
    this.drafts.set(draft.id, draft);
  }
  seedRequest(request: ApprovalRequest) {
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

  async insertApprovalRequest(input: InsertApprovalRequestInput): Promise<ApprovalRequest> {
    const now = new Date();
    const request: ApprovalRequest = {
      id: input.id,
      userId: input.userId,
      draftId: input.draftId,
      actionKind: input.actionKind,
      status: "pending",
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      decidedAt: null,
      decisionChannel: null,
      decisionMetadata: {},
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(request.id, request);
    return request;
  }

  async findApprovalById(id: string): Promise<ApprovalRequestWithDraft | null> {
    const request = this.requests.get(id);
    if (!request) return null;
    const draft = this.drafts.get(request.draftId);
    if (!draft) return null;
    return { ...request, draft };
  }

  async findApprovalByTokenHash(tokenHash: string): Promise<ApprovalRequestWithDraft | null> {
    for (const request of this.requests.values()) {
      if (request.tokenHash === tokenHash) {
        const draft = this.drafts.get(request.draftId);
        if (!draft) return null;
        return { ...request, draft };
      }
    }
    return null;
  }

  async updateApprovalDecision(input: UpdateApprovalDecisionInput): Promise<ApprovalRequest | null> {
    const existing = this.requests.get(input.id);
    if (!existing || existing.status !== "pending") return null;
    const updated: ApprovalRequest = {
      ...existing,
      status: input.status,
      decidedAt: input.decidedAt,
      decisionChannel: input.decisionChannel,
      decisionMetadata: input.decisionMetadata ?? {},
      updatedAt: input.updatedAt,
    };
    this.requests.set(input.id, updated);
    return updated;
  }

  async findPendingExpired(now: Date): Promise<ApprovalRequest[]> {
    const out: ApprovalRequest[] = [];
    for (const r of this.requests.values()) {
      if (r.status === "pending" && r.expiresAt <= now) out.push(r);
    }
    return out;
  }

  async updateApprovalTokenHash(input: {
    id: string;
    tokenHash: string;
  }): Promise<ApprovalRequest | null> {
    const existing = this.requests.get(input.id);
    if (!existing || existing.status !== "pending") return null;
    const updated: ApprovalRequest = {
      ...existing,
      tokenHash: input.tokenHash,
      updatedAt: new Date(),
    };
    this.requests.set(input.id, updated);
    return updated;
  }
}

class FakeOwnerResolver implements OwnerEmailResolver {
  constructor(private readonly emails: Record<string, string>) {}
  async findOwnerEmail(userId: string): Promise<string | null> {
    return this.emails[userId] ?? null;
  }
}

type StoredNudge = {
  id: string;
  userId: string;
  loopId: string | null;
  subject: string;
  body: string;
  type: NudgeType;
  metadata: Record<string, unknown>;
  status: "pending" | "sent";
};

class FakeNudgeRepository implements NudgeRepository {
  readonly nudges: StoredNudge[] = [];

  async findCandidateById(): Promise<null> { return null; }
  async findUserEmail(): Promise<null> { return null; }
  async findNudgeCandidates(): Promise<NudgeCandidate[]> { return []; }
  async countNudgesSentSince(): Promise<number> { return 0; }
  async markLoopNudged(): Promise<void> {}
  async deferLoopNextCheck(): Promise<void> {}
  async writeLoopEvent(): Promise<void> {}
  async writeAudit(): Promise<void> {}

  async createNudgeRow(input: {
    userId: string;
    loopId: string | null;
    inboundEmailId: string | null;
    subject: string;
    body: string;
    type: NudgeType;
    metadata: Record<string, unknown>;
    scheduledFor?: Date | null;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    this.nudges.push({
      id,
      userId: input.userId,
      loopId: input.loopId,
      subject: input.subject,
      body: input.body,
      type: input.type,
      metadata: input.metadata,
      status: "pending",
    });
    return { id };
  }
}

type LifecycleAudit = {
  action: "approval.requested" | "approval.decided" | "approval.expired";
  userId: string | null;
  metadata: Record<string, unknown>;
};

class FakeLifecycleAudit implements ApprovalLifecycleAuditWriter {
  readonly entries: LifecycleAudit[] = [];
  async writeAudit(input: LifecycleAudit): Promise<void> {
    this.entries.push(input);
  }
}

type ExecuteAudit = {
  action: "approval.executed" | "approval.execution_failed";
  userId: string | null;
  metadata: Record<string, unknown>;
};

class FakeExecuteAudit implements ApprovalAuditWriter {
  readonly entries: ExecuteAudit[] = [];
  async writeAudit(input: ExecuteAudit): Promise<void> {
    this.entries.push(input);
  }
}

class FakeLoader implements ApprovalDraftLoader {
  constructor(private readonly repo: FakeApprovalRepository) {}
  async findApprovalWithDraft(approvalId: string) {
    const found = await this.repo.findApprovalById(approvalId);
    if (!found) return null;
    const { draft, ...approval } = found;
    return { approval: approval as ApprovalRequest, draft };
  }
}

type SystemNotice = { to: string; subject: string; textBody: string };
function makeNoticeCollector() {
  const notices: SystemNotice[] = [];
  return {
    notices,
    send: async (n: SystemNotice) => { notices.push(n); },
  };
}

function makeEmitter() {
  const emitted: { name: string; data: unknown }[] = [];
  const emit = async (name: string, data: unknown) => { emitted.push({ name, data }); };
  return { emitted, emit: emit as never };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_URL = "https://app.keeps.ai";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_EMAIL = "owner@example.com";
const NOW = new Date("2026-06-12T12:00:00.000Z");

// ---------------------------------------------------------------------------
// E2 — approval lifecycle
// ---------------------------------------------------------------------------

describe("approval cycle — createApprovalRequest → prepareApproval → decide → execute", () => {
  it("createApprovalRequest emits approval.requested, returns a token, and stores a hash", async () => {
    const repo = new FakeApprovalRepository();
    const emitter = makeEmitter();

    const { request, token } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action", payload: { channel: "#general", text: "ship it" } },
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    // Token returned to caller
    expect(token).toBeTruthy();
    expect(token.length).toBeGreaterThan(10);

    // Hash stored on the row
    const storedHash = repo.requests.get(request.id)?.tokenHash;
    expect(storedHash).toBe(hashApprovalToken(token));

    // Event emitted
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]?.name).toBe("approval.requested");
    expect((emitter.emitted[0]?.data as Record<string, unknown>).approvalId).toBe(request.id);

    // Token NOT in event
    expect(JSON.stringify(emitter.emitted[0]?.data)).not.toContain(token);
  });

  it("prepareApproval produces email body with rotated approve+cancel URLs and metadata exactly { approvalId }", async () => {
    const repo = new FakeApprovalRepository();
    const nudges = new FakeNudgeRepository();
    const emitter = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action", payload: { text: "deploy" } },
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    const result = await prepareApproval({
      approvalId: request.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      nudges,
      appUrl: APP_URL,
    });

    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;

    // nudge created
    expect(nudges.nudges).toHaveLength(1);
    const nudge = nudges.nudges[0];
    expect(nudge?.type).toBe("approval");

    // Metadata is exactly { approvalId } — no token
    expect(nudge?.metadata).toEqual({ approvalId: request.id });
    expect(Object.keys(nudge?.metadata ?? {})).toEqual(["approvalId"]);

    // Body contains rotated token in approve+cancel URLs
    const rotatedHash = repo.requests.get(request.id)!.tokenHash;
    const body = nudge?.body ?? "";
    const m = body.match(/token=([^&\s]+)&action=approve/);
    expect(m).not.toBeNull();
    const tokenInBody = decodeURIComponent(m![1]);
    expect(hashApprovalToken(tokenInBody)).toBe(rotatedHash);

    expect(body).toContain(`${APP_URL}/approvals/${request.id}?token=`);
    expect(body).toContain("&action=approve");
    expect(body).toContain("&action=cancel");
    expect(body.toLowerCase()).toContain("reply");
    expect(body).toContain("approve");
    expect(body).toContain("reject");

    // Token must NOT appear in nudge metadata
    expect(JSON.stringify(nudge?.metadata)).not.toContain(tokenInBody);
  });

  it("decideApproval(approved) → executeApprovedDraft → audit 'approval.executed', handler ran exactly once", async () => {
    // Register the test_action handler (idempotent — registry module-level)
    let handlerCallCount = 0;
    registerAction("test_action", async () => {
      handlerCallCount += 1;
      return { ok: true, detail: { ran: true } };
    });

    const repo = new FakeApprovalRepository();
    const emitter = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action", payload: { text: "do it" } },
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    // Decide: approved via web_link
    const decideResult = await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });
    expect(decideResult.status).toBe("decided");

    // Execute
    const executeAudit = new FakeExecuteAudit();
    const errorEmails: string[] = [];
    const sendErrorEmail: ApprovalErrorEmailSender = async () => { errorEmails.push("sent"); };

    const execResult = await executeApprovedDraft(request.id, {
      loader: new FakeLoader(repo),
      audit: executeAudit,
      sendErrorEmail,
      now: NOW,
    });

    expect(execResult.status).toBe("executed");
    expect(executeAudit.entries.some((e) => e.action === "approval.executed")).toBe(true);
    expect(errorEmails).toHaveLength(0);
    expect(handlerCallCount).toBe(1);

    // approval.received was emitted by decideApproval
    const receivedEvent = emitter.emitted.find((e) => e.name === "approval.received");
    expect(receivedEvent).toBeDefined();
    expect((receivedEvent?.data as Record<string, unknown>).decision).toBe("approved");
  });

  it("second decideApproval (rejected) → already_decided, no second approval.received event", async () => {
    const repo = new FakeApprovalRepository();
    const emitter = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action", payload: {} },
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    // First decision: approved
    await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    const emittedCountAfterFirst = emitter.emitted.length;

    // Second decision attempt: rejected — should be already_decided
    const second = await decideApproval({
      approvalId: request.id,
      decision: "rejected",
      channel: "email_reply",
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    expect(second.status).toBe("already_decided");
    // No new events emitted
    expect(emitter.emitted.length).toBe(emittedCountAfterFirst);
    // Row still shows 'approved'
    expect(repo.requests.get(request.id)?.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// E2 — expiry paths
// ---------------------------------------------------------------------------

describe("approval cycle — expiry", () => {
  function makePendingExpiredApproval(repo: FakeApprovalRepository): ApprovalRequest {
    const draft: Draft = {
      id: randomUUID(),
      userId: USER_ID,
      actionKind: "test_action",
      payload: {},
      sourceLoopId: null,
      requiresLogin: false,
      createdAt: NOW,
    };
    const expiresAt = new Date(NOW.getTime() - 5 * 60 * 1000); // 5 min in the past
    const request: ApprovalRequest = {
      id: randomUUID(),
      userId: USER_ID,
      draftId: draft.id,
      actionKind: "test_action",
      status: "pending",
      tokenHash: hashApprovalToken("original-token"),
      expiresAt,
      decidedAt: null,
      decisionChannel: null,
      decisionMetadata: {},
      createdAt: NOW,
      updatedAt: NOW,
    };
    repo.seedDraft(draft);
    repo.seedRequest(request);
    return request;
  }

  it("sweepApprovalExpiry expires a past-due approval, sends exactly one notice, and a second run sends nothing", async () => {
    const repo = new FakeApprovalRepository();
    const approval = makePendingExpiredApproval(repo);
    const audit = new FakeLifecycleAudit();
    const collector = makeNoticeCollector();
    const sweepNow = new Date(approval.expiresAt.getTime() + 60_000);
    const resolver = new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL });

    const first = await sweepApprovalExpiry({
      repository: repo,
      ownerResolver: resolver,
      audit,
      sendSystemNotice: collector.send,
      emitEvent: makeEmitter().emit,
      now: sweepNow,
    });

    expect(first.scanned).toBe(1);
    expect(first.expired).toBe(1);
    expect(first.alreadyDecided).toBe(0);
    expect(collector.notices).toHaveLength(1);
    expect(collector.notices[0]?.to).toBe(OWNER_EMAIL);
    expect(repo.requests.get(approval.id)?.status).toBe("expired");

    // Second run: the row is no longer pending, so it isn't scanned
    const second = await sweepApprovalExpiry({
      repository: repo,
      ownerResolver: resolver,
      audit,
      sendSystemNotice: collector.send,
      emitEvent: makeEmitter().emit,
      now: new Date(sweepNow.getTime() + 60_000),
    });

    expect(second.scanned).toBe(0);
    expect(second.expired).toBe(0);
    expect(collector.notices).toHaveLength(1); // unchanged — no second notice
  });

  it("expireOnTimeout on an already-expired approval → already_decided, no email", async () => {
    const repo = new FakeApprovalRepository();
    const approval = makePendingExpiredApproval(repo);
    const sweepNow = new Date(approval.expiresAt.getTime() + 60_000);

    // Sweep wins first
    await sweepApprovalExpiry({
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      audit: new FakeLifecycleAudit(),
      sendSystemNotice: makeNoticeCollector().send,
      emitEvent: makeEmitter().emit,
      now: sweepNow,
    });

    // Now the timeout branch tries to expire it — should be already_decided
    const collector = makeNoticeCollector();
    const result = await expireOnTimeout({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      audit: new FakeLifecycleAudit(),
      sendSystemNotice: collector.send,
      emitEvent: makeEmitter().emit,
      now: sweepNow,
    });

    expect(result.status).toBe("already_decided");
    expect(collector.notices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E2 — negative: execute on a never-approved (still pending) approval → denied
// ---------------------------------------------------------------------------

describe("approval cycle — negative: execute on pending (never approved) approval", () => {
  it("executeApprovedDraft on a pending approval → denied, audit 'approval.execution_failed', handler NOT run", async () => {
    let handlerRan = false;
    registerAction("test_action", async () => {
      handlerRan = true;
      return { ok: true };
    });

    const repo = new FakeApprovalRepository();
    const emitter = makeEmitter();

    // Create a request but DO NOT decide it
    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action", payload: {} },
      now: NOW,
      repository: repo,
      emitEvent: emitter.emit,
    });

    // The approval is still 'pending' — authorize() should deny execution
    const executeAudit = new FakeExecuteAudit();
    const errorEmails: string[] = [];
    const sendErrorEmail: ApprovalErrorEmailSender = async () => { errorEmails.push("sent"); };

    const result = await executeApprovedDraft(request.id, {
      loader: new FakeLoader(repo),
      audit: executeAudit,
      sendErrorEmail,
      now: NOW,
    });

    expect(result.status).toBe("denied");
    expect(executeAudit.entries.some((e) => e.action === "approval.execution_failed")).toBe(true);
    expect(handlerRan).toBe(false);
  });
});
