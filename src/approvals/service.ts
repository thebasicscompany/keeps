import { randomUUID } from "node:crypto";
import { mintApprovalToken, hashApprovalToken } from "@/approvals/tokens";
import { sendEvent } from "@/workflows/events";
import type { ApprovalRequest } from "@/db/schema";
import type { ApprovalRepository } from "@/approvals/repository";
import type { EventMap } from "@/workflows/events";

// ---------------------------------------------------------------------------
// Injected event emitter type — lets tests swap out sendEvent.
// ---------------------------------------------------------------------------

type EmitEvent = <K extends keyof EventMap>(name: K, data: EventMap[K]) => Promise<void>;

// ---------------------------------------------------------------------------
// createApprovalRequest
// ---------------------------------------------------------------------------

export type CreateApprovalRequestInput = {
  userId: string;
  draft: {
    actionKind: string;
    payload?: Record<string, unknown>;
    sourceLoopId?: string;
    requiresLogin?: boolean;
  };
  /** Default: 7 days in milliseconds */
  ttlMs?: number;
  now: Date;
  repository: ApprovalRepository;
  /**
   * Event emitter — defaults to the typed sendEvent from @/workflows/events.
   * Tests inject an in-memory fake to avoid hitting Inngest.
   */
  emitEvent?: EmitEvent;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createApprovalRequest(
  input: CreateApprovalRequestInput,
): Promise<{ request: ApprovalRequest; token: string }> {
  const {
    userId,
    draft: draftInput,
    ttlMs = DEFAULT_TTL_MS,
    now,
    repository,
    emitEvent: emit = sendEvent,
  } = input;

  const { token, hash: tokenHash } = mintApprovalToken();

  const expiresAt = new Date(now.getTime() + ttlMs);

  // Insert the draft row first (approval_requests references it via FK).
  const draft = await repository.insertDraft({
    userId,
    actionKind: draftInput.actionKind,
    payload: draftInput.payload ?? {},
    sourceLoopId: draftInput.sourceLoopId ?? null,
    requiresLogin: draftInput.requiresLogin ?? false,
  });

  // Insert the approval_request row with a fresh UUID.
  const request = await repository.insertApprovalRequest({
    id: randomUUID(),
    userId,
    draftId: draft.id,
    actionKind: draftInput.actionKind,
    tokenHash,
    expiresAt,
  });

  // Emit the event AFTER both rows are committed so the workflow has a consistent row to load.
  await emit("approval.requested", {
    approvalId: request.id,
    userId: request.userId,
    draftId: request.draftId,
    actionKind: request.actionKind,
    expiresAt: request.expiresAt.toISOString(),
  });

  // Return the plaintext token to the caller (for the email link).
  // It is never persisted, never logged.
  return { request, token };
}

// ---------------------------------------------------------------------------
// rotateApprovalToken
// ---------------------------------------------------------------------------

/**
 * Mints a FRESH plaintext approval token and overwrites token_hash on the
 * still-pending approval row, returning the new plaintext.
 *
 * WHY THIS EXISTS (rule 7 — plaintext tokens never appear in events/logs):
 * `createApprovalRequest` returns its minted plaintext token to its synchronous
 * caller and emits `approval.requested` WITHOUT the token (events are persisted
 * in Inngest Cloud logs — a capturable token there would be a leak). The
 * `handle-approval` workflow is driven by that event, so it never sees the
 * original plaintext. Rather than smuggle the token through the event, the
 * workflow re-mints here: a new token is generated, its hash replaces the old
 * one (WHERE status='pending'), and the plaintext is handed back for the email
 * link. The original mint is simply superseded — both hash the same way, so
 * either token would have verified, but only the rotated plaintext is ever
 * surfaced to the user (in the email body alone — never an event, audit row,
 * nudge metadata, or log).
 *
 * Returns `null` when the row is not found OR no longer pending (the WHERE-pending
 * guard matched no row), in which case nothing was changed — a decided/expired
 * approval cannot have its token rotated.
 */
export async function rotateApprovalToken(input: {
  approvalId: string;
  repository: ApprovalRepository;
}): Promise<{ token: string } | null> {
  const { approvalId, repository } = input;

  const existing = await repository.findApprovalById(approvalId);
  if (!existing || existing.status !== "pending") {
    return null;
  }

  const { token, hash } = mintApprovalToken();

  const rotated = await repository.updateApprovalTokenHash({
    id: approvalId,
    tokenHash: hash,
  });

  if (!rotated) {
    // Lost the race: decided between our read and write. Nothing changed.
    return null;
  }

  return { token };
}

// ---------------------------------------------------------------------------
// verifyApprovalToken
// ---------------------------------------------------------------------------

/**
 * Looks up an approval request by the SHA-256 hash of the provided token.
 * Returns null when:
 *   - not found,
 *   - the request has already been decided (status !== 'pending'), or
 *   - the request has expired (expires_at <= now).
 */
export async function verifyApprovalToken(
  token: string,
  options: { now: Date; repository: ApprovalRepository },
): Promise<ApprovalRequest | null> {
  const { now, repository } = options;

  const tokenHash = hashApprovalToken(token);
  const row = await repository.findApprovalByTokenHash(tokenHash);

  if (!row) {
    return null;
  }

  if (row.expiresAt <= now) {
    return null;
  }

  if (row.status !== "pending") {
    return null;
  }

  return row;
}

// ---------------------------------------------------------------------------
// decideApproval
// ---------------------------------------------------------------------------

export type DecisionKind = "approved" | "rejected" | "cancelled" | "expired";
export type DecisionChannel = "email_reply" | "web_link" | "cron";

export type DecideApprovalInput = {
  approvalId: string;
  decision: DecisionKind;
  channel: DecisionChannel;
  metadata?: Record<string, unknown>;
  now: Date;
  repository: ApprovalRepository;
  emitEvent?: EmitEvent;
};

export type DecideApprovalResult =
  | { status: "decided"; request: ApprovalRequest }
  | { status: "already_decided"; request: ApprovalRequest }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * Single state-transition function for approval decisions.
 *
 * IDEMPOTENT: if the row is already decided, returns the current state WITHOUT
 * updating and WITHOUT emitting.
 *
 * EXPIRY GUARD: approve/reject/cancel decisions on an expired-by-clock but
 * still-pending row are rejected with { status: 'expired' }. The 'expired'
 * decision itself is always allowed (that's the sweep's job).
 */
export async function decideApproval(input: DecideApprovalInput): Promise<DecideApprovalResult> {
  const {
    approvalId,
    decision,
    channel,
    metadata,
    now,
    repository,
    emitEvent: emit = sendEvent,
  } = input;

  // Load the current state of the row.
  const existing = await repository.findApprovalById(approvalId);

  if (!existing) {
    return { status: "not_found" };
  }

  // If already decided, return current state without any side effects.
  if (existing.status !== "pending") {
    return { status: "already_decided", request: existing };
  }

  // Clock-expiry guard: non-'expired' decisions are rejected when the row has
  // expired by the clock but the DB row still shows 'pending'.
  if (decision !== "expired" && existing.expiresAt <= now) {
    return { status: "expired" };
  }

  // Attempt the state transition with the WHERE-pending guard.
  const updated = await repository.updateApprovalDecision({
    id: approvalId,
    status: decision,
    decidedAt: now,
    decisionChannel: channel,
    decisionMetadata: metadata ?? {},
    updatedAt: now,
  });

  if (!updated) {
    // Race: another actor decided between our load and update.
    // Reload to return the current state.
    const reloaded = await repository.findApprovalById(approvalId);
    if (reloaded) {
      return { status: "already_decided", request: reloaded };
    }
    return { status: "not_found" };
  }

  // Emit ONLY on successful transition.
  await emit("approval.received", {
    approvalId: updated.id,
    userId: updated.userId,
    decision,
    channel,
  });

  return { status: "decided", request: updated };
}
