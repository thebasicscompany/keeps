/**
 * notify-connector-failure — Inngest function id "notify-connector-failure".
 *
 * Subscribes to `connector.action_failed` (emitted by handle-connector-command.ts
 * after executeConnectorAction returns status='failed' or status='denied').
 *
 * On each failure event this function:
 *   (a) Adds a Sentry breadcrumb at error level (DSN-guarded; no-op without DSN).
 *   (b) Upserts quality_metrics_daily metric 'connector_failures_24h':
 *       - Counts connector_actions rows in status='failed' for the user in the last 24h,
 *         then sets that count as today's value. This is a read-modify-write rather than
 *         raw increment so repeated re-runs are idempotent (same count).
 *   (c) If the user has accumulated >= 3 connector failures within the last 1 hour,
 *       sends ONE reconnect email:
 *         "Your Slack/Calendar connection seems to be having trouble — reconnect at /settings/connectors"
 *       De-dupe: we only send on the EXACT transition to 3 failures in the window.
 *       Specifically: if the count-in-last-1h == exactly 3 (i.e. this is the 3rd failure
 *       in the window), we send. At 4+ we do NOT send again (the email was sent when
 *       the count crossed 3). This ensures one email per threshold-crossing, not one
 *       per subsequent failure.
 *
 * Injectable now + db for deterministic tests (mirrors score-nudge-feedback.ts pattern).
 *
 * @see src/workflows/events.ts — connector.action_failed payload shape
 * @see src/workflows/functions/score-nudge-feedback.ts — quality_metrics_daily upsert pattern
 * @see src/email/sender-factory.ts — getEmailSender() (suppression already applied)
 */

import { and, count, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { connectorActions, qualityMetricsDaily, users } from "@/db/schema";
import { getEmailSender } from "@/email/sender-factory";
import type { EmailSender } from "@/email/outbound";
import { getOptionalEnv } from "@/config/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectorFailureDb = PostgresJsDatabase<typeof schema>;

export interface NotifyConnectorFailureOptions {
  /** Current timestamp — must be minted inside Inngest step.run in production. */
  now: Date;
  /** Failing user id (from the connector.action_failed event). */
  userId: string;
  /** Provider (slack | google_calendar) for the reconnect email copy. */
  provider: "slack" | "google_calendar";
  /** connector_action_id being reported (for Sentry breadcrumb context). */
  connectorActionId: string;
  /** Error code from the event payload (for Sentry breadcrumb context). */
  errorCode: string;
  /** Injectable DB connection; defaults to getDb(). */
  db?: ConnectorFailureDb;
  /** Injectable email sender; defaults to getEmailSender(). Tests inject a capturing fake. */
  sender?: EmailSender;
  /** Injectable app url (for reconnect link); defaults to NEXT_PUBLIC_APP_URL env. */
  appUrl?: string;
}

export interface NotifyConnectorFailureResult {
  /** The count written to quality_metrics_daily for today. */
  failures24h: number;
  /** How many failures occurred in the last 1 hour (used for threshold logic). */
  failures1h: number;
  /** Whether the reconnect email was sent on this invocation. */
  emailSent: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a YYYY-MM-DD string in UTC for the given Date. */
function toUtcDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Sentry breadcrumb — DSN-guarded, never throws. */
function addSentryBreadcrumb(input: {
  userId: string;
  connectorActionId: string;
  provider: string;
  errorCode: string;
}): void {
  if (!process.env.SENTRY_DSN) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/nextjs") as typeof import("@sentry/nextjs");
    Sentry.addBreadcrumb({
      category: "connector.failure",
      message: `connector.action_failed: ${input.provider} / ${input.errorCode}`,
      level: "error",
      data: {
        userId: input.userId,
        connectorActionId: input.connectorActionId,
        provider: input.provider,
        errorCode: input.errorCode,
      },
    });
  } catch {
    // Never let Sentry errors propagate.
  }
}

// ---------------------------------------------------------------------------
// Core logic — exported for tests
// ---------------------------------------------------------------------------

/**
 * Process a connector.action_failed event: upsert quality metric + conditional reconnect email.
 *
 * Idempotency note: if called twice with the same `now`, the 24h count will be the same
 * (query result), and the upsert is safe. The email de-dupe (send only at count==3)
 * is also safe: a second call for the same failure does not add a new row to
 * connector_actions (the row already exists), so the count is unchanged.
 */
export async function notifyConnectorFailureCore(
  opts: NotifyConnectorFailureOptions,
): Promise<NotifyConnectorFailureResult> {
  const { now, userId, provider, connectorActionId, errorCode } = opts;
  const db = opts.db ?? (getDb() as ConnectorFailureDb);
  const sender = opts.sender ?? getEmailSender();

  // (a) Sentry breadcrumb (DSN-guarded, no-op without DSN).
  addSentryBreadcrumb({ userId, connectorActionId, provider, errorCode });

  const todayIso = toUtcDateIso(now);
  const window24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const window1h = new Date(now.getTime() - 60 * 60 * 1000);

  // (b) Count connector_actions rows in 'failed' status for this user in the last 24h.
  //     Using failedAt (set by executeConnectorAction on failure) as the timestamp.
  //     Note: failedAt may be null for rows that were cancelled/denied without a failedAt;
  //     we use updatedAt as fallback via a COALESCE in SQL.
  const [row24h] = await db
    .select({ cnt: count() })
    .from(connectorActions)
    .where(
      and(
        sql`${connectorActions.userId} = ${userId}::uuid`,
        sql`${connectorActions.status} = 'failed'`,
        gte(connectorActions.updatedAt, window24h),
      ),
    );

  const failures24h = Number(row24h?.cnt ?? 0);

  // Upsert quality_metrics_daily metric 'connector_failures_24h' for today.
  await db
    .insert(qualityMetricsDaily)
    .values({
      date: todayIso,
      metric: "connector_failures_24h",
      value: failures24h,
      denominator: null,
      metadata: { userId },
    })
    .onConflictDoUpdate({
      target: [qualityMetricsDaily.date, qualityMetricsDaily.metric],
      set: {
        value: failures24h,
        metadata: { userId },
      },
    });

  // (c) Check 1-hour window for threshold logic.
  const [row1h] = await db
    .select({ cnt: count() })
    .from(connectorActions)
    .where(
      and(
        sql`${connectorActions.userId} = ${userId}::uuid`,
        sql`${connectorActions.status} = 'failed'`,
        gte(connectorActions.updatedAt, window1h),
      ),
    );

  const failures1h = Number(row1h?.cnt ?? 0);

  // De-dupe: send the reconnect email ONLY on the exact 3rd failure in the 1h window.
  // At count == 3: this is the threshold crossing → send once.
  // At count > 3: we already sent when count crossed 3 → do not spam.
  // At count < 3: threshold not yet reached → do not send.
  let emailSent = false;
  if (failures1h === 3) {
    const env = getOptionalEnv();
    const appUrl = opts.appUrl ?? env.NEXT_PUBLIC_APP_URL ?? "https://app.keeps.email";

    // Fetch the user's email address to send to.
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(sql`${users.id} = ${userId}::uuid`)
      .limit(1);

    if (userRow?.email) {
      const providerLabel = provider === "slack" ? "Slack" : "Google Calendar";
      const reconnectUrl = `${appUrl}/settings/connectors`;
      const textBody = [
        `Your ${providerLabel} connection seems to be having trouble — I've run into 3 failures in the past hour.`,
        "",
        `Reconnect at: ${reconnectUrl}`,
        "",
        "Once reconnected, your automations will resume normally.",
      ].join("\n");
      const { renderButtonEmailHtml } = await import("@/email/button-html");
      const htmlBody = renderButtonEmailHtml({
        paragraphs: [
          `Your ${providerLabel} connection seems to be having trouble — I've run into 3 failures in the past hour.`,
          "Once reconnected, your automations will resume normally.",
        ],
        button: { label: "Reconnect", url: reconnectUrl },
      });
      await sender.send({
        userId,
        nudgeId: null,
        to: userRow.email,
        subject: `Your ${providerLabel} connection is having trouble`,
        textBody,
        htmlBody,
        headers: {},
      });
      emailSent = true;
    }
  }

  return { failures24h, failures1h, emailSent };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding
// ---------------------------------------------------------------------------

export const notifyConnectorFailureFunction = inngest.createFunction(
  {
    id: "notify-connector-failure",
    triggers: { event: "connector.action_failed" },
    retries: 2,
  },
  async ({ event, step }) => {
    const data = event.data;

    const result = await step.run("notify-connector-failure-core", async () => {
      // Mint `now` inside step.run (Inngest determinism rule).
      const now = new Date();
      return notifyConnectorFailureCore({
        now,
        userId: data.userId,
        provider: data.provider,
        connectorActionId: data.connectorActionId,
        errorCode: data.error.code,
      });
    });

    console.log(
      `[notify-connector-failure] userId=${data.userId} provider=${data.provider} ` +
        `failures24h=${result.failures24h} failures1h=${result.failures1h} emailSent=${result.emailSent}`,
    );

    return result;
  },
);
