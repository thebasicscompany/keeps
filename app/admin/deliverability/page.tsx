/**
 * app/admin/deliverability/page.tsx
 *
 * Admin-only deliverability management page. Gated by requireAdmin().
 *
 * Lists users whose outboundEmailState is not 'active' (bounced, complained,
 * suppressed). Each row has a "Reactivate" button that calls
 * POST /api/admin/deliverability/reactivate, resets the state to 'active',
 * and writes an audit_log row.
 *
 * The pure presentational component DeliverabilityTable is exported for
 * render smoke tests (no DB, no Clerk).
 */

import { requireAdmin } from "@/admin/require-admin";
import { listSuppressedUsers, type SuppressedUser } from "@/admin/deliverability-admin";
import { ReactivateButton } from "./row-actions";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Exported presentational component (testable without DB)
// ---------------------------------------------------------------------------

export function DeliverabilityTable({ rows }: { rows: SuppressedUser[] }) {
  return (
    <div className="overflow-x-auto border border-[#14140F]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-[#14140F] text-left text-[#C1F5DF]">
            <th className="px-2 py-1">email</th>
            <th className="px-2 py-1">state</th>
            <th className="px-2 py-1">updatedAt</th>
            <th className="px-2 py-1">action</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-2 py-4 text-center text-[#6F6F66]">
                No suppressed users.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-t border-[#d8d8cf] align-top">
                <td className="px-2 py-1">{row.email}</td>
                <td className="px-2 py-1">
                  <span
                    className={
                      row.outboundEmailState === "bounced"
                        ? "text-[#a3271f]"
                        : row.outboundEmailState === "complained"
                          ? "text-[#b45309]"
                          : "text-[#6F6F66]"
                    }
                  >
                    {row.outboundEmailState}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1">
                  {row.updatedAt.toISOString()}
                </td>
                <td className="px-2 py-1">
                  <ReactivateButton userId={row.id} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DeliverabilityPage() {
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

  const rows = await listSuppressedUsers();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 font-mono text-[13px] text-[#14140F]">
      <h1 className="mb-1 text-xl font-bold">deliverability</h1>
      <p className="mb-6 text-[#6F6F66]">
        {rows.length} suppressed user{rows.length === 1 ? "" : "s"} (outboundEmailState ≠ active)
      </p>
      <DeliverabilityTable rows={rows} />
    </main>
  );
}
