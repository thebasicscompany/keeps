import { inngest } from "@/workflows/client";
import type { NormalizedEmail } from "@/email/normalize";
import type { LoopStatus } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// EventMap — the canonical event registry for all Keeps workflow events.
// Each key is the event name on the wire; each value is the `data` payload.
// ---------------------------------------------------------------------------

export type EventMap = {
  // -------------------------------------------------------------------------
  // Inbound email events (Phase 1/2 — from @/email/inbound)
  // -------------------------------------------------------------------------
  "email.sender_unknown": {
    pendingInboundEmailId: string;
    provider: NormalizedEmail["provider"];
    providerMessageId: string;
    senderEmail: string;
    subject: string;
  };
  "email.sender_verified": {
    userId: string;
    email: string;
    claimedCount: number;
  };
  "email.received": {
    inboundEmailId: string;
    emailThreadId: string;
    userId: string;
    provider: NormalizedEmail["provider"];
    providerMessageId: string;
    subject: string;
  };

  // -------------------------------------------------------------------------
  // Loop processing events (Phase 2 — from @/loops/service)
  // -------------------------------------------------------------------------
  "email.classified": {
    inboundEmailId: string;
    emailThreadId: string;
    userId: string;
    intent: string;
    /** Dispatched branch; mirrors `intent` today, kept distinct for multi-intent emails. */
    branch: string;
    loopCount: number;
  };
  "loops.extracted": {
    inboundEmailId: string;
    emailThreadId: string;
    userId: string;
    loopCount: number;
    lowConfidence: boolean;
  };
  "loop.created": {
    loopId: string;
    inboundEmailId: string;
    emailThreadId: string;
    userId: string;
    status: LoopStatus;
    sourceEvidenceId: string;
  };
  "loop.updated": {
    loopId: string;
    userId: string;
    status: LoopStatus;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
  };

  // -------------------------------------------------------------------------
  // Phase 3 events
  // -------------------------------------------------------------------------
  "loop.nudge_due": {
    userId: string;
    loopId: string;
    reason: "next_check_due" | "candidate_re_ask" | "stale_check";
    /** ISO timestamp */
    scheduledFor: string;
  };
  "digest.daily_due": {
    userId: string;
    localDateIso: string;
  };
  "digest.daily_requested": {
    userId: string;
    inboundEmailId: string;
  };
  "approval.requested": {
    approvalId: string;
    userId: string;
    draftId: string;
    actionKind: string;
    expiresAt: string;
  };
  "approval.received": {
    approvalId: string;
    userId: string;
    decision: "approved" | "rejected" | "cancelled" | "expired";
    channel: "email_reply" | "web_link" | "cron";
  };
  /**
   * Stub — Phase 5 owns the canonical shape. Emitted from the question router
   * with `kind: 'insights'`; no consumer beyond an audit log entry in Phase 3.
   */
  "report.requested": {
    userId: string;
    kind: "insights";
    scope?: unknown;
    requestedVia: string;
    inboundEmailId?: string;
    nudgeId?: string;
  };
};

// ---------------------------------------------------------------------------
// Derived union type — one member per event in EventMap.
// Used for step.sendEvent compatibility (result.events in process-email).
// ---------------------------------------------------------------------------

export type KeepsWorkflowEvent = {
  [K in keyof EventMap]: { name: K; data: EventMap[K] };
}[keyof EventMap];

// ---------------------------------------------------------------------------
// Typed send helper — primary API going forward.
// ---------------------------------------------------------------------------

export async function sendEvent<K extends keyof EventMap>(
  name: K,
  data: EventMap[K],
): Promise<void> {
  await inngest.send({ name, data } as { name: string; data: EventMap[K] });
}

// ---------------------------------------------------------------------------
// Back-compat wrapper — existing callers pass a full { name, data } object.
// Kept so that clerk-users.ts, inbound/route.ts, and email/inbound.ts
// (SendInboundWorkflowEvent) continue to compile without modification.
// ---------------------------------------------------------------------------

export async function sendWorkflowEvent(event: KeepsWorkflowEvent): Promise<void> {
  await inngest.send(event as { name: string; data: unknown });
}
