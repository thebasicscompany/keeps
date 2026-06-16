/**
 * app/admin/automation-runs/page.tsx
 *
 * Admin observability for the automation pipeline (org-visibility Wave 4). Gated by requireAdmin().
 * Shows the most recent automation_runs across all users — recipe, status, provenance line / skip
 * reason, and timing. Read-only; no tokens, no source quotes, no DB internals.
 */
import { desc, eq } from "drizzle-orm";
import { requireAdmin } from "@/admin/require-admin";
import { getDb } from "@/db/client";
import { automationRuns, users } from "@/db/schema";
import { automationRunRowViewModel } from "@/automation/automations-view";

export const dynamic = "force-dynamic";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default async function AutomationRunsPage() {
  const gate = await requireAdmin();
  if ("forbidden" in gate) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-[#14140F]">
        <h1 className="text-xl font-bold">403 — Admins only</h1>
        <p className="mt-2 text-sm text-[#6F6F66]">You do not have access to this page.</p>
      </main>
    );
  }

  const rows = await getDb()
    .select({
      id: automationRuns.id,
      recipeKey: automationRuns.recipeKey,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
      provenance: automationRuns.provenance,
      email: users.email,
    })
    .from(automationRuns)
    .innerJoin(users, eq(automationRuns.userId, users.id))
    .orderBy(desc(automationRuns.createdAt))
    .limit(100);

  const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-mono text-[13px] text-[#14140F]">
      <h1 className="mb-1 text-xl font-bold">automation runs</h1>
      <p className="mb-2 text-[#6F6F66]">
        org-visibility automation pipeline — {rows.length} run{rows.length === 1 ? "" : "s"} (most recent first, limit 100)
      </p>
      <p className="mb-6 text-[11px] text-[#6F6F66]">
        {Object.entries(byStatus).map(([s, n], i) => `${i > 0 ? " · " : ""}${s}: ${n}`).join("")}
        {rows.length === 0 ? "no runs yet" : ""}
      </p>

      {rows.length === 0 ? (
        <p className="text-[#6F6F66]">No automation runs recorded.</p>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[#DEDED8] text-[11px] uppercase text-[#6F6F66]">
              <th className="py-2 pr-4">when</th>
              <th className="py-2 pr-4">user</th>
              <th className="py-2 pr-4">recipe</th>
              <th className="py-2 pr-4">status</th>
              <th className="py-2">why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const vm = automationRunRowViewModel(r);
              return (
                <tr key={r.id} className="border-b border-[#F0F0EC] align-top">
                  <td className="py-2 pr-4 whitespace-nowrap text-[#6F6F66]">{fmt(vm.startedAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{r.email}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{vm.recipeName}</td>
                  <td className="py-2 pr-4 whitespace-nowrap uppercase">{vm.status}</td>
                  <td className="py-2 text-[#6F6F66]">{vm.detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
