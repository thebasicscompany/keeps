import { inngest } from "@/workflows/client";
import type { NormalizedEmail } from "@/email/normalize";
import type { LoopStatus, ConnectorCommandDraft } from "@/agent/schemas";

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
   * Phase 5 canonical shape. Emitted by the insight-command branch of the intent
   * router (route-email.ts) after `classifyInsightCommand` resolves the kind + scope,
   * and (legacy) by the question handler with `kind: 'insights'`. Consumed by the
   * `generate-report` Inngest function, which produces the report + private reply.
   * Never carries the raw token.
   */
  "report.requested": {
    userId: string;
    kind: "insights" | "waiting_on" | "stale" | "weekly" | "entity";
    scope: Record<string, unknown>;
    requestedVia: "email_command" | "email_question" | "digest" | "manual";
    inboundEmailId?: string;
    nudgeId?: string;
  };
  "report.generated": {
    userId: string;
    reportId: string;
    kind: string;
    scope: Record<string, unknown>;
    /** ISO timestamp */
    expiresAt: string;
    tokenHash: string;
    summaryHeadline: string;
    replyNudgeId: string;
  };
  "report.viewed": {
    userId: string;
    reportId: string;
    /** ISO timestamp */
    viewedAt: string;
    viewerKind: "anonymous_link" | "clerk_session";
    userAgentHash?: string;
  };

  // -------------------------------------------------------------------------
  // Phase 4 connector events
  // -------------------------------------------------------------------------

  /**
   * Emitted by the intent router (process-email) after a connector command is
   * parsed. The full parsed ConnectorCommandDraft travels inline because the
   * connector_actions row cannot be created until Wave D resolves the account
   * (connector_account_id is NOT NULL) — there is no connectorActionId yet.
   */
  "connector.action_requested": {
    userId: string;
    inboundEmailId: string;
    emailThreadId: string;
    provider: "slack" | "google_calendar";
    kind: "slack_dm" | "calendar_event";
    command: ConnectorCommandDraft;
  };

  /**
   * Emitted by the Nango webhook handler on a successful OAuth connection
   * (auth.success). The Wave C hydration step later populates
   * externalAccountEmail from the Nango connection metadata.
   */
  "connector.connected": {
    userId: string;
    provider: "slack" | "google_calendar";
    connectorAccountId: string;
    externalAccountEmail: string | null;
  };

  /**
   * Emitted when a connector account is revoked — either by the user
   * disconnecting, a Nango auth_error / refresh_error webhook, or an
   * admin disable action.
   */
  "connector.revoked": {
    userId: string;
    provider: "slack" | "google_calendar";
    connectorAccountId: string;
    reason: string;
  };

  /**
   * Emitted by the connector-command handler (Wave D) after a successful
   * tool execution (Slack chat.postMessage / Calendar events.insert).
   */
  "connector.action_completed": {
    userId: string;
    connectorActionId: string;
    provider: "slack" | "google_calendar";
    kind: "slack_dm" | "calendar_event";
    result: unknown;
  };

  /**
   * Emitted by the connector-command handler when execution fails after all
   * retries. `retryable` indicates whether the caller may safely re-submit.
   */
  "connector.action_failed": {
    userId: string;
    connectorActionId: string;
    provider: "slack" | "google_calendar";
    kind: "slack_dm" | "calendar_event";
    error: { code: string; message: string; retryable: boolean };
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
