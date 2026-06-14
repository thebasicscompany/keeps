/**
 * app/admin/reconciliations/page.tsx
 *
 * Admin-only viewer for Phase 7 reconciliation provenance (AR-9).
 * Gated by requireAdmin().
 *
 * Shows the most recent 100 loop_events of type 'reconciled',
 * 'reconcile_suggested', and 'superseded' — the three bands of the
 * context-engine reconciler — with their loop, decision label, one-sentence
 * reason, and evidence snippet.
 *
 * The presentational component ReconciliationsTable is exported for
 * render smoke tests (no DB, no Clerk).
 */

import { requireAdmin } from "@/admin/require-admin";
import { getDb } from "@/db/client";
import {
  listRecentReconciliations,
  decisionLabel,
  extractReason,
  extractEvidence,
  reconciledActionLabel,
  type ReconciliationRow,
} from "@/admin/reconciliations";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Exported presentational component (testable without DB)
// ---------------------------------------------------------------------------

export function ReconciliationsTable({ rows }: { rows: ReconciliationRow[] }) {
  return (
    <div className="overflow-x-auto border border-[#14140F]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-[#14140F] text-left text-[#C1F5DF]">
            <th className="px-2 py-1">timestamp</th>
            <th className="px-2 py-1">decision</th>
            <th className="px-2 py-1">loop</th>
            <th className="px-2 py-1">reason</th>
            <th className="px-2 py-1">evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-2 py-4 text-center text-[#6F6F66]">
                No reconciliation events yet.
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const subLabel = reconciledActionLabel(row.metadata);
              const label = subLabel ?? decisionLabel(row.eventType);
              return (
                <tr key={row.id} className="border-t border-[#d8d8cf] align-top">
                  <td className="whitespace-nowrap px-2 py-1 text-[#6F6F66]">
                    {row.createdAt.toISOString()}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <span
                      className={
                        row.eventType === "reconciled"
                          ? "text-[#14140F] font-medium"
                          : row.eventType === "reconcile_suggested"
                            ? "text-[#b45309]"
                            : "text-[#6F6F66]"
                      }
                    >
                      {label}
                    </span>
                  </td>
                  <td className="max-w-xs px-2 py-1">
                    <span className="line-clamp-2 break-words text-[#14140F]">
                      {row.loopSummary}
                    </span>
                    <span className="block text-[10px] text-[#6F6F66]">{row.loopId}</span>
                  </td>
                  <td className="max-w-sm px-2 py-1">
                    <span className="line-clamp-3 break-words text-[#6F6F66]">
                      {extractReason(row.metadata)}
                    </span>
                  </td>
                  <td className="max-w-sm px-2 py-1">
                    <span className="line-clamp-3 break-words text-[#6F6F66]">
                      {extractEvidence(row.metadata)}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page (server component)
// ---------------------------------------------------------------------------

export default async function ReconciliationsPage() {
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

  const db = getDb();
  const rows = await listRecentReconciliations({ db, limit: 100 });

  const reconciledCount = rows.filter((r) => r.eventType === "reconciled").length;
  const suggestedCount = rows.filter((r) => r.eventType === "reconcile_suggested").length;
  const supersededCount = rows.filter((r) => r.eventType === "superseded").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-mono text-[13px] text-[#14140F]">
      <h1 className="mb-1 text-xl font-bold">reconciliations</h1>
      <p className="mb-2 text-[#6F6F66]">
        Phase 7 AR-9 provenance — {rows.length} event{rows.length === 1 ? "" : "s"} (most
        recent first, limit 100)
      </p>
      <p className="mb-6 text-[11px] text-[#6F6F66]">
        auto-reconciled: {reconciledCount} · asked: {suggestedCount} · superseded:{" "}
        {supersededCount}
      </p>

      <ReconciliationsTable rows={rows} />

      <p className="mt-6 text-[11px] text-[#6F6F66]">
        Other admin pages:{" "}
        <a href="/admin/deliverability" className="underline">
          deliverability
        </a>{" "}
        ·{" "}
        <a href="/admin/model-calls" className="underline">
          model-calls
        </a>{" "}
        ·{" "}
        <a href="/admin/quality" className="underline">
          quality
        </a>{" "}
        ·{" "}
        <a href="/admin/failed-processing" className="underline">
          failed-processing
        </a>
      </p>
    </main>
  );
}
