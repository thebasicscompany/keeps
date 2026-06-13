"use server";

/**
 * app/settings/connectors/actions.ts
 *
 * Clerk-gated Next.js server actions that initiate a Composio OAuth connect
 * (or reconnect) flow for Slack or Google Calendar.
 *
 * Auth pattern: identical to app/settings/page.tsx — auth() from @clerk/nextjs/server
 * yields the Clerk user ID, which we join against user_identities to get the
 * INTERNAL Keeps user UUID (users.id). That UUID is what we pass to Composio
 * as userId/entity — NEVER the Clerk ID.
 *
 * Error model: MissingComposioConfigError is caught in the pure core and
 * surfaced as { error: 'not_configured' } rather than leaking a 500.
 * Unauthenticated callers receive { error: 'unauthenticated' }.
 *
 * Audit note: no audit_log row is written on initiate. The connector lifecycle
 * audit (action 'connector.account_connected') is written by the C2 webhook
 * handler when Composio confirms the OAuth dance completed successfully.
 */

import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { getEnv } from "@/config/env";
import { createConnectSession, type KeepsProvider } from "@/connectors/composio";
import {
  connectFlow,
  reconnectFlow,
  type ConnectFlowResult,
} from "@/connectors/connect-flow";

// ---------------------------------------------------------------------------
// Shared user resolver — Clerk user ID → internal users.id UUID
//
// Mirrors the join in app/settings/page.tsx exactly:
//   SELECT ui.user_id
//   FROM user_identities ui
//   WHERE ui.provider = 'clerk' AND ui.provider_account_id = $clerkUserId
// ---------------------------------------------------------------------------

async function resolveInternalUserId(
  clerkUserId: string,
): Promise<string | null> {
  const db = getDb();
  const [identity] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  return identity?.userId ?? null;
}

// ---------------------------------------------------------------------------
// startConnectorConnect — initiate OAuth for a given provider
// ---------------------------------------------------------------------------

/**
 * Server action: starts a Composio OAuth connect flow for Slack or Google
 * Calendar and returns the redirect URL the browser should navigate to.
 *
 * Returns a typed result object (never throws to the client):
 *   - { ok: true, redirectUrl, connectedAccountId } — success
 *   - { ok: false, error: 'unauthenticated' } — no Clerk session
 *   - { ok: false, error: 'user_not_found' } — no Keeps identity row
 *   - { ok: false, error: 'not_configured' } — missing Composio env var
 *
 * The UI (D3 — page.tsx) calls this and redirects the browser:
 *   const result = await startConnectorConnect('slack');
 *   if (result.ok) window.location.href = result.redirectUrl;
 */
export async function startConnectorConnect(
  provider: KeepsProvider,
): Promise<ConnectFlowResult> {
  const { userId: clerkUserId } = await auth();

  const env = getEnv();
  const callbackUrl = `${env.NEXT_PUBLIC_APP_URL}/settings/connectors?connected=${provider}`;

  return connectFlow({
    clerkUserId,
    provider,
    callbackUrl,
    resolveUser: resolveInternalUserId,
    createSession: createConnectSession,
  });
}

// ---------------------------------------------------------------------------
// startConnectorReconnect — V0: same OAuth flow, explicit UI semantic
// ---------------------------------------------------------------------------

/**
 * Server action: re-initiates the Composio OAuth flow for a provider whose
 * connection has been revoked or expired.
 *
 * V0: identical underlying flow to startConnectorConnect — Composio creates a
 * fresh connected account, and the C2 webhook handler reconciles the
 * connector_accounts row (upserts with the new composio_connected_account_id
 * and flips status back to active). Exported separately so the UI can present
 * "Reconnect" semantics even though the OAuth dance is the same.
 */
export async function startConnectorReconnect(
  provider: KeepsProvider,
): Promise<ConnectFlowResult> {
  const { userId: clerkUserId } = await auth();

  const env = getEnv();
  const callbackUrl = `${env.NEXT_PUBLIC_APP_URL}/settings/connectors?connected=${provider}`;

  return reconnectFlow({
    clerkUserId,
    provider,
    callbackUrl,
    resolveUser: resolveInternalUserId,
    createSession: createConnectSession,
  });
}
