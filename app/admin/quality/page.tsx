/**
 * app/admin/quality/page.tsx
 *
 * Admin-only quality metrics dashboard. Gated by requireAdmin().
 *
 * Renders:
 *  - One panel per metric in quality_metrics_daily (last 30 days) as a compact
 *    HTML table with a text-based sparkline bar (no charting library).
 *  - A panel showing the latest eval_runs row.
 *
 * The pure presentational component QualityDashboard is exported for render
 * smoke tests (no DB, no Clerk).
 */

import { requireAdmin } from "@/admin/require-admin";
import { loadQualityMetrics, type QualityMetricsResult } from "@/admin/quality-metrics";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

/** Renders a text bar proportional to [0, max]. Always at least 1 char wide. */
function bar(value: number, max: number, width = 20): string {
  if (max === 0) return "▏";
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  // Percentages (value ≤ 1.0 is typically a ratio) get displayed as %.
  // Values > 1 rendered as rounded integers.
  if (n <= 1.0 && n >= 0) {
    return `${(n * 100).toFixed(1)}%`;
  }
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Exported presentational component (testable without DB)
// ---------------------------------------------------------------------------

export function QualityDashboard({ data }: { data: QualityMetricsResult }) {
  const { series, latestEvalRun } = data;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-mono text-[13px] text-[#14140F]">
      <h1 className="mb-1 text-xl font-bold">quality_metrics_daily</h1>
      <p className="mb-8 text-[#6F6F66]">Last 30 days. Ratios displayed as percentages.</p>

      {/* Per-metric panels */}
      {series.length === 0 ? (
        <div className="border border-[#14140F] px-4 py-8 text-center text-[#6F6F66]">
          No metrics yet.
        </div>
      ) : (
        <div className="space-y-8">
          {series.map((s) => {
            const values = s.rows.map((r) => r.value);
            const maxVal = Math.max(...values, 0.0001);
            const latest = s.rows[s.rows.length - 1];

            return (
              <section key={s.metric}>
                <div className="mb-1 flex items-baseline gap-4">
                  <h2 className="font-bold">{s.metric}</h2>
                  {latest ? (
                    <span className="text-[#6F6F66]">
                      latest {latest.date}: {fmt(latest.value)}
                      {latest.denominator != null
                        ? ` / ${latest.denominator} denom`
                        : ""}
                    </span>
                  ) : null}
                </div>

                <div className="overflow-x-auto border border-[#14140F]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-[#14140F] text-left text-[#C1F5DF]">
                        <th className="px-2 py-1">date</th>
                        <th className="px-2 py-1">value</th>
                        <th className="px-2 py-1">denom</th>
                        <th className="px-2 py-1">bar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.map((row) => (
                        <tr
                          key={row.date}
                          className="border-t border-[#d8d8cf] align-top"
                        >
                          <td className="whitespace-nowrap px-2 py-1">{row.date}</td>
                          <td className="whitespace-nowrap px-2 py-1">{fmt(row.value)}</td>
                          <td className="whitespace-nowrap px-2 py-1">
                            {row.denominator != null ? row.denominator : "—"}
                          </td>
                          <td className="px-2 py-1 font-mono text-[#1E6B4F]">
                            {bar(row.value, maxVal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Latest eval run panel */}
      <section className="mt-10">
        <h2 className="mb-1 font-bold">latest eval_run</h2>
        {latestEvalRun ? (
          <div className="border border-[#14140F] px-4 py-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
              {(
                [
                  ["createdAt", latestEvalRun.createdAt.toISOString()],
                  ["mode", latestEvalRun.mode],
                  ["modelId", latestEvalRun.modelId ?? "—"],
                  ["gitSha", latestEvalRun.gitSha ?? "—"],
                  ["caseCount", String(latestEvalRun.caseCount)],
                  ["precision", fmt(latestEvalRun.precision)],
                  ["recall", fmt(latestEvalRun.recall)],
                  [
                    "lowConfHandling",
                    fmt(latestEvalRun.lowConfidenceHandlingRate),
                  ],
                  ["falsePositiveRate", fmt(latestEvalRun.falsePositiveRate)],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[#6F6F66]">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <div className="border border-[#14140F] px-4 py-4 text-[#6F6F66]">
            No eval runs recorded yet.
          </div>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function QualityPage() {
  const gate = await requireAdmin();

  if ("forbidden" in gate) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-[#14140F]">
        <h1 className="text-xl font-bold">403 — Admins only</h1>
        <p className="mt-2 text-sm text-[#6F6F66]">
          You do not have access to this page.
        </p>
      </main>
    );
  }

  const data = await loadQualityMetrics();
  return <QualityDashboard data={data} />;
}
