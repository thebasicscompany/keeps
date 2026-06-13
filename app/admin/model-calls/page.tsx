/**
 * app/admin/model-calls/page.tsx
 *
 * Admin-only viewer for recent model_calls rows. Gated by requireAdmin().
 * Supports optional ?purpose= and ?userId= filters and a ?limit= (default 100,
 * capped at 500). Square/utilitarian table; no new UI primitives.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { modelCalls } from "@/db/schema";
import { requireAdmin } from "@/admin/require-admin";

export const dynamic = "force-dynamic";

const PURPOSES = [
  "extract_loops",
  "classify_intent",
  "draft_nudge",
  "draft_slack",
  "draft_calendar",
  "summarize_report",
] as const;

type SearchParams = { [key: string]: string | string[] | undefined };

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function ModelCallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
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

  const params = await searchParams;
  const purposeFilter = firstParam(params.purpose);
  const userIdFilter = firstParam(params.userId);
  const limitParam = Number.parseInt(firstParam(params.limit) ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 500)
    : 100;

  const conditions = [];
  if (purposeFilter && (PURPOSES as readonly string[]).includes(purposeFilter)) {
    conditions.push(eq(modelCalls.purpose, purposeFilter));
  }
  if (userIdFilter) {
    conditions.push(eq(modelCalls.userId, userIdFilter));
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(modelCalls)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(modelCalls.createdAt))
    .limit(limit);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-mono text-[13px] text-[#14140F]">
      <h1 className="mb-1 text-xl font-bold">model_calls</h1>
      <p className="mb-6 text-[#6F6F66]">
        {rows.length} row{rows.length === 1 ? "" : "s"} (most recent first, limit {limit})
      </p>

      {/* Filters */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase text-[#6F6F66]">purpose</span>
          <select
            name="purpose"
            defaultValue={purposeFilter ?? ""}
            className="border border-[#14140F] bg-white px-2 py-1"
          >
            <option value="">(any)</option>
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase text-[#6F6F66]">userId</span>
          <input
            type="text"
            name="userId"
            defaultValue={userIdFilter ?? ""}
            placeholder="(any)"
            className="border border-[#14140F] bg-white px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase text-[#6F6F66]">limit</span>
          <input
            type="number"
            name="limit"
            defaultValue={limit}
            min={1}
            max={500}
            className="w-24 border border-[#14140F] bg-white px-2 py-1"
          />
        </label>
        <button
          type="submit"
          className="border border-[#14140F] bg-[#C1F5DF] px-4 py-1 font-bold"
        >
          Filter
        </button>
      </form>

      {/* Table */}
      <div className="overflow-x-auto border border-[#14140F]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#14140F] text-left text-[#C1F5DF]">
              <th className="px-2 py-1">createdAt</th>
              <th className="px-2 py-1">purpose</th>
              <th className="px-2 py-1">modelId</th>
              <th className="px-2 py-1">latency</th>
              <th className="px-2 py-1">tokens (in/out)</th>
              <th className="px-2 py-1">userId</th>
              <th className="px-2 py-1">output / error</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-[#6F6F66]">
                  No model calls.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-[#d8d8cf] align-top">
                  <td className="whitespace-nowrap px-2 py-1">
                    {row.createdAt?.toISOString() ?? "—"}
                  </td>
                  <td className="px-2 py-1">{row.purpose}</td>
                  <td className="px-2 py-1">{row.modelId}</td>
                  <td className="whitespace-nowrap px-2 py-1">
                    {row.latencyMs == null ? "—" : `${row.latencyMs}ms`}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    {row.inputTokens ?? "—"} / {row.outputTokens ?? "—"}
                  </td>
                  <td className="px-2 py-1">{row.userId ?? "—"}</td>
                  <td className="max-w-md px-2 py-1">
                    {row.errorMessage ? (
                      <span className="text-[#a3271f]">err: {row.errorMessage}</span>
                    ) : (
                      <span className="line-clamp-3 break-words text-[#6F6F66]">
                        {summarizeOutput(row.structuredOutput)}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function summarizeOutput(output: unknown): string {
  if (output == null) return "—";
  try {
    const json = JSON.stringify(output);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return String(output);
  }
}
