/**
 * score-nudge-feedback — daily Inngest cron (02:00 UTC).
 *
 * Computes two quality metrics and upserts them into quality_metrics_daily:
 *
 * 1. false_positive_nudge_rate
 *    Numerator:   nudges (status='sent') sent in the last 7 days whose associated loop
 *                 received a 'dismissed' loop_event within 24h of the nudge being sent.
 *    Denominator: total nudges (status='sent') sent in the last 7 days that have a loopId.
 *    Interpretation: a user dismissing the loop shortly after a nudge signals the nudge was
 *    unwanted / the loop was a false positive.
 *
 * 2. extraction_precision + extraction_recall (eval mirror)
 *    Reads the LATEST eval_runs row and mirrors its precision/recall into
 *    quality_metrics_daily for today so the dashboard gets a consistent time-series.
 *    This is idempotent via the onConflictDoUpdate upsert.
 *
 * Inngest determinism: `now` is minted inside step.run and passed as a Date.
 * DB-injectable: accepts `db` (defaults to getDb()) so tests can target test Postgres.
 */

import { and, desc, gte, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { evalRuns, loopEvents, nudges, qualityMetricsDaily } from "@/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NudgeFeedbackDb = PostgresJsDatabase<typeof schema>;

export interface ScoreNudgeFeedbackOptions {
  /** Current timestamp — must be minted inside Inngest step.run in production. */
  now: Date;
  /** Injectable DB connection; defaults to getDb(). */
  db?: NudgeFeedbackDb;
  /**
   * Test-only: restrict the (otherwise global) aggregation to a single user so
   * DB-gated tests are deterministic under parallel workers sharing one Postgres.
   * Production omits this — the cron aggregates across all users.
   */
  scopeUserId?: string;
}

export interface ScoreNudgeFeedbackResult {
  /** false_positive_nudge_rate value written (0 if denominator is 0). */
  falsePositiveNudgeRate: number;
  /** Number of nudges considered (denominator). */
  nudgeCount: number;
  /** extraction_precision mirrored from the latest eval run (null if no eval runs exist). */
  extractionPrecision: number | null;
  /** extraction_recall mirrored from the latest eval run (null if no eval runs exist). */
  extractionRecall: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a YYYY-MM-DD string in UTC for the given Date.
 */
function toUtcDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Core logic — exported for tests
// ---------------------------------------------------------------------------

/**
 * Compute nudge false-positive rate and eval mirror, then upsert into
 * quality_metrics_daily.
 *
 * Accepts an injectable `now` and `db` for deterministic testing.
 */
export async function scoreNudgeFeedback(
  options: ScoreNudgeFeedbackOptions,
): Promise<ScoreNudgeFeedbackResult> {
  const { now, scopeUserId } = options;
  const db = options.db ?? getDb();

  const todayIso = toUtcDateIso(now);

  // Window: last 7 days
  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // -----------------------------------------------------------------------
  // 1. false_positive_nudge_rate
  //
  // Denominator: nudges with status='sent', sentAt within last 7 days, and loopId IS NOT NULL.
  // Numerator: of those, how many have a 'dismissed' loop_event for the same loop
  //            with createdAt within 24h of nudge.sentAt.
  // -----------------------------------------------------------------------

  // Fetch all qualifying nudges sent in the last 7 days
  const sentNudges = await db
    .select({
      id: nudges.id,
      loopId: nudges.loopId,
      sentAt: nudges.sentAt,
    })
    .from(nudges)
    .where(
      and(
        sql`${nudges.status} = 'sent'`,
        isNotNull(nudges.loopId),
        isNotNull(nudges.sentAt),
        gte(nudges.sentAt, windowStart),
        scopeUserId ? sql`${nudges.userId} = ${scopeUserId}` : undefined,
      ),
    );

  const denominator = sentNudges.length;
  let falsePositiveCount = 0;

  if (denominator > 0) {
    // Fetch all 'dismissed' loop_events that touch any of these loops
    // (within our 7-day window + 24h buffer = 8 days total lookback)
    const loopIds = [...new Set(sentNudges.map((n) => n.loopId as string))];

    const dismissalWindowStart = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

    const dismissals = await db
      .select({
        loopId: loopEvents.loopId,
        createdAt: loopEvents.createdAt,
      })
      .from(loopEvents)
      .where(
        and(
          sql`${loopEvents.eventType} = 'dismissed'`,
          sql`${loopEvents.loopId} = ANY(${sql.raw(`ARRAY[${loopIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`,
          gte(loopEvents.createdAt, dismissalWindowStart),
        ),
      );

    // Build a map: loopId → Set<dismissal timestamps>
    const dismissalsByLoop = new Map<string, Date[]>();
    for (const d of dismissals) {
      const arr = dismissalsByLoop.get(d.loopId) ?? [];
      arr.push(d.createdAt);
      dismissalsByLoop.set(d.loopId, arr);
    }

    // Count nudges where any dismissal on the same loop happened within 24h of sentAt
    for (const nudge of sentNudges) {
      const loopId = nudge.loopId as string;
      const sentAt = nudge.sentAt as Date;
      const dismissals = dismissalsByLoop.get(loopId) ?? [];
      const windowEnd = new Date(sentAt.getTime() + 24 * 60 * 60 * 1000);
      const dismissed = dismissals.some(
        (dismissedAt) => dismissedAt >= sentAt && dismissedAt <= windowEnd,
      );
      if (dismissed) {
        falsePositiveCount++;
      }
    }
  }

  const falsePositiveNudgeRate = denominator > 0 ? falsePositiveCount / denominator : 0;

  // -----------------------------------------------------------------------
  // 2. Eval mirror: read the LATEST eval_runs row's precision/recall
  // -----------------------------------------------------------------------

  const latestEvalRuns = await db
    .select({
      precision: evalRuns.precision,
      recall: evalRuns.recall,
    })
    .from(evalRuns)
    .orderBy(desc(evalRuns.createdAt))
    .limit(1);

  const latestEval = latestEvalRuns[0] ?? null;
  const extractionPrecision = latestEval?.precision ?? null;
  const extractionRecall = latestEval?.recall ?? null;

  // -----------------------------------------------------------------------
  // 3. Upsert all computed metrics into quality_metrics_daily
  // -----------------------------------------------------------------------

  const rowsToUpsert: Array<{
    date: string;
    metric: string;
    value: number;
    denominator?: number;
  }> = [
    {
      date: todayIso,
      metric: "false_positive_nudge_rate",
      value: falsePositiveNudgeRate,
      denominator,
    },
  ];

  if (extractionPrecision !== null) {
    rowsToUpsert.push({
      date: todayIso,
      metric: "extraction_precision",
      value: extractionPrecision,
    });
  }

  if (extractionRecall !== null) {
    rowsToUpsert.push({
      date: todayIso,
      metric: "extraction_recall",
      value: extractionRecall,
    });
  }

  for (const row of rowsToUpsert) {
    await db
      .insert(qualityMetricsDaily)
      .values({
        date: row.date,
        metric: row.metric,
        value: row.value,
        denominator: row.denominator ?? null,
        metadata: {},
      })
      .onConflictDoUpdate({
        target: [qualityMetricsDaily.date, qualityMetricsDaily.metric],
        set: {
          value: row.value,
          denominator: row.denominator ?? null,
        },
      });
  }

  return {
    falsePositiveNudgeRate,
    nudgeCount: denominator,
    extractionPrecision,
    extractionRecall,
  };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding
// ---------------------------------------------------------------------------

export const scoreNudgeFeedbackFunction = inngest.createFunction(
  {
    id: "score-nudge-feedback",
    triggers: { cron: "0 2 * * *" },
    retries: 1,
  },
  async ({ step }) => {
    // Mint `now` inside step.run (Inngest determinism rule).
    const result = await step.run("score-nudge-feedback-metrics", async () => {
      const now = new Date();
      return scoreNudgeFeedback({ now });
    });

    console.log(
      `[score-nudge-feedback] falsePositiveNudgeRate=${result.falsePositiveNudgeRate} nudgeCount=${result.nudgeCount} precision=${result.extractionPrecision} recall=${result.extractionRecall}`,
    );

    return result;
  },
);
