/**
 * Approval action handlers for CONNECTOR kinds (Wave D — approve→execute hop).
 *
 * When an automation escalates an externally-visible action (SR8), it creates a normal approval
 * whose draft carries { actionKind: 'send_slack_message', payload: <intended target> }. The
 * existing handle-approval workflow sends the approval email, waits for the decision, and on
 * approval routes through executeApprovedDraft → getAction(kind) → THESE handlers. So the whole
 * approve→execute loop reuses the shipped approval machinery; only the per-kind execution lives here.
 *
 * V0 supports the SAFE self-DM: the message goes to the user's OWN Slack (resolved from their
 * connected account's email), never a third party. The executor only ever escalates self-targeted
 * Slack actions, so a hostile payload cannot redirect the send.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts } from "@/db/schema";
import { resolveRecipient } from "@/connectors/recipient";
import { executeConnectorPayload } from "@/connectors/action-registry";
import type { ConnectorActionPayload } from "@/agent/schemas";

type SlackDraftPayload = {
  message?: unknown;
  destination?: { kind?: unknown };
};

/** Load the user's active Slack connector account (id + own email for self-resolution). */
async function loadSlackAccount(
  userId: string,
): Promise<{ connectedAccountId: string; ownEmail: string | null } | null> {
  const [row] = await getDb()
    .select({
      connectedAccountId: connectorAccounts.composioConnectedAccountId,
      ownEmail: connectorAccounts.externalAccountEmail,
    })
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, userId),
        eq(connectorAccounts.provider, "slack"),
        eq(connectorAccounts.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Execute an approved self-DM Slack message. Resolves the user's OWN Slack id from their
 * connected account email (reusing the tested resolveRecipient lookup), then sends. Returns a
 * non-secret detail; throws only on a hard failure so the approval workflow records it.
 */
export async function sendSlackMessageHandler(input: {
  draft: { userId: string; payload: unknown };
  approval: { userId: string };
}): Promise<{ ok: true; detail?: unknown }> {
  const userId = input.approval.userId;
  const payload = (input.draft.payload ?? {}) as SlackDraftPayload;
  const message = typeof payload.message === "string" ? payload.message : null;
  if (!message) return { ok: true, detail: { sent: false, reason: "empty message" } };

  const account = await loadSlackAccount(userId);
  if (!account) return { ok: true, detail: { sent: false, reason: "no connected Slack account" } };
  if (!account.ownEmail) {
    return { ok: true, detail: { sent: false, reason: "Slack account has no email to resolve self-DM" } };
  }

  // Resolve the user's own Slack id (self-DM target).
  const resolved = await resolveRecipient(
    { provider: "slack", nameText: null, emailText: account.ownEmail },
    { keepsUserId: userId, connectedAccountId: account.connectedAccountId },
  );
  if (resolved.status !== "resolved") {
    return { ok: true, detail: { sent: false, reason: `could not resolve your Slack account (${resolved.status})` } };
  }

  const slackPayload: ConnectorActionPayload = {
    kind: "slack_dm",
    destination: { kind: "self", nameText: null, emailText: null },
    message,
    channel: resolved.destination,
    recipientName: resolved.name,
    recipientEmail: resolved.email,
  };

  const result = await executeConnectorPayload({
    payload: slackPayload,
    keepsUserId: userId,
    connectedAccountId: account.connectedAccountId,
    user: { timezone: null },
  });
  return { ok: true, detail: { sent: true, slack: result as unknown as Record<string, unknown> } };
}
