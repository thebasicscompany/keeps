"use client";

/**
 * app/settings/data/export-data-button.tsx
 *
 * Client component: "Export my data" button.
 * POSTs to /api/data/export (built by agent B3 — may 404 until merged).
 * Handles the response gracefully: triggers a download if the body is JSON,
 * shows an error if the endpoint isn't available yet.
 */

import { useState } from "react";

export function ExportDataButton() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function handleClick() {
    setPending(true);
    setMessage(null);

    try {
      const res = await fetch("/api/data/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        // Trigger download.
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `keeps-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setMessage({ kind: "ok", text: "Export started — check your downloads." });
      } else if (res.status === 404) {
        setMessage({
          kind: "error",
          text: "Export is not available yet — it will be enabled in a future release.",
        });
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({
          kind: "error",
          text: data.error ?? "Something went wrong. Please try again.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="h-11 w-full rounded-none border border-[#E2E2DD] bg-white px-5 text-sm font-semibold text-[#6F6F66] transition-colors hover:border-[#14140F] hover:text-[#14140F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14140F]/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Preparing export…" : "Export my data"}
      </button>
      {message && (
        <p
          className={`text-sm ${message.kind === "ok" ? "text-[#1E6B4F]" : "text-[#B42318]"}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
