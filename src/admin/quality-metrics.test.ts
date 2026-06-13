/**
 * DB-gated integration tests for loadQualityMetrics.
 *
 * SKIPPED unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { qualityMetricsDaily, evalRuns } from "@/db/schema";
import { loadQualityMetrics } from "@/admin/quality-metrics";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("loadQualityMetrics (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });

  // Unique suffix to avoid colliding with other test runs.
  const RUN_ID = Date.now();
  const METRIC_A = `test_metric_a_${RUN_ID}`;
  const METRIC_B = `test_metric_b_${RUN_ID}`;

  let evalRunId: string;

  beforeAll(async () => {
    // Seed two metrics across two dates.
    await db.insert(qualityMetricsDaily).values([
      {
        date: "2026-06-11",
        metric: METRIC_A,
        value: 0.85,
        denominator: 100,
        metadata: { note: "seed-a-1" },
      },
      {
        date: "2026-06-12",
        metric: METRIC_A,
        value: 0.9,
        denominator: 110,
        metadata: { note: "seed-a-2" },
      },
      {
        date: "2026-06-12",
        metric: METRIC_B,
        value: 3,
        denominator: null,
        metadata: {},
      },
    ]);

    // Seed an eval run.
    const [run] = await db
      .insert(evalRuns)
      .values({
        mode: "deterministic",
        gitSha: "abc123",
        modelId: "claude-3-5-haiku-20241022",
        caseCount: 42,
        precision: 0.91,
        recall: 0.87,
      })
      .returning({ id: evalRuns.id });
    evalRunId = run.id;
  });

  afterAll(async () => {
    // Clean up seeded rows by metric name (unique per run).
    await db
      .delete(qualityMetricsDaily)
      .where(inArray(qualityMetricsDaily.metric, [METRIC_A, METRIC_B]));
    await db.delete(evalRuns).where(eq(evalRuns.id, evalRunId));
    await sql.end();
  });

  it("returns per-metric series with date-asc rows", async () => {
    const result = await loadQualityMetrics({ db, days: 60 });

    const seriesA = result.series.find((s) => s.metric === METRIC_A);
    const seriesB = result.series.find((s) => s.metric === METRIC_B);

    expect(seriesA).toBeDefined();
    expect(seriesB).toBeDefined();

    // METRIC_A has 2 rows, date-asc.
    expect(seriesA!.rows).toHaveLength(2);
    expect(seriesA!.rows[0].date).toBe("2026-06-11");
    expect(seriesA!.rows[1].date).toBe("2026-06-12");
    expect(seriesA!.rows[0].value).toBeCloseTo(0.85);
    expect(seriesA!.rows[1].denominator).toBe(110);

    // METRIC_B has 1 row.
    expect(seriesB!.rows).toHaveLength(1);
    expect(seriesB!.rows[0].value).toBeCloseTo(3);
    expect(seriesB!.rows[0].denominator).toBeNull();
  });

  it("series are sorted alphabetically by metric name", async () => {
    const result = await loadQualityMetrics({ db, days: 60 });
    const ourMetrics = result.series
      .filter((s) => s.metric.startsWith("test_metric_"))
      .map((s) => s.metric);
    expect(ourMetrics).toEqual([...ourMetrics].sort());
  });

  it("returns the latest eval run with correct fields", async () => {
    const result = await loadQualityMetrics({ db, days: 60 });

    expect(result.latestEvalRun).not.toBeNull();
    const run = result.latestEvalRun!;
    expect(run.mode).toBe("deterministic");
    expect(run.gitSha).toBe("abc123");
    expect(run.modelId).toBe("claude-3-5-haiku-20241022");
    expect(run.caseCount).toBe(42);
    expect(run.precision).toBeCloseTo(0.91);
    expect(run.recall).toBeCloseTo(0.87);
    expect(run.createdAt).toBeInstanceOf(Date);
  });

  it("returns empty series when days window excludes all rows", async () => {
    // Use days=0 which should produce a window of today-only; our seeded rows
    // are on past dates, so they may or may not fall in; use days=-1 to guarantee
    // exclusion by passing a future cutoff. Actually use a very small days window
    // and dates far in the past — pass days=1 which gives yesterday-to-today.
    // Our seeded dates are 2026-06-11 and 2026-06-12; today is 2026-06-13.
    // days=1 → cutoff = 2026-06-12; 2026-06-11 excluded. days=0 → cutoff = today.
    // Use days=0 to get today-only window. Our seeded rows are in the past → excluded.
    const result = await loadQualityMetrics({ db, days: 0 });
    const ourMetrics = result.series.filter((s) => s.metric.startsWith("test_metric_"));
    expect(ourMetrics).toHaveLength(0);
  });
});
