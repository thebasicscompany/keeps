/**
 * generate-data-export — Inngest function id "generate-data-export"
 * Trigger: data.export_requested
 * Retries: 2
 *
 * Assembles a full JSON export of the user's data, uploads it to Vercel Blob
 * (private, with a 24h-expiry download URL) when BLOB_READ_WRITE_TOKEN is set,
 * or emits the JSON inline when Blob is not configured.
 *
 * Emits `data.export_completed` for the send-export-email function to pick up.
 *
 * Token exclusion policy:
 *   - connector_accounts: composioConnectedAccountId, composioEntityId, metadata
 *     are stripped — these identify/access the Composio OAuth session and must
 *     not leave the system. Kept: id, provider, externalAccountEmail,
 *     externalAccountLabel, scopes, status, statusReason, timestamps.
 *   - connector_actions: payload is the user-authored action (Slack message text,
 *     calendar event body) and is kept. result/error are execution outcomes and
 *     are kept. No token fields exist on connector_actions itself.
 *
 * Inngest determinism notes:
 *   - `now` is minted inside the first step.run and passed as ISO string across
 *     step boundaries.
 *   - Blob pathname includes a random suffix minted inside the step (not at
 *     module top level).
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import {
  users,
  emailThreads,
  inboundEmails,
  emailMessages,
  sourceEvidence,
  loops,
  loopEvents,
  nudges,
  approvalRequests,
  drafts,
  connectorActions,
  generatedReports,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Export shape
// ---------------------------------------------------------------------------

export type UserExportData = {
  exportedAt: string;
  userId: string;
  user: Record<string, unknown>;
  email_threads: Record<string, unknown>[];
  inbound_emails: Record<string, unknown>[];
  email_messages: Record<string, unknown>[];
  source_evidence: Record<string, unknown>[];
  loops: Record<string, unknown>[];
  loop_events: Record<string, unknown>[];
  nudges: Record<string, unknown>[];
  approval_requests: Record<string, unknown>[];
  drafts: Record<string, unknown>[];
  connector_actions: Record<string, unknown>[];
  generated_reports: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// NON-SENSITIVE user columns to export (excludes any internal admin flags that
// could be abused if the export were forwarded, but those are minimal here).
// Explicitly kept: identity columns the user recognises.
// ---------------------------------------------------------------------------

const USER_SAFE_COLUMNS = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  companyName: users.companyName,
  workingStyle: users.workingStyle,
  status: users.status,
  timezone: users.timezone,
  digestEnabled: users.digestEnabled,
  digestSendHour: users.digestSendHour,
  rawEmailRetentionDays: users.rawEmailRetentionDays,
  outboundEmailState: users.outboundEmailState,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  verifiedAt: users.verifiedAt,
  // isAdmin is intentionally excluded — the value is not useful to end-users
  // and revealing it in a portable export adds no value.
} as const;

// ---------------------------------------------------------------------------
// Core export builder — injectable db for testability
// ---------------------------------------------------------------------------

export async function buildUserExport({
  userId,
  db,
  now,
}: {
  userId: string;
  db: ReturnType<typeof getDb>;
  now?: Date;
}): Promise<UserExportData> {
  const exportedAt = (now ?? new Date()).toISOString();

  // User row (non-sensitive columns only)
  const [userRow] = await db
    .select(USER_SAFE_COLUMNS)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Email threads
  const threadRows = await db
    .select()
    .from(emailThreads)
    .where(eq(emailThreads.userId, userId));

  // Inbound emails — raw_payload nulled when scrubbed_at is set
  const rawInboundRows = await db
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.userId, userId));

  const inboundRows = rawInboundRows.map((row) => {
    if (row.scrubbedAt) {
      // Body fields were scrubbed by the retention cron; export them as null
      return {
        ...row,
        rawPayload: null,
        textBody: null,
        htmlBody: null,
        strippedTextReply: null,
        normalizedPayload: null,
        attachmentMetadata: null,
        headers: null,
        _scrubbed: true,
      };
    }
    return row;
  });

  // Email messages — body nulled when scrubbed_at is set
  const rawMessageRows = await db
    .select()
    .from(emailMessages)
    .where(eq(emailMessages.userId, userId));

  const messageRows = rawMessageRows.map((row) => {
    if (row.scrubbedAt) {
      return {
        ...row,
        textBody: null,
        htmlBody: null,
        strippedTextReply: null,
        _scrubbed: true,
      };
    }
    return row;
  });

  // Source evidence
  const evidenceRows = await db
    .select()
    .from(sourceEvidence)
    .where(eq(sourceEvidence.userId, userId));

  // Loops
  const loopRows = await db
    .select()
    .from(loops)
    .where(eq(loops.userId, userId));

  // Loop events
  const loopEventRows = await db
    .select()
    .from(loopEvents)
    .where(eq(loopEvents.userId, userId));

  // Nudges
  const nudgeRows = await db
    .select()
    .from(nudges)
    .where(eq(nudges.userId, userId));

  // Approval requests
  const approvalRows = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.userId, userId));

  // Drafts
  const draftRows = await db
    .select()
    .from(drafts)
    .where(eq(drafts.userId, userId));

  // Connector actions — strip token-like / credential fields.
  // The connectorAccountId FK is kept as a reference ID (it is not a secret),
  // but we DO NOT join connectorAccounts because it carries composioConnectedAccountId
  // and composioEntityId — those are the OAuth session identifiers that must not be
  // exported. The idempotencyKey is a deterministic application-level key (safe to export).
  const rawConnectorActionRows = await db
    .select({
      id: connectorActions.id,
      userId: connectorActions.userId,
      connectorAccountId: connectorActions.connectorAccountId,
      inboundEmailId: connectorActions.inboundEmailId,
      loopId: connectorActions.loopId,
      draftId: connectorActions.draftId,
      approvalRequestId: connectorActions.approvalRequestId,
      kind: connectorActions.kind,
      payload: connectorActions.payload,
      idempotencyKey: connectorActions.idempotencyKey,
      status: connectorActions.status,
      result: connectorActions.result,
      error: connectorActions.error,
      requestedAt: connectorActions.requestedAt,
      executedAt: connectorActions.executedAt,
      failedAt: connectorActions.failedAt,
      updatedAt: connectorActions.updatedAt,
      // NOTE: connector_actions has no token fields on the table itself.
      // Token-like fields live only on connector_accounts (composioConnectedAccountId,
      // composioEntityId, metadata) which we deliberately do NOT join.
    })
    .from(connectorActions)
    .where(eq(connectorActions.userId, userId));

  // Sanitize result/error fields: strip any key matching token-like patterns
  // (defensive: in case future columns add token fields to result/error JSON).
  const TOKEN_LIKE_KEYS = new Set([
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "api_key",
    "apiKey",
    "password",
    "credential",
    "credentials",
    "auth_token",
    "authToken",
    "composioConnectedAccountId",
    "composioEntityId",
  ]);

  function stripTokenFields(obj: unknown): unknown {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(stripTokenFields);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (TOKEN_LIKE_KEYS.has(k)) continue;
      result[k] = stripTokenFields(v);
    }
    return result;
  }

  const connectorActionRows = rawConnectorActionRows.map((row) => ({
    ...row,
    result: stripTokenFields(row.result),
    error: stripTokenFields(row.error),
    payload: stripTokenFields(row.payload),
  }));

  // Generated reports — tokenHash is a hashed value (not a usable secret) but
  // we strip it to avoid any potential misuse. The report URL can be reconstructed
  // from the report ID via the app.
  const rawReportRows = await db
    .select()
    .from(generatedReports)
    .where(eq(generatedReports.userId, userId));

  const reportRows = rawReportRows.map(({ tokenHash: _omit, ...rest }) => rest);

  return {
    exportedAt,
    userId,
    user: userRow as unknown as Record<string, unknown>,
    email_threads: threadRows as unknown as Record<string, unknown>[],
    inbound_emails: inboundRows as unknown as Record<string, unknown>[],
    email_messages: messageRows as unknown as Record<string, unknown>[],
    source_evidence: evidenceRows as unknown as Record<string, unknown>[],
    loops: loopRows as unknown as Record<string, unknown>[],
    loop_events: loopEventRows as unknown as Record<string, unknown>[],
    nudges: nudgeRows as unknown as Record<string, unknown>[],
    approval_requests: approvalRows as unknown as Record<string, unknown>[],
    drafts: draftRows as unknown as Record<string, unknown>[],
    connector_actions: connectorActionRows as unknown as Record<string, unknown>[],
    generated_reports: reportRows as unknown as Record<string, unknown>[],
  };
}

// ---------------------------------------------------------------------------
// Blob upload helper — tree-shaken when BLOB_READ_WRITE_TOKEN is absent
// ---------------------------------------------------------------------------

type BlobResult = { downloadUrl: string; expiresAt: string };

async function uploadToBlobIfConfigured(
  userId: string,
  exportJson: string,
  now: Date,
): Promise<BlobResult | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;

  // Lazy import so tests that don't set BLOB_READ_WRITE_TOKEN never hit the SDK
  const { put } = await import("@vercel/blob");

  // Use a random suffix to produce an unguessable pathname even for public blobs.
  // The path encodes the userId so export files are namespaced and don't collide.
  const suffix = randomUUID();
  const pathname = `exports/${userId}/${suffix}.json`;

  const blob = await put(pathname, exportJson, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    token,
  });

  // Vercel Blob private blobs: blob.downloadUrl is a signed URL. We return it
  // directly — the client uses it once; it expires because private blob URLs
  // are not permanently valid. Vercel Blob private signed URLs are 24h by default.
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  return { downloadUrl: blob.downloadUrl, expiresAt };
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

export const generateDataExportFunction = inngest.createFunction(
  {
    id: "generate-data-export",
    retries: 2,
    triggers: { event: "data.export_requested" },
  },
  async ({ event, step }) => {
    const userId = event.data.userId;

    // Step A: build export + upload to blob (or inline)
    const exportResult = await step.run("build-and-upload-export", async () => {
      const now = new Date();
      const { getDb } = await import("@/db/client");
      const db = getDb();

      const exportData = await buildUserExport({ userId, db, now });
      const exportJson = JSON.stringify(exportData, null, 2);

      const blobResult = await uploadToBlobIfConfigured(userId, exportJson, now);

      if (blobResult) {
        return {
          downloadUrl: blobResult.downloadUrl,
          inline: null,
          expiresAt: blobResult.expiresAt,
          nowIso: now.toISOString(),
        };
      }

      // Fallback: embed inline in the event (for small exports / local dev)
      return {
        downloadUrl: null,
        inline: exportJson,
        expiresAt: null,
        nowIso: now.toISOString(),
      };
    });

    // Step B: write audit + emit data.export_completed
    await step.run("emit-export-completed", async () => {
      const { getDb } = await import("@/db/client");
      const { auditLog } = await import("@/db/schema");
      const db = getDb();

      await db.insert(auditLog).values({
        userId,
        action: "data.export_completed",
        actorType: "system",
        metadata: {
          downloadUrl: exportResult.downloadUrl ?? null,
          hasInline: exportResult.inline !== null,
          expiresAt: exportResult.expiresAt ?? null,
        },
      });
    });

    // Step C: emit the completed event (triggers send-export-email)
    await step.sendEvent("send-export-email-trigger", {
      name: "data.export_completed",
      data: {
        userId,
        downloadUrl: exportResult.downloadUrl,
        inline: exportResult.inline,
        expiresAt: exportResult.expiresAt,
      },
    });

    return {
      ok: true,
      userId,
      hasBlob: exportResult.downloadUrl !== null,
      expiresAt: exportResult.expiresAt,
    };
  },
);
