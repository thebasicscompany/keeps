/**
 * decide-web.test.ts
 *
 * Unit tests for the decide-web service layer.
 * All tests use in-memory fakes — no Postgres, no Inngest.
 *
 * Key security scenarios:
 *   - A valid token for approval A must not open approval B.
 *   - An expired token is clearly distinguished from an invalid token.
 *   - Double-submits surface "already_decided" — never an error.
 *   - Bogus action strings (anything other than "approve"/"cancel") are rejected.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mintApprovalToken, hashApprovalToken } from "@/approvals/tokens";
import { loadApprovalForWeb, decideFromWeb } from "@/approvals/decide-web";
import type { ApprovalRepository, ApprovalRequestWithDraft } from "@/approvals/repository";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";
import type { EventMap } from "@/workflows/events";

// ---------------------------------------------------------------------------
// In-memory fake repository (mirrors service.test.ts for consistency)
// ---------------------------------------------------------------------------

class InMemoryApprovalRepository implements ApprovalRepository {
  private drafts = new Map<string, Draft>();
  private requests = new Map<string, ApprovalRequest>();

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

const BASE_NOW = new Date("2026-06-12T12:00:00.000Z");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const USER_ID = "00000000-0000-0000-0000-000000000001";

type EmittedEvent = { name: keyof EventMap; data: EventMap[keyof EventMap] };

function makeEmitter() {
  const emitted: EmittedEvent[] = [];
  const emitEvent = async <K extends keyof EventMap>(name: K, data: EventMap[K]) => {
    emitted.push({ name, data } as EmittedEvent);
  };
  return { emitted, emitEvent };
}

/** Seed a pending approval request into the repository and return token + ids. */
async function seedApproval(
  repo: InMemoryApprovalRepository,
  options: {
    now?: Date;
    expiresAt?: Date;
    requiresLogin?: boolean;
    actionKind?: string;
  } = {},
) {
  const now = options.now ?? BASE_NOW;
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + SEVEN_DAYS_MS);
  const { token, hash } = mintApprovalToken();

  const draft = await repo.insertDraft({
    userId: USER_ID,
    actionKind: options.actionKind ?? "test_action",
    payload: { target: "slack" },
    requiresLogin: options.requiresLogin ?? false,
  });

  const request = await repo.insertApprovalRequest({
    id: randomUUID(),
    userId: USER_ID,
    draftId: draft.id,
    actionKind: options.actionKind ?? "test_action",
    tokenHash: hash,
    expiresAt,
  });

  return { token, hash, request, draft };
}

// ---------------------------------------------------------------------------
// loadApprovalForWeb
// ---------------------------------------------------------------------------

describe("loadApprovalForWeb — valid", () => {
  it("returns state=valid with the request and draft for a correct token", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token,
      now: BASE_NOW,
      repository: repo,
    });

    expect(result.state).toBe("valid");
    if (result.state === "valid") {
      expect(result.request.id).toBe(request.id);
      expect(result.draft.actionKind).toBe("test_action");
    }
  });
});

describe("loadApprovalForWeb — invalid_token", () => {
  it("returns invalid_token for a completely wrong token", async () => {
    const repo = new InMemoryApprovalRepository();
    const { request } = await seedApproval(repo);

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token: "wrong-token-value",
      now: BASE_NOW,
      repository: repo,
    });

    expect(result.state).toBe("invalid_token");
  });

  it("SECURITY: token minted for approval A is rejected when presented for approval B", async () => {
    const repo = new InMemoryApprovalRepository();

    // Seed two separate approvals.
    const { token: tokenA } = await seedApproval(repo);
    const { request: requestB } = await seedApproval(repo);

    // Token for A, path says B.
    const result = await loadApprovalForWeb({
      approvalId: requestB.id,
      token: tokenA,
      now: BASE_NOW,
      repository: repo,
    });

    // Must reject — tokenA's hash does not match requestB's token_hash.
    expect(result.state).toBe("invalid_token");
  });

  it("SECURITY: a token whose hash matches no stored row is rejected", async () => {
    const repo = new InMemoryApprovalRepository();
    const { request } = await seedApproval(repo);

    // Mint a fresh token that was never stored.
    const { token: freshToken } = mintApprovalToken();

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token: freshToken,
      now: BASE_NOW,
      repository: repo,
    });

    expect(result.state).toBe("invalid_token");
  });
});

describe("loadApprovalForWeb — expired", () => {
  it("returns expired when the approval has passed its expires_at", async () => {
    const repo = new InMemoryApprovalRepository();
    // Expire 1ms after BASE_NOW.
    const expiresAt = new Date(BASE_NOW.getTime() + 1);
    const { token, request } = await seedApproval(repo, { expiresAt });

    const afterExpiry = new Date(BASE_NOW.getTime() + 2);

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token,
      now: afterExpiry,
      repository: repo,
    });

    expect(result.state).toBe("expired");
  });

  it("returns expired at the exact expiry boundary", async () => {
    const repo = new InMemoryApprovalRepository();
    const ttlMs = 5000;
    const expiresAt = new Date(BASE_NOW.getTime() + ttlMs);
    const { token, request } = await seedApproval(repo, { expiresAt });

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token,
      now: expiresAt,
      repository: repo,
    });

    expect(result.state).toBe("expired");
  });
});

describe("loadApprovalForWeb — already_decided", () => {
  it("returns already_decided with the current status when the approval was approved", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);

    // Decide it.
    await repo.updateApprovalDecision({
      id: request.id,
      status: "approved",
      decidedAt: BASE_NOW,
      decisionChannel: "web_link",
      updatedAt: BASE_NOW,
    });

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token,
      now: BASE_NOW,
      repository: repo,
    });

    expect(result.state).toBe("already_decided");
    if (result.state === "already_decided") {
      expect(result.status).toBe("approved");
    }
  });

  it("returns already_decided for cancelled status", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);

    await repo.updateApprovalDecision({
      id: request.id,
      status: "cancelled",
      decidedAt: BASE_NOW,
      decisionChannel: "web_link",
      updatedAt: BASE_NOW,
    });

    const result = await loadApprovalForWeb({
      approvalId: request.id,
      token,
      now: BASE_NOW,
      repository: repo,
    });

    expect(result.state).toBe("already_decided");
    if (result.state === "already_decided") {
      expect(result.status).toBe("cancelled");
    }
  });
});

describe("loadApprovalForWeb — not_found", () => {
  it("returns not_found for an unknown approvalId", async () => {
    const repo = new InMemoryApprovalRepository();

    const result = await loadApprovalForWeb({
      approvalId: randomUUID(),
      token: "any-token",
      now: BASE_NOW,
      repository: repo,
    });

    expect(result.state).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// decideFromWeb
// ---------------------------------------------------------------------------

describe("decideFromWeb — approve", () => {
  it("maps action=approve to decision=approved and returns outcome=decided", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);
    const { emitted, emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("decided");
    if (result.outcome === "decided") {
      expect(result.decision).toBe("approved");
    }

    // Verify the row was updated.
    const updated = await repo.findApprovalById(request.id);
    expect(updated?.status).toBe("approved");
    expect(updated?.decisionChannel).toBe("web_link");

    // Event emitted.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.name).toBe("approval.received");
    const data = emitted[0]?.data as EventMap["approval.received"];
    expect(data.decision).toBe("approved");
    expect(data.channel).toBe("web_link");
  });
});

describe("decideFromWeb — cancel", () => {
  it("maps action=cancel to decision=cancelled and returns outcome=decided", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);
    const { emitted, emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "cancel",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("decided");
    if (result.outcome === "decided") {
      expect(result.decision).toBe("cancelled");
    }

    const updated = await repo.findApprovalById(request.id);
    expect(updated?.status).toBe("cancelled");

    expect(emitted).toHaveLength(1);
    const data = emitted[0]?.data as EventMap["approval.received"];
    expect(data.decision).toBe("cancelled");
  });
});

describe("decideFromWeb — double submit idempotency", () => {
  it("second submit returns outcome=already_decided, never an error", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);
    const { emitEvent: emit1 } = makeEmitter();

    // First submit.
    const first = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent: emit1,
    });
    expect(first.outcome).toBe("decided");

    // Second submit (same or different action — result must be already_decided).
    const { emitted: emitted2, emitEvent: emit2 } = makeEmitter();
    const second = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "cancel",
      now: BASE_NOW,
      repository: repo,
      emitEvent: emit2,
    });

    expect(second.outcome).toBe("already_decided");
    if (second.outcome === "already_decided") {
      expect(second.status).toBe("approved");
    }
    // No second event emitted.
    expect(emitted2).toHaveLength(0);
  });
});

describe("decideFromWeb — token security", () => {
  it("returns invalid_token when action=approve but token is wrong", async () => {
    const repo = new InMemoryApprovalRepository();
    const { request } = await seedApproval(repo);
    const { emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: request.id,
      token: "bad-token",
      action: "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("invalid_token");
  });

  it("SECURITY: token for approval A cannot approve approval B", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token: tokenA } = await seedApproval(repo);
    const { request: requestB } = await seedApproval(repo);
    const { emitted, emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: requestB.id,
      token: tokenA,
      action: "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("invalid_token");
    expect(emitted).toHaveLength(0);

    // requestB must still be pending.
    const b = await repo.findApprovalById(requestB.id);
    expect(b?.status).toBe("pending");
  });
});

describe("decideFromWeb — expired", () => {
  it("returns expired when the approval has lapsed", async () => {
    const repo = new InMemoryApprovalRepository();
    const expiresAt = new Date(BASE_NOW.getTime() + 1);
    const { token, request } = await seedApproval(repo, { expiresAt });
    const afterExpiry = new Date(BASE_NOW.getTime() + 2);
    const { emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "approve",
      now: afterExpiry,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("expired");
  });
});

describe("decideFromWeb — bogus action string", () => {
  it("returns invalid_token for an unrecognized action string", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);
    const { emitEvent } = makeEmitter();

    // Cast to bypass TypeScript typing — simulates raw HTTP with an arbitrary value.
    const result = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "delete" as "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("invalid_token");

    // Row must still be pending.
    const row = await repo.findApprovalById(request.id);
    expect(row?.status).toBe("pending");
  });

  it("returns invalid_token for empty string action", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token, request } = await seedApproval(repo);
    const { emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: request.id,
      token,
      action: "" as "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("invalid_token");
  });
});

describe("decideFromWeb — not_found", () => {
  it("returns not_found for an unknown approvalId", async () => {
    const repo = new InMemoryApprovalRepository();
    const { token } = mintApprovalToken();
    const { emitEvent } = makeEmitter();

    const result = await decideFromWeb({
      approvalId: randomUUID(),
      token,
      action: "approve",
      now: BASE_NOW,
      repository: repo,
      emitEvent,
    });

    expect(result.outcome).toBe("not_found");
  });
});
