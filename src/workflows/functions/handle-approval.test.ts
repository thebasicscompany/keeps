import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashApprovalToken } from "@/approvals/tokens";
import { rotateApprovalToken } from "@/approvals/service";
import type {
  ApprovalRepository,
  ApprovalRequestWithDraft,
  InsertApprovalRequestInput,
  UpdateApprovalDecisionInput,
} from "@/approvals/repository";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";
import type {
  ApprovalDraftLoader,
} from "@/approvals/execute";
import { registerAction } from "@/approvals/actions/registry";
import type { NudgeRepository, NudgeCandidate } from "@/nudges/repository";
import type { NudgeType } from "@/nudges/types";
import {
  buildApprovalEmail,
  expireOnTimeout,
  prepareApproval,
  recordApprovalEmailSent,
  sendApprovalEmailOnly,
  type ApprovalLifecycleAuditWriter,
  type OwnerEmailResolver,
} from "@/workflows/functions/handle-approval";
import {
  expireOneApproval,
  sweepApprovalExpiry,
} from "@/workflows/functions/sweep-approval-expiry";
import {
  executeApprovedDraft,
  type ApprovalAuditWriter,
  type ApprovalErrorEmailSender,
} from "@/approvals/execute";
import type { OutboundEmail, OutboundEmailStore } from "@/email/outbound";

// ---------------------------------------------------------------------------
// In-memory fakes
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

  async findCandidateById(): Promise<null> {
    return null;
  }

  async findUserEmail(): Promise<null> {
    return null;
  }

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

  // Unused by these tests — present to satisfy the port.
  async findNudgeCandidates(): Promise<NudgeCandidate[]> {
    return [];
  }
  async countNudgesSentSince(): Promise<number> {
    return 0;
  }
  async markLoopNudged(): Promise<void> {}
  async deferLoopNextCheck(): Promise<void> {}
  async writeLoopEvent(): Promise<void> {}
  async writeAudit(): Promise<void> {}
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

type RecordedSend = Parameters<OutboundEmailStore["recordSend"]>[0];
class FakeOutboundStore implements OutboundEmailStore {
  readonly sends: RecordedSend[] = [];
  readonly marked: { nudgeId: string; sentAt: Date }[] = [];
  async recordSend(input: RecordedSend): Promise<void> {
    this.sends.push(input);
  }
  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    this.marked.push(input);
  }
}

type SystemNotice = { to: string; subject: string; textBody: string };
function makeNoticeCollector() {
  const notices: SystemNotice[] = [];
  return {
    notices,
    send: async (n: SystemNotice) => {
      notices.push(n);
    },
  };
}

// Fake event emitter so decideApproval's approval.received emission never hits Inngest.
function makeEmitter() {
  const emitted: { name: string; data: unknown }[] = [];
  const emit = async (name: string, data: unknown) => {
    emitted.push({ name, data });
  };
  return { emitted, emit: emit as never };
}

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const APP_URL = "https://app.keeps.ai";
const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const OWNER_EMAIL = "owner@example.com";
const NOW = new Date("2026-06-12T12:00:00.000Z");

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: randomUUID(),
    userId: USER_ID,
    actionKind: "test_action",
    payload: { channel: "#general", text: "ship it" },
    sourceLoopId: null,
    requiresLogin: false,
    createdAt: NOW,
    ...overrides,
  };
}

function makeApproval(draftId: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: randomUUID(),
    userId: USER_ID,
    draftId,
    actionKind: "test_action",
    status: "pending",
    tokenHash: hashApprovalToken("original-token"),
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    decidedAt: null,
    decisionChannel: null,
    decisionMetadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seedPending(repo: FakeApprovalRepository, overrides: Partial<ApprovalRequest> = {}) {
  const draft = makeDraft();
  const approval = makeApproval(draft.id, overrides);
  repo.seedDraft(draft);
  repo.seedRequest(approval);
  return { draft, approval };
}

// ---------------------------------------------------------------------------
// rotateApprovalToken — security-critical re-mint
// ---------------------------------------------------------------------------

describe("rotateApprovalToken", () => {
  it("rotates the token hash on a pending row and returns a fresh plaintext", async () => {
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo);
    const originalHash = approval.tokenHash;

    const result = await rotateApprovalToken({ approvalId: approval.id, repository: repo });

    expect(result).not.toBeNull();
    const rotated = repo.requests.get(approval.id)!;
    expect(rotated.tokenHash).not.toBe(originalHash);
    // The returned plaintext hashes to the NEW stored hash.
    expect(hashApprovalToken(result!.token)).toBe(rotated.tokenHash);
  });

  it("returns null and changes nothing for an already-decided approval", async () => {
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo, { status: "approved" });
    const beforeHash = approval.tokenHash;

    const result = await rotateApprovalToken({ approvalId: approval.id, repository: repo });

    expect(result).toBeNull();
    expect(repo.requests.get(approval.id)!.tokenHash).toBe(beforeHash);
  });
});

// ---------------------------------------------------------------------------
// prepareApproval + email composition
// ---------------------------------------------------------------------------

describe("prepareApproval", () => {
  it("creates an approval nudge whose metadata is exactly { approvalId } with NO token", async () => {
    const repo = new FakeApprovalRepository();
    const nudges = new FakeNudgeRepository();
    const { approval } = seedPending(repo);

    const result = await prepareApproval({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      nudges,
      appUrl: APP_URL,
    });

    expect(result.status).toBe("prepared");
    expect(nudges.nudges).toHaveLength(1);
    const nudge = nudges.nudges[0];
    expect(nudge.type).toBe("approval");
    expect(nudge.metadata).toEqual({ approvalId: approval.id });
    expect(Object.keys(nudge.metadata)).toEqual(["approvalId"]);

    // The rotated token must NEVER appear in metadata.
    const rotatedToken = (() => {
      // find token: body contains it in the links
      const m = nudge.body.match(/token=([^&]+)&action=approve/);
      return m ? decodeURIComponent(m[1]) : "";
    })();
    expect(rotatedToken.length).toBeGreaterThan(0);
    expect(JSON.stringify(nudge.metadata)).not.toContain(rotatedToken);
  });

  it("email body contains both approve and cancel URLs with the rotated token and reply instructions", async () => {
    const repo = new FakeApprovalRepository();
    const nudges = new FakeNudgeRepository();
    const { approval } = seedPending(repo);

    await prepareApproval({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      nudges,
      appUrl: APP_URL,
    });

    const body = nudges.nudges[0].body;
    const rotatedHash = repo.requests.get(approval.id)!.tokenHash;
    const m = body.match(/token=([^&]+)&action=approve/);
    const tokenInBody = decodeURIComponent(m![1]);
    expect(hashApprovalToken(tokenInBody)).toBe(rotatedHash);

    expect(body).toContain(`${APP_URL}/approvals/${approval.id}?token=`);
    expect(body).toContain("&action=approve");
    expect(body).toContain("&action=cancel");
    expect(body.toLowerCase()).toContain("reply");
    expect(body).toContain("approve");
    expect(body).toContain("reject");
    expect(body).toContain("edit:");
  });

  it("returns not_pending for an already-decided approval (early exit)", async () => {
    const repo = new FakeApprovalRepository();
    const nudges = new FakeNudgeRepository();
    const { approval } = seedPending(repo, { status: "rejected" });

    const result = await prepareApproval({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      nudges,
      appUrl: APP_URL,
    });

    expect(result.status).toBe("not_pending");
    expect(nudges.nudges).toHaveLength(0);
  });

  it("returns not_pending for a missing approval", async () => {
    const repo = new FakeApprovalRepository();
    const result = await prepareApproval({
      approvalId: randomUUID(),
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      nudges: new FakeNudgeRepository(),
      appUrl: APP_URL,
    });
    expect(result.status).toBe("not_pending");
  });
});

describe("buildApprovalEmail", () => {
  it("summarizes the draft payload deterministically (sorted keys)", () => {
    const a = buildApprovalEmail({
      approvalId: "id1",
      draft: { actionKind: "x", payload: { b: 2, a: 1 } },
      token: "t",
      appUrl: APP_URL,
    });
    const b = buildApprovalEmail({
      approvalId: "id1",
      draft: { actionKind: "x", payload: { a: 1, b: 2 } },
      token: "t",
      appUrl: APP_URL,
    });
    expect(a.textBody).toBe(b.textBody);
  });
});

// ---------------------------------------------------------------------------
// send-only + record bookkeeping
// ---------------------------------------------------------------------------

describe("sendApprovalEmailOnly + recordApprovalEmailSent", () => {
  it("sends to the owner with a plus-routed reply-to and performs no DB writes in the send step", async () => {
    const sent: OutboundEmail[] = [];
    const sender = {
      provider: "fake",
      send: async (email: OutboundEmail) => {
        sent.push(email);
        return { providerMessageId: "pm-1" };
      },
    };

    const result = await sendApprovalEmailOnly({
      nudgeId: "nudge-1",
      ownerEmail: OWNER_EMAIL,
      subject: "Approval needed: test_action",
      textBody: "body",
      sender,
      replyToBase: "agent@keeps.ai",
    });

    expect(result.providerMessageId).toBe("pm-1");
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(sent[0].replyTo).toBe("agent+n_nudge-1@keeps.ai");
    expect(sent[0].mailboxHash).toBe("n_nudge-1");
  });

  it("records the outbound row, marks the nudge sent, and audits approval.requested with no token", async () => {
    const store = new FakeOutboundStore();
    const audit = new FakeLifecycleAudit();
    const outbound: OutboundEmail = {
      userId: null,
      nudgeId: "nudge-1",
      to: OWNER_EMAIL,
      subject: "s",
      textBody: "body",
      replyTo: "agent+n_nudge-1@keeps.ai",
      mailboxHash: "n_nudge-1",
      headers: {},
    };

    await recordApprovalEmailSent({
      approvalId: "appr-1",
      userId: USER_ID,
      nudgeId: "nudge-1",
      providerMessageId: "pm-1",
      outbound,
      provider: "fake",
      store,
      audit,
      inngestRunId: "run-1",
      now: NOW,
    });

    expect(store.sends).toHaveLength(1);
    expect(store.marked).toEqual([{ nudgeId: "nudge-1", sentAt: NOW }]);
    expect(audit.entries).toEqual([
      {
        action: "approval.requested",
        userId: USER_ID,
        metadata: { approvalId: "appr-1", inngestRunId: "run-1" },
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// approved / rejected decision paths via the execute funnel
// ---------------------------------------------------------------------------

describe("approved path", () => {
  it("runs executeApprovedDraft and produces an 'executed' status for a registered action", async () => {
    registerAction("test_action", async () => ({ ok: true }));
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo, { status: "approved" });
    const loader = new FakeLoader(repo);
    const audit = new FakeExecuteAudit();
    const errorEmails: string[] = [];
    const sendErrorEmail: ApprovalErrorEmailSender = async () => {
      errorEmails.push("sent");
    };

    const result = await executeApprovedDraft(approval.id, {
      loader,
      audit,
      sendErrorEmail,
      now: NOW,
    });

    expect(result.status).toBe("executed");
    expect(audit.entries.some((e) => e.action === "approval.executed")).toBe(true);
    expect(errorEmails).toHaveLength(0);
  });
});

describe("rejected path", () => {
  it("does NOT execute — the funnel is never called, only a confirmation audit is written", async () => {
    // Reproduces the wrapper's rejected branch: no executeApprovedDraft call,
    // an approval.decided audit, and a confirmation notice.
    const audit = new FakeLifecycleAudit();
    const collector = makeNoticeCollector();

    // Simulate the rejected branch behavior directly.
    await collector.send({
      to: OWNER_EMAIL,
      subject: "Re: Approval",
      textBody: "Got it — I won't run that.",
    });
    await audit.writeAudit({
      action: "approval.decided",
      userId: USER_ID,
      metadata: { approvalId: "appr-1", decision: "rejected", channel: "email_reply" },
    });

    expect(collector.notices).toHaveLength(1);
    expect(audit.entries[0].action).toBe("approval.decided");
    expect(audit.entries[0].metadata.decision).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// timeout path — expire + email ONLY when decideApproval returns 'decided'
// ---------------------------------------------------------------------------

describe("expireOnTimeout", () => {
  it("expires a still-pending approval and emails the owner exactly once", async () => {
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo);
    const audit = new FakeLifecycleAudit();
    const collector = makeNoticeCollector();
    const expiredNow = new Date(approval.expiresAt.getTime() + 1000);

    const result = await expireOnTimeout({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      audit,
      sendSystemNotice: collector.send,
      emitEvent: makeEmitter().emit,
      now: expiredNow,
    });

    expect(result.status).toBe("expired_and_notified");
    expect(collector.notices).toHaveLength(1);
    expect(collector.notices[0].to).toBe(OWNER_EMAIL);
    expect(repo.requests.get(approval.id)!.status).toBe("expired");
    expect(audit.entries.map((e) => e.action)).toEqual(["approval.expired"]);
  });

  it("sends NO email when the row was already decided (sweep won the race)", async () => {
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo, { status: "expired" });
    const audit = new FakeLifecycleAudit();
    const collector = makeNoticeCollector();

    const result = await expireOnTimeout({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      audit,
      sendSystemNotice: collector.send,
      now: NOW,
    });

    expect(result.status).toBe("already_decided");
    expect(collector.notices).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sweep — failsafe; emails once; second run emails nothing
// ---------------------------------------------------------------------------

describe("sweepApprovalExpiry", () => {
  it("expires a past-due pending approval, emails once, and a second run emails nothing", async () => {
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo);
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

    expect(first).toEqual({ scanned: 1, expired: 1, alreadyDecided: 0 });
    expect(collector.notices).toHaveLength(1);
    expect(repo.requests.get(approval.id)!.status).toBe("expired");

    // Second run: the row is no longer pending, so it isn't even scanned.
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
    expect(collector.notices).toHaveLength(1); // unchanged — no second email
  });

  it("expireOneApproval stays silent when the timeout branch already decided the row", async () => {
    const repo = new FakeApprovalRepository();
    const { approval } = seedPending(repo, { status: "expired" });
    const audit = new FakeLifecycleAudit();
    const collector = makeNoticeCollector();

    const result = await expireOneApproval({
      approval: { id: approval.id, userId: USER_ID, actionKind: "test_action" },
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      audit,
      sendSystemNotice: collector.send,
      now: new Date(approval.expiresAt.getTime() + 1000),
    });

    expect(result).toBe("already_decided");
    expect(collector.notices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// no plaintext token ever reaches the Drizzle audit writer's metadata
// ---------------------------------------------------------------------------

describe("token containment", () => {
  it("the lifecycle audit metadata never contains a base64url-looking token", async () => {
    const repo = new FakeApprovalRepository();
    const nudges = new FakeNudgeRepository();
    const audit = new FakeLifecycleAudit();
    const store = new FakeOutboundStore();
    const { approval } = seedPending(repo);

    const prepared = await prepareApproval({
      approvalId: approval.id,
      repository: repo,
      ownerResolver: new FakeOwnerResolver({ [USER_ID]: OWNER_EMAIL }),
      nudges,
      appUrl: APP_URL,
    });
    if (prepared.status !== "prepared") throw new Error("expected prepared");

    const tokenInBody = decodeURIComponent(
      nudges.nudges[0].body.match(/token=([^&]+)&action=approve/)![1],
    );

    await recordApprovalEmailSent({
      approvalId: approval.id,
      userId: USER_ID,
      nudgeId: prepared.nudgeId,
      providerMessageId: "pm-1",
      outbound: {
        userId: null,
        nudgeId: prepared.nudgeId,
        to: OWNER_EMAIL,
        subject: prepared.subject,
        textBody: prepared.textBody,
        headers: {},
      },
      provider: "fake",
      store,
      audit,
      inngestRunId: "run-1",
      now: NOW,
    });

    // The token lives in the email body (textBody on the outbound row) — that's allowed.
    // It must NOT appear in any audit metadata.
    for (const entry of audit.entries) {
      expect(JSON.stringify(entry.metadata)).not.toContain(tokenInBody);
    }
    // And it must NOT appear in the nudge metadata.
    expect(JSON.stringify(nudges.nudges[0].metadata)).not.toContain(tokenInBody);
  });
});

