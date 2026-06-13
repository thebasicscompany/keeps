/**
 * src/connectors/connect-flow.ts
 *
 * Pure core for the Composio connect/reconnect flow.
 *
 * This module contains no server-action scaffolding ("use server") and takes
 * all I/O as injected dependencies so it can be tested without Clerk, a real
 * database, or a live Composio account.
 *
 * The thin server-action bindings live in app/settings/connectors/actions.ts
 * and call connectFlow() / reconnectFlow() after resolving Clerk → internal
 * user via the exact same join the settings page uses.
 */

import type { KeepsProvider } from "@/connectors/composio";
import { MissingComposioConfigError } from "@/connectors/composio";

// ---------------------------------------------------------------------------
// Dependency interfaces (injected for testability)
// ---------------------------------------------------------------------------

/**
 * Subset of what createConnectSession from src/connectors/composio.ts returns.
 * Matches ConnectSessionResult.
 */
export interface ConnectSessionResult {
  redirectUrl: string;
  connectedAccountId: string;
}

/**
 * Injected session factory — in production this is createConnectSession from
 * src/connectors/composio.ts; in tests it's a fake.
 */
export type CreateConnectSessionFn = (params: {
  userId: string;
  provider: KeepsProvider;
  callbackUrl?: string;
}) => Promise<ConnectSessionResult>;

/**
 * Injected user resolver. Given a Clerk user ID, returns the internal Keeps
 * user UUID (users.id) or null when the identity row does not exist.
 *
 * In production this queries user_identities via Drizzle (same join as the
 * settings page). In tests it's an in-memory map.
 */
export type ResolveUserFn = (clerkUserId: string) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

/**
 * Successful outcome: the browser must navigate to redirectUrl.
 * connectedAccountId should be persisted to connector_accounts once the OAuth
 * completes (handled by the C2 webhook handler).
 */
export interface ConnectFlowSuccess {
  ok: true;
  redirectUrl: string;
  connectedAccountId: string;
}

/** Typed error outcomes — never thrown; always returned so callers can branch. */
export type ConnectFlowError =
  | { ok: false; error: "unauthenticated" }
  | { ok: false; error: "user_not_found" }
  | { ok: false; error: "not_configured"; detail?: string };

export type ConnectFlowResult = ConnectFlowSuccess | ConnectFlowError;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ConnectFlowInput {
  /** Clerk user ID obtained from auth(). Null/undefined → unauthenticated. */
  clerkUserId: string | null | undefined;
  /** Which provider to connect. */
  provider: KeepsProvider;
  /**
   * The full callback URL Composio will redirect to after OAuth.
   * Typically `${NEXT_PUBLIC_APP_URL}/settings/connectors?connected=<provider>`.
   */
  callbackUrl: string;
  /** Injected user resolver (production: DB join; test: in-memory map). */
  resolveUser: ResolveUserFn;
  /** Injected Composio session factory (production: createConnectSession; test: fake). */
  createSession: CreateConnectSessionFn;
}

// ---------------------------------------------------------------------------
// connectFlow — the pure core
// ---------------------------------------------------------------------------

/**
 * Initiates a Composio OAuth connect flow for the given Keeps user.
 *
 * Flow:
 *  1. Guard: clerkUserId must be present (caller obtained it from Clerk auth()).
 *  2. Resolve the internal Keeps user UUID from the clerk identity row
 *     (user_identities WHERE provider='clerk' AND provider_account_id=clerkUserId).
 *  3. Call createConnectSession with the INTERNAL UUID as userId (never the Clerk id).
 *  4. Return { ok: true, redirectUrl, connectedAccountId }.
 *
 * MissingComposioConfigError (missing auth-config env var) is caught and
 * surfaced as { ok: false, error: 'not_configured' } to avoid a raw 500.
 *
 * Audit note: no audit_log row is written on initiate. The lifecycle audit
 * (connector.account_connected) is written by the C2 webhook handler when
 * Composio confirms the OAuth completed successfully.
 */
export async function connectFlow(
  input: ConnectFlowInput,
): Promise<ConnectFlowResult> {
  const { clerkUserId, provider, callbackUrl, resolveUser, createSession } =
    input;

  // 1. Authentication guard
  if (!clerkUserId) {
    return { ok: false, error: "unauthenticated" };
  }

  // 2. Resolve Clerk → internal user UUID
  const internalUserId = await resolveUser(clerkUserId);
  if (!internalUserId) {
    // The user is authenticated with Clerk but has no Keeps identity row yet.
    // This can happen briefly during onboarding; treat as not found.
    return { ok: false, error: "user_not_found" };
  }

  // 3. Initiate the Composio connect flow
  try {
    const session = await createSession({
      userId: internalUserId, // MUST be the internal UUID, never the Clerk id
      provider,
      callbackUrl,
    });

    return {
      ok: true,
      redirectUrl: session.redirectUrl,
      connectedAccountId: session.connectedAccountId,
    };
  } catch (err) {
    if (err instanceof MissingComposioConfigError) {
      return {
        ok: false,
        error: "not_configured",
        detail: err.message,
      };
    }
    // Re-throw unexpected errors (network, 4xx from Composio, etc.) so the
    // server action boundary can handle them as 500-level failures.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// reconnectFlow — V0: same as connectFlow (fresh OAuth, webhook reconciles)
// ---------------------------------------------------------------------------

/**
 * Initiates a Composio reconnect flow for a provider whose connection has
 * been revoked or expired.
 *
 * V0 implementation: identical to connectFlow — Composio creates a fresh
 * connected account and the C2 webhook handler reconciles the connector_accounts
 * row (updating composio_connected_account_id, flipping status back to active).
 * A dedicated "reconnect" Composio API (re-using an existing ca_…) is not
 * available on the current SDK; this approach is correct for V0.
 *
 * The function is exported separately so the UI can show distinct semantics
 * ("Reconnect" vs "Connect") even though the underlying flow is the same.
 */
export async function reconnectFlow(
  input: ConnectFlowInput,
): Promise<ConnectFlowResult> {
  // V0: same flow as connectFlow. The webhook/hydration step (C2/C3) will
  // upsert the connector_accounts row, reconciling any previous ca_… id.
  return connectFlow(input);
}
