import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hashApprovalToken } from "@/approvals/tokens";
import { createApprovalRequest, verifyApprovalToken, decideApproval } from "@/approvals/service";
import type { ApprovalRepository, ApprovalRequestWithDraft } from "@/approvals/repository";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";
import type { EventMap } from "@/workflows/events";

// ---------------------------------------------------------------------------
// In-memory fake repository
// ---------------------------------------------------------------------------

type StoredApprovalRequest = ApprovalRequest;
type StoredDraft = Draft;

class InMemoryApprovalRepository implements ApprovalRepository {
  private drafts = new Map<string, StoredDraft>();
  private requests = new Map<string, StoredApprovalRequest>();

  async insertDraft(input: NewDraft): Promise<Draft> {
    const now = new Date();
    const draft: Draft = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      actionKind: input.actionKind,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      sourceLoopId: input.sourceLoopId ?? null,
      requiresLogin: input.requiresLogin ?? false,
      createdAt: now,
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  async insertApprovalRequest(input: {
    id: string;
    userId: string;
    draftId: string;
    actionKind: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ApprovalRequest> {
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
      decisionMetadata: {} as Record<string, unknown>,
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

  async updateApprovalDecision(input: {
    id: string;
    status: "approved" | "rejected" | "cancelled" | "expired";
    decidedAt: Date;
    decisionChannel: string;
    decisionMetadata?: Record<string, unknown>;
    updatedAt: Date;
  }): Promise<ApprovalRequest | null> {
    const existing = this.requests.get(input.id);
    // WHERE status = 'pending' guard
    if (!existing || existing.status !== "pending") {
      return null;
    }
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

  async findPendingExpired(now: Date): Promise<ApprovalRequest[]> {
    const result: ApprovalRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.status === "pending" && request.expiresAt <= now) {
        result.push(request);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EmittedEvent = { name: keyof EventMap; data: EventMap[keyof EventMap] };

function makeEmitter() {
  const emitted: EmittedEvent[] = [];
  const emitEvent = async <K extends keyof EventMap>(name: K, data: EventMap[K]) => {
    emitted.push({ name, data } as EmittedEvent);
  };
  return { emitted, emitEvent };
}

const BASE_NOW = new Date("2026-06-12T12:00:00.000Z");
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EXPIRES_AT = new Date(BASE_NOW.getTime() + TTL_MS);

const USER_ID = "00000000-0000-0000-0000-000000000001";

function makeRepo() {
  return new InMemoryApprovalRepository();
}

// ---------------------------------------------------------------------------
// createApprovalRequest
// ---------------------------------------------------------------------------

describe("createApprovalRequest", () => {
  it("returns a plaintext token and an ApprovalRequest row", async () => {
    const repo = makeRepo();
    const { emitted, emitEvent } = makeEmitter();

    const { request, token } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(request.userId).toBe(USER_ID);
    expect(request.actionKind).toBe("test_action");
    expect(request.status).toBe("pending");
    expect(emitted).toHaveLength(1);
  });

  it("stores the SHA-256 hash — NOT the plaintext token", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();

    const { request, token } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    // The stored hash must be the SHA-256 of the returned token.
    expect(request.tokenHash).toBe(hashApprovalToken(token));
    // The plaintext token must NOT appear in the token_hash field.
    expect(request.tokenHash).not.toBe(token);
  });

  it("sets expires_at to exactly now + ttlMs", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();
    const ttlMs = 3 * 24 * 60 * 60 * 1000; // 3 days

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs,
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(request.expiresAt.getTime()).toBe(BASE_NOW.getTime() + ttlMs);
  });

  it("uses default TTL of 7 days when ttlMs is omitted", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(request.expiresAt.getTime()).toBe(BASE_NOW.getTime() + TTL_MS);
  });

  it("emits 'approval.requested' with the correct payload", async () => {
    const repo = makeRepo();
    const { emitted, emitEvent } = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action", payload: { target: "slack" } },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event?.name).toBe("approval.requested");

    const data = event?.data as EventMap["approval.requested"];
    expect(data.approvalId).toBe(request.id);
    expect(data.userId).toBe(USER_ID);
    expect(data.draftId).toBe(request.draftId);
    expect(data.actionKind).toBe("test_action");
    expect(data.expiresAt).toBe(request.expiresAt.toISOString());
  });

  it("persists a draft row with the correct fields", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: {
        actionKind: "test_action",
        payload: { key: "value" },
        requiresLogin: true,
      },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    const row = await repo.findApprovalById(request.id);
    expect(row?.draft.actionKind).toBe("test_action");
    expect(row?.draft.payload).toEqual({ key: "value" });
    expect(row?.draft.requiresLogin).toBe(true);
  });

  it("round-trip: returned token verifies against stored hash", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();

    const { token } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    // verifyApprovalToken must find and return the request with this token.
    const found = await verifyApprovalToken(token, {
      now: BASE_NOW,
      repository: repo,
    });

    expect(found).not.toBeNull();
    expect(found?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// verifyApprovalToken
// ---------------------------------------------------------------------------

describe("verifyApprovalToken", () => {
  async function createRequest(
    repo: InMemoryApprovalRepository,
    overrides: { ttlMs?: number; now?: Date } = {},
  ) {
    const { emitEvent } = makeEmitter();
    return createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs: overrides.ttlMs ?? TTL_MS,
      now: overrides.now ?? BASE_NOW,
      repository: repo,
      emitEvent,
    });
  }

  it("returns the ApprovalRequest for a valid token before expiry", async () => {
    const repo = makeRepo();
    const { token } = await createRequest(repo);

    const result = await verifyApprovalToken(token, { now: BASE_NOW, repository: repo });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("pending");
  });

  it("returns null for an unknown token", async () => {
    const repo = makeRepo();
    await createRequest(repo);

    // Different token — hash won't match any stored row.
    const result = await verifyApprovalToken("totally-wrong-token", {
      now: BASE_NOW,
      repository: repo,
    });

    expect(result).toBeNull();
  });

  it("returns null when the request has expired (expires_at <= now)", async () => {
    const repo = makeRepo();
    const { token } = await createRequest(repo, { ttlMs: 1000 }); // expires 1s after BASE_NOW

    const futureNow = new Date(BASE_NOW.getTime() + 2000); // 2 seconds later → expired

    const result = await verifyApprovalToken(token, { now: futureNow, repository: repo });

    expect(result).toBeNull();
  });

  it("returns null exactly at the expiry boundary (expires_at === now)", async () => {
    const repo = makeRepo();
    const ttlMs = 5000;
    const { token } = await createRequest(repo, { ttlMs });

    // now === expires_at → expired
    const exactExpiry = new Date(BASE_NOW.getTime() + ttlMs);

    const result = await verifyApprovalToken(token, { now: exactExpiry, repository: repo });

    expect(result).toBeNull();
  });

  it("returns null when the request is already decided (status !== 'pending')", async () => {
    const repo = makeRepo();
    const { token, request } = await createRequest(repo);
    const { emitEvent } = makeEmitter();

    // Decide the request.
    await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    // Verify should now return null since it's no longer pending.
    const result = await verifyApprovalToken(token, { now: BASE_NOW, repository: repo });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideApproval — happy paths
// ---------------------------------------------------------------------------

describe("decideApproval — happy paths", () => {
  async function createPendingRequest(repo: InMemoryApprovalRepository) {
    const { emitEvent } = makeEmitter();
    return createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });
  }

  const decisions = ["approved", "rejected", "cancelled", "expired"] as const;
  const channels = ["email_reply", "web_link", "cron"] as const;

  for (const decision of decisions) {
    for (const channel of channels) {
      it(`decision='${decision}' channel='${channel}' → status:decided, row updated, event emitted`, async () => {
        const repo = makeRepo();
        const { request } = await createPendingRequest(repo);
        const { emitted, emitEvent } = makeEmitter();

        const result = await decideApproval({
          approvalId: request.id,
          decision,
          channel,
          now: BASE_NOW,
          repository: repo,
          emitEvent,
        });

        expect(result.status).toBe("decided");
        if (result.status === "decided") {
          expect(result.request.status).toBe(decision);
          expect(result.request.decidedAt).toEqual(BASE_NOW);
          expect(result.request.decisionChannel).toBe(channel);
        }

        expect(emitted).toHaveLength(1);
        const event = emitted[0];
        expect(event?.name).toBe("approval.received");
        const data = event?.data as EventMap["approval.received"];
        expect(data.approvalId).toBe(request.id);
        expect(data.userId).toBe(USER_ID);
        expect(data.decision).toBe(decision);
        expect(data.channel).toBe(channel);
      });
    }
  }

  it("persists metadata on the decided row", async () => {
    const repo = makeRepo();
    const { request } = await createPendingRequest(repo);
    const { emitEvent } = makeEmitter();

    const result = await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      metadata: { ipAddress: "1.2.3.4" },
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.status).toBe("decided");
    if (result.status === "decided") {
      expect(result.request.decisionMetadata).toEqual({ ipAddress: "1.2.3.4" });
    }
  });
});

// ---------------------------------------------------------------------------
// decideApproval — idempotency
// ---------------------------------------------------------------------------

describe("decideApproval — idempotency", () => {
  it("double-decide returns already_decided without updating the row", async () => {
    const repo = makeRepo();
    const { emitEvent: emitEvent1 } = makeEmitter();
    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitEvent1,
    });

    const { emitted: emitted1, emitEvent } = makeEmitter();

    // First decide.
    const first = await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });
    expect(first.status).toBe("decided");
    expect(emitted1).toHaveLength(1);

    // Second decide — same request, different decision attempted.
    const { emitted: emitted2, emitEvent: emitEvent2 } = makeEmitter();

    const second = await decideApproval({
      approvalId: request.id,
      decision: "rejected",
      channel: "email_reply",
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitEvent2,
    });

    expect(second.status).toBe("already_decided");
    // No event emitted on the second call.
    expect(emitted2).toHaveLength(0);

    // The row should still reflect the FIRST decision.
    if (second.status === "already_decided") {
      expect(second.request.status).toBe("approved");
      expect(second.request.decisionChannel).toBe("web_link");
    }
  });

  it("double-decide preserves the original decided_at timestamp", async () => {
    const repo = makeRepo();
    const { emitEvent: emitCreate } = makeEmitter();
    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitCreate,
    });

    const { emitEvent: emit1 } = makeEmitter();
    await decideApproval({
      approvalId: request.id,
      decision: "cancelled",
      channel: "cron",
      now: BASE_NOW,
      repository: repo,
      emitEvent: emit1,
    });

    const { emitEvent: emit2 } = makeEmitter();
    const laterNow = new Date(BASE_NOW.getTime() + 60_000);
    const second = await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      now: laterNow,
      repository: repo,
      emitEvent: emit2,
    });

    expect(second.status).toBe("already_decided");
    if (second.status === "already_decided") {
      // decided_at must be the original time, not the later retry time.
      expect(second.request.decidedAt?.getTime()).toBe(BASE_NOW.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// decideApproval — not found
// ---------------------------------------------------------------------------

describe("decideApproval — not found", () => {
  it("returns not_found for an unknown approvalId", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();

    const result = await decideApproval({
      approvalId: randomUUID(),
      decision: "approved",
      channel: "web_link",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.status).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// decideApproval — expiry guard
// ---------------------------------------------------------------------------

describe("decideApproval — expiry guard", () => {
  it("rejects 'approved' on a clock-expired but still-pending row", async () => {
    const repo = makeRepo();
    const { emitEvent: emitCreate } = makeEmitter();

    // Create request that expires 1 ms in the future from BASE_NOW.
    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs: 1,
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitCreate,
    });

    // now = expires_at → already expired
    const expiredNow = new Date(BASE_NOW.getTime() + 1);

    const { emitted, emitEvent } = makeEmitter();
    const result = await decideApproval({
      approvalId: request.id,
      decision: "approved",
      channel: "web_link",
      now: expiredNow,
      repository: repo,
      emitEvent,
    });

    expect(result.status).toBe("expired");
    expect(emitted).toHaveLength(0);
  });

  it("rejects 'rejected' on a clock-expired but still-pending row", async () => {
    const repo = makeRepo();
    const { emitEvent: emitCreate } = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs: 1,
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitCreate,
    });

    const expiredNow = new Date(BASE_NOW.getTime() + 1);
    const { emitEvent } = makeEmitter();

    const result = await decideApproval({
      approvalId: request.id,
      decision: "rejected",
      channel: "email_reply",
      now: expiredNow,
      repository: repo,
      emitEvent,
    });

    expect(result.status).toBe("expired");
  });

  it("rejects 'cancelled' on a clock-expired but still-pending row", async () => {
    const repo = makeRepo();
    const { emitEvent: emitCreate } = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs: 1,
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitCreate,
    });

    const expiredNow = new Date(BASE_NOW.getTime() + 1);
    const { emitEvent } = makeEmitter();

    const result = await decideApproval({
      approvalId: request.id,
      decision: "cancelled",
      channel: "cron",
      now: expiredNow,
      repository: repo,
      emitEvent,
    });

    expect(result.status).toBe("expired");
  });

  it("allows 'expired' decision on a clock-expired pending row (sweep path)", async () => {
    const repo = makeRepo();
    const { emitEvent: emitCreate } = makeEmitter();

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs: 1,
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitCreate,
    });

    const expiredNow = new Date(BASE_NOW.getTime() + 1);
    const { emitted, emitEvent } = makeEmitter();

    const result = await decideApproval({
      approvalId: request.id,
      decision: "expired",
      channel: "cron",
      now: expiredNow,
      repository: repo,
      emitEvent,
    });

    expect(result.status).toBe("decided");
    if (result.status === "decided") {
      expect(result.request.status).toBe("expired");
    }
    // Event should still be emitted for the expiry transition.
    expect(emitted).toHaveLength(1);
    const data = emitted[0]?.data as EventMap["approval.received"];
    expect(data.decision).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// TTL arithmetic
// ---------------------------------------------------------------------------

describe("TTL arithmetic", () => {
  it("expires_at is exactly now + ttlMs (no rounding, no drift)", async () => {
    const repo = makeRepo();
    const { emitEvent } = makeEmitter();

    const now = new Date("2026-06-12T08:30:45.123Z");
    const ttlMs = 7 * 24 * 60 * 60 * 1000;

    const { request } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs,
      now,
      repository: repo,
      emitEvent,
    });

    expect(request.expiresAt.getTime()).toBe(now.getTime() + ttlMs);
  });

  it("request is valid 1ms before expiry and invalid exactly at expiry", async () => {
    const repo = makeRepo();
    const { emitEvent: emitCreate } = makeEmitter();
    const ttlMs = 10_000;

    const { token } = await createApprovalRequest({
      userId: USER_ID,
      draft: { actionKind: "test_action" },
      ttlMs,
      now: BASE_NOW,
      repository: repo,
      emitEvent: emitCreate,
    });

    const justBefore = new Date(BASE_NOW.getTime() + ttlMs - 1);
    const exactExpiry = new Date(BASE_NOW.getTime() + ttlMs);

    const validResult = await verifyApprovalToken(token, { now: justBefore, repository: repo });
    expect(validResult).not.toBeNull();

    const expiredResult = await verifyApprovalToken(token, { now: exactExpiry, repository: repo });
    expect(expiredResult).toBeNull();
  });
});
