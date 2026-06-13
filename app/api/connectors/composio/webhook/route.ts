/**
 * Composio connection-lifecycle webhook.
 *
 * POST handler:
 *   1. Read the RAW body via req.text() BEFORE parsing — the signature is over
 *      the exact bytes (see verifyComposioWebhookSignature).
 *   2. Verify the Svix-style signature; reject 401 on failure.
 *   3. Parse the `composio.connected_account.*` event DEFENSIVELY and dispatch
 *      through the pure `handleComposioWebhookEvent` core.
 *   4. Return 200 within 5s. We DEFER all Composio API calls (email/label fetch)
 *      to the hydration step — never call Composio inside the webhook.
 *
 * Failure philosophy: a thrown 500 makes Composio retry the delivery forever. So
 * anything short of a signature failure (an unrecognized payload shape, a
 * missing field) logs and returns 200. Only a genuinely invalid signature is 401.
 *
 * The webhook is the FAST path for connection lifecycle. The status-poll sweep
 * (sweep-connector-status) is the GUARANTEE — Composio's revoked/expired push is
 * best-effort (RESEARCH-COMPOSIO.md Q6), so the sweep reconciles whatever the
 * webhook misses.
 */

import { NextResponse } from "next/server";
import { verifyComposioWebhookSignature } from "@/connectors/composio";
import { sendEvent } from "@/workflows/events";
import {
  DrizzleConnectorAccountsRepository,
  mapComposioStatus,
  type ConnectorAccountsRepository,
  type ConnectorProvider,
} from "@/connectors/accounts-repository";
import {
  DrizzleConnectorAuditWriter,
  type ConnectorAuditWriter,
  type EmitEvent,
} from "@/connectors/audit";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Defensive payload parsing.
// ---------------------------------------------------------------------------

/** The Composio toolkit slug → Keeps provider key (RESEARCH-COMPOSIO.md Q6). */
export function providerFromToolkitSlug(slug: string | undefined): ConnectorProvider | null {
  if (!slug) return null;
  const normalized = slug.toLowerCase();
  if (normalized === "slack") return "slack";
  if (normalized === "googlecalendar" || normalized === "google_calendar") {
    return "google_calendar";
  }
  return null;
}

export interface ParsedWebhookEvent {
  /** Raw event type string, e.g. "composio.connected_account.expired". */
  type: string;
  /** The trailing segment of the type, e.g. "expired" / "active". */
  action: string;
  composioConnectedAccountId: string;
  composioEntityId: string;
  provider: ConnectorProvider;
  /** Composio status string when present in the payload, else null. */
  composioStatus: string | null;
  statusReason: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return null;
}

/**
 * Pulls the fields we need out of the (not fully pinned) v3 payload shape:
 *   { type: "composio.connected_account.<...>", data: {...}, metadata: {...} }
 *
 * The exact field names for connectedAccountId / userId / toolkit inside `data`
 * are NOT 100% confirmed (RESEARCH Q6) — we read several plausible aliases and
 * return null if we can't find the essentials. Returning null → log + 200.
 */
export function parseComposioWebhook(payload: unknown): ParsedWebhookEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  const type = asString(root.type);
  if (!type || !type.startsWith("composio.connected_account.")) return null;
  const action = type.slice("composio.connected_account.".length);

  const data = (root.data ?? {}) as Record<string, unknown>;
  const metadata = (root.metadata ?? {}) as Record<string, unknown>;

  // connected-account id: ca_… — try the obvious aliases.
  const composioConnectedAccountId = firstString(
    data.connectedAccountId,
    data.connected_account_id,
    data.id,
    data.nanoId,
    data.nano_id,
    data.connectionId,
    data.connection_id,
  );
  if (!composioConnectedAccountId) return null;

  // userId / entity (the Keeps user UUID we sent as Composio userId).
  const composioEntityId = firstString(
    data.userId,
    data.user_id,
    data.entityId,
    data.entity_id,
  );
  if (!composioEntityId) return null;

  // toolkit slug — may live at data.toolkit.slug, data.toolkitSlug, or metadata.
  const toolkitObj = (data.toolkit ?? {}) as Record<string, unknown>;
  const toolkitSlug = firstString(
    toolkitObj.slug,
    data.toolkitSlug,
    data.toolkit_slug,
    data.appName,
    data.app_name,
    metadata.toolkitSlug,
    metadata.toolkit_slug,
    typeof data.toolkit === "string" ? data.toolkit : undefined,
  );
  const provider = providerFromToolkitSlug(toolkitSlug ?? undefined);
  if (!provider) return null;

  const composioStatus = firstString(data.status, data.connectionStatus, data.connection_status);
  const statusReason = firstString(data.statusReason, data.status_reason, data.reason);

  return {
    type,
    action,
    composioConnectedAccountId,
    composioEntityId,
    provider,
    composioStatus,
    statusReason,
  };
}

/**
 * Decides whether an event represents a healthy connection (→ active/upsert +
 * connector.connected) or a loss of access (→ markStatus + connector.revoked).
 *
 * Connected-ish actions: created / active / connected / updated (if status ACTIVE).
 * Lost-access actions: expired / revoked / deleted / failed / disabled / inactive.
 *
 * When the payload carries an explicit status string we trust mapComposioStatus
 * (single source of truth); otherwise we infer from the action verb.
 */
export type LifecycleOutcome =
  | { kind: "connected"; status: "active" }
  | { kind: "revoked"; status: "revoked" | "auth_error" | "disabled" }
  | { kind: "ignore" };

export function classifyLifecycle(event: ParsedWebhookEvent): LifecycleOutcome {
  // Trust an explicit status string when present.
  if (event.composioStatus) {
    const mapped = mapComposioStatus(event.composioStatus);
    if (mapped === "active") return { kind: "connected", status: "active" };
    return { kind: "revoked", status: mapped };
  }

  const action = event.action.toLowerCase();
  switch (action) {
    case "created":
    case "active":
    case "connected":
      return { kind: "connected", status: "active" };
    case "revoked":
      return { kind: "revoked", status: "revoked" };
    case "expired":
    case "failed":
    case "inactive":
      return { kind: "revoked", status: "auth_error" };
    case "deleted":
    case "disabled":
      return { kind: "revoked", status: "disabled" };
    default:
      // Unknown verb without a status → don't guess; ignore (still 200).
      return { kind: "ignore" };
  }
}

// ---------------------------------------------------------------------------
// Pure core — dispatch a parsed event. No req/res, no Composio API calls.
// ---------------------------------------------------------------------------

export type WebhookDispatchResult =
  | { handled: "connected"; connectorAccountId: string }
  | { handled: "revoked"; connectorAccountId: string; status: string }
  | { handled: "ignored"; reason: string };

export async function handleComposioWebhookEvent(input: {
  event: ParsedWebhookEvent;
  accountsRepo: ConnectorAccountsRepository;
  emitEvent: EmitEvent;
  audit: ConnectorAuditWriter;
  now: Date;
}): Promise<WebhookDispatchResult> {
  const { event, accountsRepo, emitEvent, audit, now } = input;

  const outcome = classifyLifecycle(event);
  if (outcome.kind === "ignore") {
    return { handled: "ignored", reason: `no actionable status for type=${event.type}` };
  }

  if (outcome.kind === "connected") {
    const row = await accountsRepo.upsertByComposioAccount({
      composioConnectedAccountId: event.composioConnectedAccountId,
      composioEntityId: event.composioEntityId,
      userId: event.composioEntityId,
      provider: event.provider,
      status: "active",
      statusReason: event.statusReason,
      now,
    });

    // Hydration (a deferred Inngest step) fills externalAccountEmail; null here.
    await emitEvent("connector.connected", {
      userId: row.userId,
      provider: event.provider,
      connectorAccountId: row.id,
      externalAccountEmail: null,
    });

    await audit.writeAudit({
      action: "connector.account_connected",
      userId: row.userId,
      metadata: {
        connectorAccountId: row.id,
        provider: event.provider,
        composioConnectedAccountId: event.composioConnectedAccountId,
        eventType: event.type,
      },
    });

    return { handled: "connected", connectorAccountId: row.id };
  }

  // outcome.kind === "revoked" — covers revoked / auth_error / disabled.
  const row = await accountsRepo.markStatus({
    composioConnectedAccountId: event.composioConnectedAccountId,
    status: outcome.status,
    statusReason: event.statusReason,
    disconnectedAt: now,
    now,
  });

  // The account may not exist locally yet (webhook arrived before any connect we
  // recorded). Still emit/audit with the composio id so the signal isn't lost.
  const connectorAccountId = row?.id ?? event.composioConnectedAccountId;
  const userId = row?.userId ?? event.composioEntityId;
  const reason = event.statusReason ?? event.type;

  await emitEvent("connector.revoked", {
    userId,
    provider: event.provider,
    connectorAccountId,
    reason,
  });

  await audit.writeAudit({
    action:
      outcome.status === "revoked"
        ? "connector.account_revoked"
        : "connector.account_auth_error",
    userId,
    metadata: {
      connectorAccountId,
      provider: event.provider,
      composioConnectedAccountId: event.composioConnectedAccountId,
      eventType: event.type,
      status: outcome.status,
      reason,
    },
  });

  return { handled: "revoked", connectorAccountId, status: outcome.status };
}

// ---------------------------------------------------------------------------
// Route handler.
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // 1. RAW body first — signature is over the exact bytes.
  const rawBody = await req.text();

  const headers = {
    "webhook-id": req.headers.get("webhook-id"),
    "webhook-timestamp": req.headers.get("webhook-timestamp"),
    "webhook-signature": req.headers.get("webhook-signature"),
  };

  // 2. Verify signature. 401 on failure — Composio will NOT retry a 401.
  const verification = verifyComposioWebhookSignature({ payload: rawBody, headers });
  if (!verification.valid) {
    console.warn(`[composio-webhook] rejected: ${verification.reason}`);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // 3. Parse defensively. Any unrecognized shape → log + 200 (never 500: a 500
  // makes Composio retry forever).
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    console.warn("[composio-webhook] body is not valid JSON; acking 200");
    return NextResponse.json({ ok: true, ignored: "invalid json" });
  }

  const event = parseComposioWebhook(parsedBody);
  if (!event) {
    console.warn("[composio-webhook] unrecognized payload shape; acking 200");
    return NextResponse.json({ ok: true, ignored: "unrecognized shape" });
  }

  try {
    const result = await handleComposioWebhookEvent({
      event,
      accountsRepo: new DrizzleConnectorAccountsRepository(),
      emitEvent: sendEvent,
      audit: new DrizzleConnectorAuditWriter(),
      now: new Date(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Even on an internal error we 200 — re-delivery would just re-run the same
    // failing path. The sweep is the safety net for any state we failed to write.
    console.error("[composio-webhook] handler error; acking 200 to stop retries", err);
    return NextResponse.json({ ok: true, ignored: "handler error" });
  }
}
