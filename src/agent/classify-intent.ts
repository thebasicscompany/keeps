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

  if (/^(confirm|dismiss\s+\d+|remind me\b|mark\s+\d+\s+done)\b/.test(lower)) {
    return { intent: "command", basis: "rule", matchedRule: "command-prefix" };
  }

  if (/^(approve|approved|yes,?\s+approve)\b/.test(lower)) {
    return { intent: "approval", basis: "rule", matchedRule: "approval-prefix" };
  }

  if (/\?$/.test(lower) && !/(can you|could you|please|need to|waiting on)/i.test(lower)) {
    return { intent: "question", basis: "rule", matchedRule: "trailing-question" };
  }

  return { intent: "capture", basis: "rule", matchedRule: "capture-default" };
}
