/**
 * sweep-reconciliation-metrics — daily Inngest cron (02:00 UTC).
 *
 * Counts the PRIOR UTC day's reconciliation loop_events (`reconciled`,
 * `reconcile_suggested`, `superseded`) and upserts observability metrics into
 * quality_metrics_daily. OBSERVABILITY ONLY — the false-merge=0 / false-auto-close=0
 * guarantees are CI-gated eval invariants (src/agent/eval/reconciliation.eval.test.ts),
 * not measured here.
 *
 * Inngest determinism: `now` is minted inside step.run. DB-injectable for tests.
 */

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { loopEvents, qualityMetricsDaily } from "@/db/schema";

export type ReconcileMetricsDb = PostgresJsDatabase<typeof schema>;

export interface CountReconciliationMetricsOptions {
  /** Current timestamp — minted inside Inngest step.run in production. */
  now: Date;
  /** Injectable DB connection; defaults to getDb(). */
  db?: ReconcileMetricsDb;
  /** Test-only: restrict aggregation to one user for deterministic parallel DB tests. */
  scopeUserId?: string;
}

export interface ReconciliationMetricsResult {
  date: string;
  reconciledCount: number;
  reconcileSuggestedCount: number;
  supersededCount: number;
  askToMergeRate: number;
}

const RECONCILE_EVENT_TYPES = ["reconciled", "reconcile_suggested", "superseded"] as const;

/** [start, end) of the UTC day before `now`, plus its YYYY-MM-DD label. */
function priorUtcDay(now: Date): { start: Date; end: Date; iso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end, iso: start.toISOString().slice(0, 10) };
}

export async function countReconciliationMetrics(
  options: CountReconciliationMetricsOptions,
): Promise<ReconciliationMetricsResult> {
  const db = options.db ?? getDb();
  const { scopeUserId } = options;
  const { start, end, iso } = priorUtcDay(options.now);

  const rows = await db
    .select({ eventType: loopEvents.eventType, count: sql<number>`count(*)::int` })
    .from(loopEvents)
    .where(
      and(
        inArray(loopEvents.eventType, [...RECONCILE_EVENT_TYPES]),
        gte(loopEvents.createdAt, start),
        lt(loopEvents.createdAt, end),
        scopeUserId ? eq(loopEvents.userId, scopeUserId) : undefined,
      ),
    )
    .groupBy(loopEvents.eventType);

  const counts: Record<(typeof RECONCILE_EVENT_TYPES)[number], number> = {
    reconciled: 0,
    reconcile_suggested: 0,
    superseded: 0,
  };
  for (const row of rows) {
    if (row.eventType in counts) {
      counts[row.eventType as keyof typeof counts] = Number(row.count);
    }
  }

  const askToMergeRate =
    counts.reconcile_suggested > 0 ? counts.superseded / counts.reconcile_suggested : 0;

  const upserts: Array<{ metric: string; value: number; denominator?: number }> = [
    { metric: "reconcile_auto_count", value: counts.reconciled },
    { metric: "reconcile_ask_count", value: counts.reconcile_suggested },
    { metric: "reconcile_superseded_count", value: counts.superseded },
    {
      metric: "reconcile_ask_to_merge_rate",
      value: askToMergeRate,
      denominator: counts.reconcile_suggested,
    },
  ];

  for (const row of upserts) {
    await db
      .insert(qualityMetricsDaily)
      .values({
        date: iso,
        metric: row.metric,
        value: row.value,
        denominator: row.denominator ?? null,
        metadata: {},
      })
      .onConflictDoUpdate({
        target: [qualityMetricsDaily.date, qualityMetricsDaily.metric],
        set: { value: row.value, denominator: row.denominator ?? null },
      });
  }

  return {
    date: iso,
    reconciledCount: counts.reconciled,
    reconcileSuggestedCount: counts.reconcile_suggested,
    supersededCount: counts.superseded,
    askToMergeRate,
  };
}

export const sweepReconciliationMetricsFunction = inngest.createFunction(
  { id: "sweep-reconciliation-metrics", triggers: { cron: "0 2 * * *" }, retries: 1 },
  async ({ step }) => {
    const result = await step.run("count-reconciliation-metrics", async () => {
      return countReconciliationMetrics({ now: new Date() });
    });
    console.log(
      `[sweep-reconciliation-metrics] date=${result.date} reconciled=${result.reconciledCount} ask=${result.reconcileSuggestedCount} superseded=${result.supersededCount} askToMergeRate=${result.askToMergeRate}`,
    );
    return result;
  },
);
