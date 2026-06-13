"use client";

/**
 * app/settings/privacy/delete-data-form.tsx
 *
 * Client confirmation flow for account-wide deletion (deliverable 7).
 *
 * Two-stage UX:
 *   1. A "Delete all data" button reveals a confirmation field.
 *   2. The user must type their exact account email; the submit button stays
 *      disabled until the typed value matches (client-side guard; the route
 *      re-validates server-side authoritatively).
 *   3. On submit, POST /api/data/delete { typedEmail }. On 200, swap the whole
 *      section for a "Deletion in progress" terminal state.
 *
 * The actual Clerk delete + DB cascade run asynchronously in the
 * process-data-deletion Inngest function; this component only records intent.
 *
 * Design: square seafoam tokens via _ui (radius 0, Bricolage Grotesque).
 */

import { useState } from "react";
import { mutedClass, inputClass, secondaryButtonClass } from "../_ui";

interface DeleteDataFormProps {
  /** The signed-in user's verified account email — the required confirmation value. */
  accountEmail: string;
}

type Stage = "idle" | "confirming" | "submitting" | "done";

export function DeleteDataForm({ accountEmail }: DeleteDataFormProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const matches =
    typed.trim().toLowerCase() === accountEmail.trim().toLowerCase() &&
    typed.trim().length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches || stage === "submitting") return;

    setError(null);
    setStage("submitting");

    try {
      const res = await fetch("/api/data/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typedEmail: typed.trim() }),
      });

      if (res.ok) {
        setStage("done");
        return;
      }

      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? "Something went wrong. Please try again.");
      setStage("confirming");
    } catch {
      setError("Something went wrong. Please try again.");
      setStage("confirming");
    }
  }

  // Terminal state — deletion accepted and queued.
  if (stage === "done") {
    return (
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-[#14140F]">
          Deletion in progress
        </h3>
        <p className={`text-sm ${mutedClass}`}>
          We have received your request and are permanently deleting your
          account and all associated data. You will be signed out shortly. This
          action cannot be undone.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-[#14140F]">Delete all data</h3>
        <p className={`mt-1 text-sm ${mutedClass}`}>
          Permanently delete your account and all associated data — loops, raw
          emails, connector accounts, and digest history. This action cannot be
          undone.
        </p>
      </div>

      {stage === "idle" ? (
        <button
          type="button"
          className={`${secondaryButtonClass} w-full`}
          onClick={() => {
            setError(null);
            setStage("confirming");
          }}
        >
          Delete all data
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-2">
            <label
              htmlFor="confirm_email"
              className="block text-sm font-semibold text-[#14140F]"
            >
              Type your email to confirm
            </label>
            <p className={`text-xs ${mutedClass}`}>
              Enter <span className="font-semibold">{accountEmail}</span> to
              confirm permanent deletion.
            </p>
            <input
              id="confirm_email"
              name="confirm_email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={accountEmail}
              className={inputClass}
            />
          </div>

          {error ? (
            <p className="text-xs font-medium text-[#B42318]">{error}</p>
          ) : null}

          <div className="flex gap-3">
            <button
              type="button"
              className={`${secondaryButtonClass} flex-1`}
              onClick={() => {
                setStage("idle");
                setTyped("");
                setError(null);
              }}
              disabled={stage === "submitting"}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`${secondaryButtonClass} flex-1 border-[#B42318] text-[#B42318] hover:border-[#B42318] hover:text-[#B42318]`}
              disabled={!matches || stage === "submitting"}
            >
              {stage === "submitting"
                ? "Deleting…"
                : "Permanently delete account"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
