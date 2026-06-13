/**
 * src/audit/summarize-row.ts
 *
 * Pure, side-effect-free presentational helpers for audit_log rows.
 * Factored out of the page component so they can be unit-tested without
 * a DB or a React environment.
 *
 * SECURITY: for sensitive actions (e.g. email.inbound.*) we surface the
 * subject and sender from metadata ONLY — never the body.
 */

import type { AuditLogEntry } from "@/db/schema";

/**
 * Human-readable label for each audit action enum value.
 * Unlisted values fall back to the raw action string.
 */
export const ACTION_LABELS: Record<string, string> = {
  "user.created": "Account created",
  "user.email_verified": "Email verified",
  "user.working_style_updated": "Working style updated",
  "user.deleted": "Account deleted",
  "auth.dev_session_created": "Dev session started",
  "auth.clerk_user_created": "Sign-up via Clerk",
  "auth.clerk_email_verified": "Email verified via Clerk",
  "email.inbound.placeholder_received": "Email placeholder received",
  "email.inbound.pending_created": "Email queued (pending activation)",
  "email.inbound.received": "Email received",
  "email.inbound.duplicate": "Duplicate email received",
  "email.inbound.claimed": "Email claimed",
  "email.classified": "Email classified",
  "email.activation_sent": "Activation email sent",
  "email.activation_suppressed": "Activation email suppressed",
  "email.thread_followed": "Thread followed",
  "email.outbound.suppressed": "Outbound email suppressed",
  "email.deleted_by_user": "Email deleted by user",
  "loops.extracted": "Loops extracted from email",
  "loop.created": "Loop created",
  "loop.updated": "Loop updated",
  "policy.external_action_blocked": "External action blocked by policy",
  "policy.authorize_denied": "Authorization denied",
  "nudge.sent": "Nudge sent",
  "digest.sent": "Digest sent",
  "approval.requested": "Approval requested",
  "approval.decided": "Approval decision made",
  "approval.expired": "Approval expired",
  "approval.executed": "Approved action executed",
  "approval.execution_failed": "Approved action failed",
  "connector.account_connected": "Connector account connected",
  "connector.account_revoked": "Connector account revoked",
  "connector.account_auth_error": "Connector authentication error",
  "connector.action_requested": "Connector action requested",
  "connector.action_executed": "Connector action executed",
  "connector.action_failed": "Connector action failed",
  "connector.recipient_ambiguous": "Connector recipient ambiguous",
  "report.requested": "Report requested",
  "report.generated": "Report generated",
  "report.viewed": "Report viewed",
  "report.action_applied": "Report action applied",
  "data.export_requested": "Data export requested",
  "data.export_completed": "Data export completed",
  "data.delete_requested": "Account deletion requested",
  "data.delete_completed": "Account deletion completed",
  "failed_processing.replayed": "Failed job replayed",
};

/**
 * Actions where we show select metadata fields — but NEVER the email body.
 * The allowlisted field keys below are safe to display.
 */
const INBOUND_EMAIL_ACTIONS = new Set([
  "email.inbound.received",
  "email.inbound.placeholder_received",
  "email.inbound.pending_created",
  "email.inbound.duplicate",
  "email.inbound.claimed",
  "email.classified",
  "email.thread_followed",
  "email.deleted_by_user",
]);

/**
 * Metadata fields we are allowed to render for inbound-email actions.
 * body / textBody / htmlBody / rawBody / strippedTextReply are intentionally
 * excluded — they never appear in the rendered summary.
 */
const SAFE_EMAIL_METADATA_KEYS = new Set([
  "subject",
  "from",
  "sender",
  "senderEmail",
  "senderName",
  "to",
  "inboundEmailId",
  "emailThreadId",
  "messageId",
  "provider",
  "providerMessageId",
]);

/** Extract a terse human summary from an audit log row's metadata. */
export function summarizeMetadata(row: AuditLogEntry): string {
  const meta = row.metadata as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object") return "";

  // For inbound-email actions, only render whitelisted safe fields.
  if (INBOUND_EMAIL_ACTIONS.has(row.action)) {
    const parts: string[] = [];
    const subject = meta["subject"] ?? meta["Subject"];
    const sender =
      meta["senderEmail"] ?? meta["senderName"] ?? meta["from"] ?? meta["sender"];
    if (subject && typeof subject === "string") {
      parts.push(`Subject: ${subject}`);
    }
    if (sender && typeof sender === "string") {
      parts.push(`From: ${sender}`);
    }
    return parts.join(" · ");
  }

  // For connector actions, surface provider + kind/status if present.
  if (row.action.startsWith("connector.")) {
    const parts: string[] = [];
    if (meta["provider"]) parts.push(String(meta["provider"]));
    if (meta["kind"]) parts.push(String(meta["kind"]));
    if (meta["status"]) parts.push(String(meta["status"]));
    if (meta["externalAccountEmail"]) parts.push(String(meta["externalAccountEmail"]));
    return parts.join(" · ");
  }

  // Approval actions: surface kind + status.
  if (row.action.startsWith("approval.")) {
    const parts: string[] = [];
    if (meta["actionKind"]) parts.push(String(meta["actionKind"]));
    if (meta["status"]) parts.push(String(meta["status"]));
    return parts.join(" · ");
  }

  // Report actions.
  if (row.action.startsWith("report.")) {
    const parts: string[] = [];
    if (meta["kind"]) parts.push(String(meta["kind"]));
    return parts.join(" · ");
  }

  // Data actions.
  if (row.action.startsWith("data.")) {
    if (meta["exportFormat"]) return `Format: ${meta["exportFormat"]}`;
    return "";
  }

  // Generic fallback: render a short key=value list, excluding body-like keys.
  const BODY_KEYS = new Set([
    "body",
    "textBody",
    "htmlBody",
    "rawBody",
    "strippedTextReply",
    "normalizedBody",
    "rawPayload",
    "normalizedPayload",
    "promptPreview",
  ]);
  const entries = Object.entries(meta)
    .filter(([k, v]) => !BODY_KEYS.has(k) && v !== null && v !== undefined && v !== "")
    .slice(0, 4)
    .map(([k, v]) => {
      const display = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}: ${display.length > 60 ? display.slice(0, 57) + "…" : display}`;
    });
  return entries.join(" · ");
}

/** Human-readable label for an audit action enum value. */
export function labelForAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * Verifiable guard: returns true if the given action is considered
 * "email body sensitive" — i.e. any rendering of this action MUST NOT
 * include body content.
 */
export function isSensitiveEmailAction(action: string): boolean {
  return INBOUND_EMAIL_ACTIONS.has(action);
}
