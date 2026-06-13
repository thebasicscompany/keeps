/**
 * app/admin/failed-processing/page.tsx
 *
 * Admin-only viewer for the dead-letter queue (failed_processing). Gated by
 * requireAdmin(). Lists OPEN rows (resolvedAt IS NULL), newest first, with a
 * per-row Replay and Resolve action.
 *
 * The table body is factored into a pure `FailedProcessingTable` (exported) so a
 * render smoke test can exercise it with injected rows — no DB, no Clerk.
 */

import { desc, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { failedProcessing, type FailedProcessing } from "@/db/schema";
import { requireAdmin } from "@/admin/require-admin";
import { RowActions } from "./row-actions";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 200;

function summarizePayload(payload: unknown): string {
  if (payload == null) return "—";
  try {
    const json = JSON.stringify(payload);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return String(payload);
  }
}

export function FailedProcessingTable({ rows }: { rows: FailedProcessing[] }) {
  return (
    <div className="overflow-x-auto border border-[#14140F]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-[#14140F] text-left text-[#C1F5DF]">
            <th className="px-2 py-1">failedAt</th>
            <th className="px-2 py-1">eventName</th>
            <th className="px-2 py-1">inboundEmailId</th>
            <th className="px-2 py-1">error</th>
            <th className="px-2 py-1">payload</th>
            <th className="px-2 py-1">replayedAt</th>
            <th className="px-2 py-1">actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-2 py-4 text-center text-[#5b5b52]">
                No open failures.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-t border-[#d8d8cf] align-top">
                <td className="whitespace-nowrap px-2 py-1">
                  {row.failedAt?.toISOString() ?? "—"}
                </td>
                <td className="px-2 py-1">{row.eventName}</td>
                <td className="px-2 py-1">{row.inboundEmailId ?? "—"}</td>
                <td className="max-w-xs px-2 py-1">
                  <span className="line-clamp-3 break-words text-[#a3271f]">
                    {row.errorMessage ?? "—"}
                  </span>
                </td>
                <td className="max-w-md px-2 py-1">
                  <span className="line-clamp-3 break-words text-[#5b5b52]">
                    {summarizePayload(row.eventPayload)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1">
                  {row.replayedAt?.toISOString() ?? "—"}
                </td>
                <td className="px-2 py-1">
                  <RowActions id={row.id} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default async function FailedProcessingPage() {
  const gate = await requireAdmin();

  if ("forbidden" in gate) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-[#14140F]">
        <h1 className="text-xl font-bold">403 — Admins only</h1>
        <p className="mt-2 text-sm text-[#5b5b52]">You do not have access to this page.</p>
      </main>
    );
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(failedProcessing)
    .where(isNull(failedProcessing.resolvedAt))
    .orderBy(desc(failedProcessing.failedAt))
    .limit(DEFAULT_LIMIT);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-mono text-[13px] text-[#14140F]">
      <h1 className="mb-1 text-xl font-bold">failed_processing</h1>
      <p className="mb-6 text-[#5b5b52]">
        {rows.length} open row{rows.length === 1 ? "" : "s"} (resolvedAt IS NULL, newest first)
      </p>
      <FailedProcessingTable rows={rows} />
    </main>
  );
}
