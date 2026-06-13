/**
 * sweep-connector-status — Inngest cron (every 15m, mirroring sweep-approval-expiry).
 *
 * This is the GUARANTEE behind the best-effort Composio webhook. Composio's
 * revoked/expired push is NOT delivered for every revocation path (a user
 * revoking Keeps directly at Slack/Google may never produce a webhook —
 * RESEARCH-COMPOSIO.md Q6). So every 15 minutes we poll each ACTIVE account's
 * real status and reconcile.
 *
 * Division of responsibility:
 *   - WEBHOOK = fast path. Reacts in seconds to a Composio push, flips status,
 *     emits connector.revoked. Does NOT call Composio (acks within 5s).
 *   - SWEEP   = safety net. Polls connectedAccounts.get(id).status for every
 *     account the webhook left ACTIVE. If the real status != ACTIVE it flips the
 *     row, emits connector.revoked, and sends ONE reconnect email to the owner.
 *
 * Discipline (mirrors handle-approval):
 *   - `now` minted once in the first step, threaded through (Inngest determinism).
 *   - Per-account work is its own keyed step so re-execution never re-sends.
 *   - The SEND-ONLY reconnect email is isolated from DB-write steps.
 *   - Injected `now`; AR-5: NO step.sleepUntil — cron + per-account steps only.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import type { ConnectorAccount } from "@/db/schema";
import { getEnv } from "@/config/env";
import { getConnectedAccount } from "@/connectors/composio";
import type { ConnectedAccountRetrieveResponse } from "@composio/core";
import { sendSystemEmail } from "@/email/system-send";
import { getEmailSender } from "@/email/sender-factory";
import { buildConnectorReconnectEmail } from "@/email/templates/connector-reconnect";
import {
  DrizzleConnectorAccountsRepository,
  mapComposioStatus,
  type ConnectorAccountsRepository,
  type ConnectorProvider,
  type ConnectorAccountStatus,
} from "@/connectors/accounts-repository";
import {
  DrizzleConnectorAuditWriter,
  type ConnectorAuditWriter,
  type EmitEvent,
} from "@/connectors/audit";
import { sendEvent } from "@/workflows/events";
import { inngest } from "@/workflows/client";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Resolves the OWNER's canonical email — the only address the reconnect email may reach. */
export interface OwnerEmailResolver {
  findOwnerEmail(userId: string): Promise<string | null>;
}

export class DrizzleOwnerEmailResolver implements OwnerEmailResolver {
  private readonly db = getDb();
  async findOwnerEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.email ?? null;
  }
}

/** SEND-ONLY system-notice port (no DB writes). Matches handle-approval's shape. */
export type SendSystemNotice = (notice: {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Builds the per-provider reconnect URL the owner taps to re-authorize. */
export function reconnectUrl(appUrl: string, provider: ConnectorProvider): string {
  return `${appUrl}/settings/connectors?connected=${provider}`;
}

/** The composio status reported, normalized to a string ("UNKNOWN" if absent). */
function statusOf(detail: ConnectedAccountRetrieveResponse): string {
  const s = (detail as unknown as { status?: unknown }).status;
  return typeof s === "string" ? s : "UNKNOWN";
}

function reasonOf(detail: ConnectedAccountRetrieveResponse): string | null {
  const r = (detail as unknown as { statusReason?: unknown }).statusReason;
  return typeof r === "string" && r.length > 0 ? r : null;
}

// ---------------------------------------------------------------------------
// Pure core — reconcile ONE account. Returns what it did (no I/O beyond ports).
// ---------------------------------------------------------------------------

export type ReconcileOneResult =
  | { outcome: "still_active" }
  | {
      outcome: "flipped";
      newStatus: ConnectorAccountStatus;
      emailed: boolean;
    }
  | { outcome: "error" };

/**
 * Polls one account's real Composio status. If still ACTIVE → no-op. If not →
 * markStatus, emit connector.revoked, audit, and send ONE reconnect email to the
 * owner. Transport errors are swallowed into `{ outcome: "error" }` so one bad
 * account never aborts the sweep.
 */
export async function reconcileConnectorAccount(input: {
  account: Pick<
    ConnectorAccount,
    "id" | "userId" | "provider" | "composioConnectedAccountId"
  >;
  accountsRepo: ConnectorAccountsRepository;
  ownerResolver: OwnerEmailResolver;
  emitEvent: EmitEvent;
  audit: ConnectorAuditWriter;
  sendSystemNotice: SendSystemNotice;
  fetchConnectedAccount: (id: string) => Promise<ConnectedAccountRetrieveResponse>;
  appUrl: string;
  now: Date;
}): Promise<ReconcileOneResult> {
  const { account } = input;
  const provider = account.provider as ConnectorProvider;

  let detail: ConnectedAccountRetrieveResponse;
  try {
    detail = await input.fetchConnectedAccount(account.composioConnectedAccountId);
  } catch (err) {
    console.error(
      `[sweep-connector-status] fetch failed for ${account.composioConnectedAccountId}`,
      err,
    );
    return { outcome: "error" };
  }

  const composioStatus = statusOf(detail);
  if (composioStatus === "ACTIVE") {
    return { outcome: "still_active" };
  }

  const newStatus = mapComposioStatus(composioStatus);
  const reason = reasonOf(detail) ?? `Composio status ${composioStatus}`;

  // ── DB write: flip the row.
  await input.accountsRepo.markStatus({
    id: account.id,
    status: newStatus,
    statusReason: reason,
    disconnectedAt: input.now,
    now: input.now,
  });

  // ── Emit + audit (no external send).
  await input.emitEvent("connector.revoked", {
    userId: account.userId,
    provider,
    connectorAccountId: account.id,
    reason,
  });

  await input.audit.writeAudit({
    action:
      newStatus === "revoked"
        ? "connector.account_revoked"
        : "connector.account_auth_error",
    userId: account.userId,
    metadata: {
      connectorAccountId: account.id,
      provider,
      composioConnectedAccountId: account.composioConnectedAccountId,
      status: newStatus,
      reason,
      source: "sweep",
    },
  });

  // ── SEND-ONLY: one reconnect email to the owner address only.
  const ownerEmail = await input.ownerResolver.findOwnerEmail(account.userId);
  let emailed = false;
  if (ownerEmail) {
    const { subject, textBody, html } = buildConnectorReconnectEmail({
      provider,
      reason,
      reconnectUrl: reconnectUrl(input.appUrl, provider),
    });
    await input.sendSystemNotice({ to: ownerEmail, subject, textBody, htmlBody: html });
    emailed = true;
  }

  return { outcome: "flipped", newStatus, emailed };
}

// ---------------------------------------------------------------------------
// Pure core — sweep ALL active accounts at `now`. Returns counts.
// ---------------------------------------------------------------------------

export type SweepConnectorStatusResult = {
  scanned: number;
  flipped: number;
  emailed: number;
  errored: number;
};

export async function sweepConnectorStatus(input: {
  accountsRepo: ConnectorAccountsRepository;
  ownerResolver: OwnerEmailResolver;
  emitEvent: EmitEvent;
  audit: ConnectorAuditWriter;
  sendSystemNotice: SendSystemNotice;
  fetchConnectedAccount: (id: string) => Promise<ConnectedAccountRetrieveResponse>;
  appUrl: string;
  now: Date;
}): Promise<SweepConnectorStatusResult> {
  const active = await input.accountsRepo.listActive();

  let flipped = 0;
  let emailed = 0;
  let errored = 0;

  for (const account of active) {
    const result = await reconcileConnectorAccount({
      account,
      accountsRepo: input.accountsRepo,
      ownerResolver: input.ownerResolver,
      emitEvent: input.emitEvent,
      audit: input.audit,
      sendSystemNotice: input.sendSystemNotice,
      fetchConnectedAccount: input.fetchConnectedAccount,
      appUrl: input.appUrl,
      now: input.now,
    });
    if (result.outcome === "flipped") {
      flipped += 1;
      if (result.emailed) emailed += 1;
    } else if (result.outcome === "error") {
      errored += 1;
    }
  }

  return { scanned: active.length, flipped, emailed, errored };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — cron every 15 minutes. `now` minted once in step 1.
// ---------------------------------------------------------------------------

export const sweepConnectorStatusFunction = inngest.createFunction(
  { id: "sweep-connector-status", triggers: { cron: "*/15 * * * *" }, retries: 2 },
  async ({ step }) => {
    // Step 1: mint `now` once + load the working set. Read both back from the
    // memoized return so re-execution shares the same instant and the same list.
    const scan = await step.run("scan-active", async () => {
      const now = new Date();
      const accounts = await new DrizzleConnectorAccountsRepository().listActive();
      return {
        nowIso: now.toISOString(),
        accounts: accounts.map((a) => ({
          id: a.id,
          userId: a.userId,
          provider: a.provider,
          composioConnectedAccountId: a.composioConnectedAccountId,
        })),
      };
    });

    const now = new Date(scan.nowIso);
    const env = getEnv();
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    let flipped = 0;
    let emailed = 0;
    let errored = 0;

    // Each account is its own keyed step: a non-ACTIVE flip + its single reconnect
    // email + audit are one atomic memoized unit, so re-execution never re-sends.
    for (const account of scan.accounts) {
      const result = await step.run(`reconcile-${account.id}`, async () => {
        return reconcileConnectorAccount({
          account,
          accountsRepo: new DrizzleConnectorAccountsRepository(),
          ownerResolver: new DrizzleOwnerEmailResolver(),
          emitEvent: sendEvent,
          audit: new DrizzleConnectorAuditWriter(),
          sendSystemNotice: async (notice) => {
            await sendSystemEmail({ email: notice, sender: getEmailSender() });
          },
          fetchConnectedAccount: getConnectedAccount,
          appUrl,
          now,
        });
      });
      if (result.outcome === "flipped") {
        flipped += 1;
        if (result.emailed) emailed += 1;
      } else if (result.outcome === "error") {
        errored += 1;
      }
    }

    console.log(
      `[sweep-connector-status] scanned=${scan.accounts.length} flipped=${flipped} emailed=${emailed} errored=${errored}`,
    );

    return { ok: true, scanned: scan.accounts.length, flipped, emailed, errored };
  },
);
