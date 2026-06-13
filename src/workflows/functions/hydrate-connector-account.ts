/**
 * hydrate-connector-account — Inngest function triggered by `connector.connected`.
 *
 * The webhook acks within 5s and DEFERS all Composio API calls here. This step:
 *   1. getConnectedAccount(composioConnectedAccountId) — one Composio API call.
 *   2. Extracts external_account_email, label, requested scopes, and a small
 *      provider-specific metadata bag (workspace_id for slack / primary_calendar_id
 *      for google_calendar) from the (loosely-typed) connected-account detail.
 *   3. accountsRepo.hydrate(...) — idempotent on connector_account_id.
 *
 * Idempotent: re-running just re-writes the same fields. `now` is minted in step 1
 * so it is memoized across re-executions (Inngest determinism).
 */

import { getConnectedAccount } from "@/connectors/composio";
import type { ConnectedAccountRetrieveResponse } from "@composio/core";
import {
  DrizzleConnectorAccountsRepository,
  type ConnectorAccountsRepository,
  type ConnectorProvider,
} from "@/connectors/accounts-repository";
import { inngest } from "@/workflows/client";

// ---------------------------------------------------------------------------
// Field extraction — pure, defensive (the detail shape is loosely typed).
// ---------------------------------------------------------------------------

export interface ExtractedAccountFields {
  externalAccountEmail: string | null;
  externalAccountLabel: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
}

function pickString(obj: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Extracts hydration fields from a Composio connected-account detail.
 *
 * The retrieve response (verified against @composio/core 0.10.0
 * ConnectedAccountRetrieveResponseSchema) exposes `status`, `statusReason`,
 * `toolkit.slug`, `isDisabled`, plus loosely-typed `state` / deprecated `data` /
 * `experimental` bags where the upstream account email, label, and granted scopes
 * actually live. We read several plausible aliases and fall back to null/[]/{}.
 * The exact nesting is confirmed at integration time (RESEARCH-COMPOSIO.md Q4 /
 * open item #3) — this reader is intentionally forgiving so it never throws.
 */
export function extractAccountFields(
  detail: ConnectedAccountRetrieveResponse,
  provider: ConnectorProvider,
): ExtractedAccountFields {
  const anyDetail = detail as unknown as Record<string, unknown>;
  const state = asRecord(anyDetail.state);
  const data = asRecord(anyDetail.data);
  const params = asRecord(anyDetail.params);
  const experimental = asRecord(anyDetail.experimental);
  // val bags Composio uses for connection-data fields across SDK versions.
  const bags = [state, data, params, experimental].filter(Boolean) as Record<
    string,
    unknown
  >[];
  // Some SDKs nest the OAuth profile under state.val / data.val.
  for (const bag of [state, data]) {
    const val = asRecord(bag?.val);
    if (val) bags.push(val);
  }

  const externalAccountEmail =
    bags.reduce<string | null>(
      (acc, bag) =>
        acc ??
        pickString(
          bag,
          "external_account_email",
          "email",
          "user_email",
          "account_email",
          "authedUserEmail",
        ),
      null,
    ) ?? null;

  const externalAccountLabel =
    bags.reduce<string | null>(
      (acc, bag) =>
        acc ??
        pickString(
          bag,
          "external_account_label",
          "label",
          "team_name",
          "workspace_name",
          "account_label",
          "name",
          "display_name",
        ),
      null,
    ) ?? null;

  // Requested scopes — try the connected-account detail and the bags.
  const scopesRaw =
    extractScopes(anyDetail) ?? bags.map(extractScopes).find(Boolean) ?? [];
  const scopes = Array.isArray(scopesRaw) ? scopesRaw.map(String) : [];

  // Provider-specific metadata.
  const metadata: Record<string, unknown> = {};
  if (provider === "slack") {
    const workspaceId =
      bags.reduce<string | null>(
        (acc, bag) =>
          acc ?? pickString(bag, "workspace_id", "team_id", "teamId", "workspaceId"),
        null,
      ) ?? null;
    if (workspaceId) metadata.workspace_id = workspaceId;
  } else {
    const primaryCalendarId =
      bags.reduce<string | null>(
        (acc, bag) =>
          acc ??
          pickString(
            bag,
            "primary_calendar_id",
            "primaryCalendarId",
            "calendar_id",
            "calendarId",
          ),
        null,
      ) ?? null;
    if (primaryCalendarId) metadata.primary_calendar_id = primaryCalendarId;
  }

  return { externalAccountEmail, externalAccountLabel, scopes, metadata };
}

function extractScopes(obj: Record<string, unknown> | undefined): string[] | null {
  if (!obj) return null;
  for (const key of ["requested_scopes", "requestedScopes", "scopes", "scope"]) {
    const v = obj[key];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string" && v.length > 0) {
      // space- or comma-delimited scope strings.
      return v.split(/[\s,]+/).filter(Boolean);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure core — fetch detail, extract, hydrate. Testable with injected fakes.
// ---------------------------------------------------------------------------

export type HydrateResult =
  | { status: "hydrated"; connectorAccountId: string }
  | { status: "not_found"; connectorAccountId: string };

export async function hydrateConnectorAccount(input: {
  connectorAccountId: string;
  composioConnectedAccountId: string;
  provider: ConnectorProvider;
  accountsRepo: ConnectorAccountsRepository;
  fetchConnectedAccount: (id: string) => Promise<ConnectedAccountRetrieveResponse>;
  now: Date;
}): Promise<HydrateResult> {
  const detail = await input.fetchConnectedAccount(input.composioConnectedAccountId);
  const fields = extractAccountFields(detail, input.provider);

  const row = await input.accountsRepo.hydrate({
    id: input.connectorAccountId,
    externalAccountEmail: fields.externalAccountEmail,
    externalAccountLabel: fields.externalAccountLabel,
    scopes: fields.scopes,
    metadata: fields.metadata,
    now: input.now,
  });

  if (!row) {
    return { status: "not_found", connectorAccountId: input.connectorAccountId };
  }
  return { status: "hydrated", connectorAccountId: input.connectorAccountId };
}

// ---------------------------------------------------------------------------
// Inngest wrapper.
// ---------------------------------------------------------------------------

export const hydrateConnectorAccountFunction = inngest.createFunction(
  {
    id: "hydrate-connector-account",
    triggers: { event: "connector.connected" },
    // Re-deliveries of the same connect event re-hydrate the same row — cheap and
    // idempotent, but keyed so a duplicate event doesn't spawn parallel fetches.
    idempotency: "event.data.connectorAccountId",
  },
  async ({ event, step }) => {
    const connectorAccountId = event.data.connectorAccountId as string;
    const provider = event.data.provider as ConnectorProvider;

    const result = await step.run("hydrate", async () => {
      const now = new Date();
      const accountsRepo = new DrizzleConnectorAccountsRepository();

      // The event carries the LOCAL connector_account id. We need the composio id
      // to call getConnectedAccount, so resolve the row by its local id first.
      const account = await accountsRepo.findById(connectorAccountId);
      if (!account) {
        return { status: "not_found" as const, connectorAccountId };
      }

      return hydrateConnectorAccount({
        connectorAccountId: account.id,
        composioConnectedAccountId: account.composioConnectedAccountId,
        provider,
        accountsRepo,
        fetchConnectedAccount: getConnectedAccount,
        now,
      });
    });

    console.log(
      `[hydrate-connector-account] account=${connectorAccountId} status=${result.status}`,
    );

    return { ok: true, ...result };
  },
);
