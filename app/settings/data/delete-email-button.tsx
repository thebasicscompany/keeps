"use client";

/**
 * app/settings/data/delete-email-button.tsx
 *
 * Client component: "Delete this email and everything derived from it" button.
 * POSTs to /api/data/delete-email and reloads the page on success.
 * Shows a confirmation dialog before submitting — action is irreversible.
 */

import { useState } from "react";

interface Props {
  inboundEmailId: string;
  subject: string;
}

export function DeleteEmailButton({ inboundEmailId, subject }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = window.confirm(
      `Delete this email and everything derived from it?\n\n"${subject}"\n\nThis will permanently remove the email, all extracted loops, loop events, and related nudges. This action cannot be undone.`,
    );
    if (!confirmed) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/data/delete-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inboundEmailId }),
      });

      if (res.ok) {
        // Reload the page to reflect the deletion.
        window.location.reload();
        return;
      }

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 404) {
        setError("Email not found — it may have already been deleted.");
      } else {
        setError(data.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="h-9 rounded-none border border-[#E2E2DD] bg-white px-3 text-xs font-semibold text-[#B42318] transition-colors hover:border-[#B42318] hover:bg-[#FEF3F2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]/20 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={`Delete email: ${subject}`}
      >
        {pending ? "Deleting…" : "Delete this email and everything derived from it"}
      </button>
      {error && (
        <p className="text-xs text-[#B42318]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
