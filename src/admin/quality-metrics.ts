/**
 * src/admin/quality-metrics.ts
 *
 * loadQualityMetrics({ db?, days = 30 }) — returns quality_metrics_daily rows
 * for the last N days grouped by metric (each metric as a date-asc series), plus
 * the most recent eval_runs row. DB-injectable for testing.
 */

import { and, desc, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { qualityMetricsDaily, evalRuns } from "@/db/schema";

export type MetricSeries = {
  metric: string;
  rows: Array<{
    date: string; // ISO "YYYY-MM-DD"
    value: number;
    denominator: number | null;
    metadata: unknown;
  }>;
};

export type LatestEvalRun = {
  id: string;
  mode: string;
  gitSha: string | null;
  modelId: string | null;
  caseCount: number;
  precision: number | null;
  recall: number | null;
  lowConfidenceHandlingRate: number | null;
  falsePositiveRate: number | null;
  createdAt: Date;
};

export type QualityMetricsResult = {
  series: MetricSeries[];
  latestEvalRun: LatestEvalRun | null;
};

type DbArg = ReturnType<typeof getDb>;

export async function loadQualityMetrics({
  db,
  days = 30,
}: {
  db?: DbArg;
  days?: number;
} = {}): Promise<QualityMetricsResult> {
  const database = db ?? getDb();

  // Use SQL-level date arithmetic so we don't depend on JS date boundary logic.
  const cutoff = sql<string>`(current_date - ${days}::integer * interval '1 day')::date`;

  // Fetch metric rows for the last N days, ordered date asc.
  const metricRows = await database
    .select()
    .from(qualityMetricsDaily)
    .where(gte(qualityMetricsDaily.date, cutoff))
    .orderBy(qualityMetricsDaily.date);

  // Group into per-metric series preserving insertion order of first occurrence.
  const seriesMap = new Map<string, MetricSeries>();
  for (const row of metricRows) {
    let series = seriesMap.get(row.metric);
    if (!series) {
      series = { metric: row.metric, rows: [] };
      seriesMap.set(row.metric, series);
    }
    series.rows.push({
      date: row.date as string,
      value: row.value,
      denominator: row.denominator ?? null,
      metadata: row.metadata,
    });
  }

  // Sort series alphabetically for stable display ordering.
  const series = Array.from(seriesMap.values()).sort((a, b) =>
    a.metric.localeCompare(b.metric),
  );

  // Fetch the most recent eval_runs row.
  const [latestEval] = await database
    .select()
    .from(evalRuns)
    .orderBy(desc(evalRuns.createdAt))
    .limit(1);

  const latestEvalRun: LatestEvalRun | null = latestEval
    ? {
        id: latestEval.id,
        mode: latestEval.mode,
        gitSha: latestEval.gitSha ?? null,
        modelId: latestEval.modelId ?? null,
        caseCount: latestEval.caseCount,
        precision: latestEval.precision ?? null,
        recall: latestEval.recall ?? null,
        lowConfidenceHandlingRate: latestEval.lowConfidenceHandlingRate ?? null,
        falsePositiveRate: latestEval.falsePositiveRate ?? null,
        createdAt: latestEval.createdAt,
      }
    : null;

  return { series, latestEvalRun };
}
