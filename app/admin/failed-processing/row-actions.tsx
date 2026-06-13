"use client";

/**
 * Per-row Replay / Resolve buttons for the dead-letter admin page. Posts to
 * /api/admin/failed-processing/replay and refreshes the server component on success
 * so the row drops out of the open list.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RowActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "replay" | "resolve">(null);

  async function run(action: "replay" | "resolve") {
    setError(null);
    setBusy(action);
    try {
      const res = await fetch("/api/admin/failed-processing/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  const disabled = pending || busy != null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => run("replay")}
          disabled={disabled}
          className="border border-[#14140F] bg-[#C1F5DF] px-3 py-1 font-bold disabled:opacity-50"
        >
          {busy === "replay" ? "Replaying…" : "Replay"}
        </button>
        <button
          type="button"
          onClick={() => run("resolve")}
          disabled={disabled}
          className="border border-[#14140F] bg-white px-3 py-1 disabled:opacity-50"
        >
          {busy === "resolve" ? "Resolving…" : "Resolve"}
        </button>
      </div>
      {error ? <span className="text-[11px] text-[#a3271f]">{error}</span> : null}
    </div>
  );
}
