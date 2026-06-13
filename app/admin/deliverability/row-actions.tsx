"use client";

/**
 * Per-row Reactivate button for the deliverability admin page.
 * Posts to /api/admin/deliverability/reactivate and refreshes the server
 * component on success so the row drops out of the suppressed list.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function ReactivateButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    setError(null);
    try {
      const res = await fetch("/api/admin/deliverability/reactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setDone(true);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    }
  }

  if (done) {
    return <span className="text-[#1E6B4F]">Reactivated</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="border border-[#14140F] bg-[#C1F5DF] px-3 py-1 font-bold disabled:opacity-50"
      >
        {pending ? "Reactivating…" : "Reactivate"}
      </button>
      {error ? <span className="text-[11px] text-[#a3271f]">{error}</span> : null}
    </div>
  );
}
