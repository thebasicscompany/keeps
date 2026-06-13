/**
 * reconcile-connector-accounts — pull Composio as the source of truth.
 *
 * Problem: connector_accounts rows are normally created by the Composio webhook
 * (best-effort, requires dashboard config). A user who completes OAuth can show
 * "not connected" on the settings page until a manual backfill is run.
 *
 * Solution: at connect-time and settings-load time, reconcile against Composio.
 *   1. listConnectedAccounts(userId) — the authoritative list.
 *   2. Filter to ACTIVE only (or to a specific provider's toolkit slug).
 *   3. For each ACTIVE account: fetch detail, extract email/label/scopes/metadata,
 *      upsertByComposioAccount — creating the row if absent, refreshing if stale.
 *
 * Design:
 *   - Pure injectable core: `client` / `fetchDetail` / `accountsRepo` are seams
 *     for tests. No network calls reach tests.
 *   - Defensive: an error on a single account is logged+skipped, not fatal.
 *   - Idempotent: running twice keeps exactly one row per (user, provider).
 *
 * Wire-up points:
 *   - handle-connector-command.ts step (a): when findActive returns null, call
 *     reconcile BEFORE sending the connect-link email (self-heal).
 *   - app/settings/connectors/page.tsx: call best-effort before reading DB rows
 *     (reflect truth on page load).
 */

import {
  listConnectedAccounts,
  getConnectedAccount,
  PROVIDER_TO_TOOLKIT,
  type KeepsProvider,
} from "@/connectors/composio";
import type { ConnectedAccountListResponse, ConnectedAccountRetrieveResponse } from "@composio/core";
import {
  DrizzleConnectorAccountsRepository,
  mapComposioStatus,
  type ConnectorAccountsRepository,
  type ConnectorProvider,
} from "@/connectors/accounts-repository";
import { extractAccountFields } from "@/workflows/functions/hydrate-connector-account";
import type { ConnectorAccount } from "@/db/schema";

// ---------------------------------------------------------------------------
// Reverse toolkit-slug → Keeps-provider lookup
// ---------------------------------------------------------------------------

/** Maps Composio toolkit slugs back to the Keeps-internal provider name. */
const TOOLKIT_TO_PROVIDER: Record<string, KeepsProvider> = Object.fromEntries(
  Object.entries(PROVIDER_TO_TOOLKIT).map(([provider, slug]) => [slug, provider as KeepsProvider]),
) as Record<string, KeepsProvider>;

// ---------------------------------------------------------------------------
// Injectable seams (for tests — no network in tests)
// ---------------------------------------------------------------------------

/** Minimal Composio-client-shaped seam for list calls. Injectable for tests. */
export interface ReconcileComposioClient {
  listConnectedAccounts(params: { userId: string }): Promise<ConnectedAccountListResponse>;
}

/** Fetch detail for a single account. Injectable for tests. */
export type FetchAccountDetail = (id: string) => Promise<ConnectedAccountRetrieveResponse>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReconcileConnectorAccountsInput {
  /** Keeps internal user UUID (= Composio entity ID). */
  userId: string;
  /**
   * If provided, only reconcile accounts for this specific provider.
   * Translates to the Composio toolkit slug for list filtering.
   */
  provider?: ConnectorProvider;
  /** Injectable repo — defaults to the real Drizzle implementation. */
  accountsRepo?: ConnectorAccountsRepository;
  /** Injectable Composio client seam — defaults to the real network client. */
  client?: ReconcileComposioClient;
  /**
   * Injectable per-account detail fetcher — defaults to the real
   * getConnectedAccount. Only called when `client` is also the default,
   * but injectable independently so tests can override just the detail call.
   */
  fetchDetail?: FetchAccountDetail;
}

/**
 * Reconciles Keeps' connector_accounts table against Composio's live list.
 *
 * For each ACTIVE Composio account (optionally filtered by provider):
 *   - Fetches the account detail (getConnectedAccount) to extract email/label/scopes/metadata.
 *   - Calls upsertByComposioAccount, creating the row if missing, refreshing if stale.
 *
 * Returns the upserted ConnectorAccount rows. Idempotent.
 * Per-account errors are logged and skipped — never fatal.
 */
export async function reconcileConnectorAccounts(
  input: ReconcileConnectorAccountsInput,
): Promise<ConnectorAccount[]> {
  const { userId, provider } = input;

  // Resolve injectable deps.
  const accountsRepo = input.accountsRepo ?? new DrizzleConnectorAccountsRepository();
  const fetchDetail: FetchAccountDetail = input.fetchDetail ?? getConnectedAccount;
  const composioClient: ReconcileComposioClient = input.client ?? {
    listConnectedAccounts,
  };

  // 1. Fetch the user's connected accounts from Composio.
  let listResponse: ConnectedAccountListResponse;
  try {
    listResponse = await composioClient.listConnectedAccounts({ userId });
  } catch (err) {
    console.error("[reconcile-connector-accounts] listConnectedAccounts failed", {
      userId,
      provider,
      error: err,
    });
    return [];
  }

  // 2. Filter to ACTIVE, and optionally restrict to the requested provider's toolkit slug.
  const targetSlug = provider ? PROVIDER_TO_TOOLKIT[provider] : undefined;

  const activeItems = listResponse.items.filter((item) => {
    if (item.status !== "ACTIVE") return false;
    if (targetSlug && item.toolkit.slug !== targetSlug) return false;
    // Only process toolkit slugs that Keeps knows about.
    if (!TOOLKIT_TO_PROVIDER[item.toolkit.slug]) return false;
    return true;
  });

  // 3. For each active account: fetch detail, extract fields, upsert.
  const upserted: ConnectorAccount[] = [];

  for (const item of activeItems) {
    const keepsProv = TOOLKIT_TO_PROVIDER[item.toolkit.slug];
    if (!keepsProv) continue; // guarded above, defensive re-check

    try {
      // Fetch the full detail to extract email/label/scopes/metadata.
      const detail = await fetchDetail(item.id);

      const fields = extractAccountFields(detail, keepsProv);

      const row = await accountsRepo.upsertByComposioAccount({
        composioConnectedAccountId: item.id,
        composioEntityId: userId,
        userId,
        provider: keepsProv,
        status: mapComposioStatus(item.status),
        statusReason: item.statusReason ?? null,
        externalAccountEmail: fields.externalAccountEmail,
        externalAccountLabel: fields.externalAccountLabel,
        scopes: fields.scopes,
        metadata: fields.metadata,
      });

      upserted.push(row);
    } catch (err) {
      console.error("[reconcile-connector-accounts] failed to reconcile account", {
        userId,
        composioAccountId: item.id,
        toolkit: item.toolkit.slug,
        error: err,
      });
      // Defensive: skip this account, try the rest.
    }
  }

  return upserted;
}
