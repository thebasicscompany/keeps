export type EmailIntent = "capture" | "command" | "approval" | "question" | "correction";

export type ClassifyEmailIntentInput = {
  body: string;
  subject?: string;
};

export type ClassifyEmailIntentResult = {
  intent: EmailIntent;
  basis: "rule" | "model";
  matchedRule?: string;
};

/**
 * Classifies the intent of an inbound email using deterministic rules.
 *
 * These rules were promoted verbatim from the `classifyIntent` helper that
 * previously lived inside `extract-loops.ts`. They inspect the email body only;
 * `subject` is accepted for forward compatibility but is not yet consulted by
 * any rule.
 */
export function classifyEmailIntent({ body }: ClassifyEmailIntentInput): ClassifyEmailIntentResult {
  const lower = body.trim().toLowerCase();

  if (/^correct\b/.test(lower)) {
    return { intent: "correction", basis: "rule", matchedRule: "correction-prefix" };
  }

  if (
    /^(confirm|dismiss\s+\d+|remind me\b|mark\s+\d+\s+done|done\s+\d+|snooze\s+\d+)\b/.test(lower)
  ) {
    // `done N` and `snooze N` are the digest reply-footer command forms (Deliverable #8/#15).
    // Like the existing `dismiss N` / `mark N done`, they are unambiguous command prefixes.
    return { intent: "command", basis: "rule", matchedRule: "command-prefix" };
  }

  if (/^(approve|approved|yes,?\s+approve)\b/.test(lower)) {
    return { intent: "approval", basis: "rule", matchedRule: "approval-prefix" };
  }

  if (/\?$/.test(lower) && !/(can you|could you|please|need to|waiting on)/i.test(lower)) {
    return { intent: "question", basis: "rule", matchedRule: "trailing-question" };
  }

  // Insights/status report requests (Deliverable #9). These have no trailing "?",
  // so they would otherwise fall through to capture. Matched verbatim against the
  // forms the question handler recognizes: "insights", "status", "what are my open loops".
  if (/^insights\b/.test(lower) || /^status\b/.test(lower) || /what are my open loops/.test(lower)) {
    return { intent: "question", basis: "rule", matchedRule: "insights-request" };
  }

  return { intent: "capture", basis: "rule", matchedRule: "capture-default" };
}
