"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface RowActionsProps {
  loopId: string;
  token: string;
}

type Action = "done" | "dismiss" | "snooze" | "draft_nudge";

export function RowActions({ loopId, token }: RowActionsProps) {
  const router = useRouter();
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dispatch(action: Action) {
    if (inflight) return;
    setInflight(true);
    setError(null);

    // For snooze: prompt for a date or default to 7 days from now.
    // window.prompt is intentionally minimal — a full date-picker is overkill here.
    let body: Record<string, unknown> = { loopId, action };
    if (action === "snooze") {
      const sevenDaysFromNow = new Date(Date.now() + 7 * 864e5).toISOString();
      const input = typeof window !== "undefined"
        ? window.prompt("Snooze until (leave blank for 7 days from now):", "")
        : null;
      const snoozeUntil =
        input && input.trim().length > 0
          ? new Date(input.trim()).toISOString()
          : sevenDaysFromNow;
      body = { ...body, snoozeUntil };
    }

    try {
      const res = await fetch(`/api/reports/${token}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "Request failed");
        setError(text || "Request failed");
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setInflight(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5 sm:mt-0 sm:flex-row sm:items-center sm:gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={inflight}
        className="w-full rounded-none sm:w-auto"
        onClick={() => void dispatch("done")}
      >
        Done
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={inflight}
        className="w-full rounded-none sm:w-auto"
        onClick={() => void dispatch("dismiss")}
      >
        Dismiss
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={inflight}
        className="w-full rounded-none sm:w-auto"
        onClick={() => void dispatch("snooze")}
      >
        Snooze
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={inflight}
        className="w-full rounded-none sm:w-auto"
        onClick={() => void dispatch("draft_nudge")}
      >
        Draft nudge
      </Button>
      {error && (
        <p className="text-xs font-medium text-[#B42318] sm:ml-1">{error}</p>
      )}
    </div>
  );
}
