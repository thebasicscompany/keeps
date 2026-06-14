/**
 * Phase 7 B2c — parse a user's YES/NO reply to a suppressed-duplicate reconciliation ask
 * ("Looks like your existing loop about \"X\" — is this the same? Reply YES to merge or NO
 * to keep separate.").
 *
 *   'same'      → the user agrees it IS the same commitment (merge into the candidate).
 *   'different' → the user says they are distinct (keep the suppressed loop separate).
 *   null        → not a recognizable YES/NO answer; the caller falls through to normal
 *                 intent handling so a real loop command ("done 1") is never hijacked.
 *
 * Pure + deterministic (no model). Only fires the reconcile-confirm dispatch when the
 * originating nudge actually carries pending asks, so bare "yes"/"no" replies elsewhere
 * are unaffected.
 */
export type ReconcileConfirmReply = "same" | "different";

const AFFIRMATIVE = new Set(["yes", "y", "yep", "yeah", "yup", "same", "merge", "correct"]);
const NEGATIVE = new Set(["no", "n", "nope", "nah", "different", "separate"]);

export function parseReconcileConfirmReply(text: string): ReconcileConfirmReply | null {
  const normalized = text
    .trim()
    .toLowerCase()
    // strip trailing punctuation so "yes!", "no." resolve.
    .replace(/[!.,;:]+$/g, "")
    .trim();

  if (normalized.length === 0) {
    return null;
  }

  // Multi-word phrases checked first (single-token sets can't match these).
  if (normalized === "keep separate" || normalized === "keep them separate" || normalized === "not the same") {
    return "different";
  }
  if (normalized === "it's the same" || normalized === "its the same" || normalized === "the same") {
    return "same";
  }

  if (AFFIRMATIVE.has(normalized)) {
    return "same";
  }
  if (NEGATIVE.has(normalized)) {
    return "different";
  }

  return null;
}
