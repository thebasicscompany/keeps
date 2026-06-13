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

  // -------------------------------------------------------------------------
  // Phase 6 trust events — account-wide deletion (deliverable 7)
  // -------------------------------------------------------------------------

  /**
   * Emitted by POST /api/data/delete after the data_deletion_requests row is
   * created. Consumed by the `process-data-deletion` Inngest function, which
   * deletes the Clerk user and cascades the account graph. `userId`/`email`
   * are captured at request time so the workflow can purge by both even after
   * the users row is gone.
   */
  "data.delete_requested": {
    dataDeletionRequestId: string;
    userId: string;
    email: string;
  };

  /**
   * Emitted by `process-data-deletion` ONLY on the run that transitions the
   * request to `completed`. A replay that hits the already-`completed` guard
   * does NOT re-emit, so downstream consumers see exactly one completion.
   */
  "data.delete_completed": {
    dataDeletionRequestId: string;
    userId: string;
    email: string;
  };

  // -------------------------------------------------------------------------
  // Phase 6 B3: Data export events
  // -------------------------------------------------------------------------

  /**
   * Emitted by POST /api/data/export after auth. Triggers the generate-data-export
   * Inngest function, which assembles the JSON export and uploads it to Blob (if configured).
   */
  "data.export_requested": {
    userId: string;
    /** ISO timestamp when the export was requested (minted in the API route). */
    requestedAt: string;
  };

  /**
   * Emitted by generate-data-export after the export JSON is ready. Triggers the
   * send-export-email function, which emails the user their download link (or inline JSON).
   */
  "data.export_completed": {
    userId: string;
    /** Vercel Blob download URL valid for 24h, or null when Blob is not configured. */
    downloadUrl: string | null;
    /** The full export JSON when Blob is NOT configured (null when Blob is used). */
    inline: string | null;
    /** ISO timestamp when the download link expires (24h from now), or null when inline. */
    expiresAt: string | null;
  };

  // -------------------------------------------------------------------------
  // Phase 6 C2: nudge final-failure event (deliverable 13/12)
  // -------------------------------------------------------------------------

  /**
   * Emitted by send-nudge's `onFailure` handler after all retries are exhausted.
   * The nudge row (if created) has already been flipped to status='failed'.
   * Downstream observers (alerting, ops dashboard) can react without re-querying.
   */
  "nudge.failed": {
    nudgeId: string;
    userId: string;
    error: string;
  };

  // -------------------------------------------------------------------------
  // Phase 6 C1: dead-letter / failed-processing events (deliverable 14)
  // -------------------------------------------------------------------------

  /**
   * Emitted by a function's `onFailure` handler AFTER retries are exhausted, in the
   * same step that writes the failed_processing dead-letter row. Carries the original
   * event name + payload plus the final error so downstream observers (alerting, an
   * ops dashboard) can react without re-querying the row. `inboundEmailId` is optional
   * because a failure may pre-date persistence (no FK on the column).
   */
  "email.processing_failed": {
    inboundEmailId?: string;
    eventName: string;
    eventPayload: object;
    errorMessage: string;
    errorStack?: string;
    /** ISO timestamp when the run was dead-lettered. */
    failedAt: string;
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
