import { z } from "zod";
import { getKeepsLanguageModel } from "@/agent/model";
import { instrumentedGenerateObject } from "@/agent/instrumented-generate-object";

export type EmailIntent = "capture" | "command" | "approval" | "question" | "correction";

export type ClassifyEmailIntentInput = {
  body: string;
  subject?: string;
};

export type ClassifyEmailIntentResult = {
  intent: EmailIntent;
  basis: "rule" | "model";
  matchedRule?: string;
  /**
   * Set to 'connector_command' when the deterministic pre-rule matches a
   * connector command (e.g. `@Slack ...` or `@Calendar ...` at the start of
   * the email body). The route-email dispatcher uses this to branch into the
   * connector-command handler before reaching the generic command branch.
   *
   * Set to 'insight_command' when the insight pre-rule matches (e.g. "insights",
   * "status", "what are my open loops", "weekly summary", etc.).
   */
  subtype?: "connector_command" | "insight_command";
};

// ---------------------------------------------------------------------------
// Insight-command types & detector
// ---------------------------------------------------------------------------

export type InsightKind = "insights" | "waiting_on" | "stale" | "weekly" | "entity";

/**
 * Deterministic: returns the insight kind if the body is an insight command, else null.
 * For entity-shaped commands returns { kind:"entity", entityCandidate } WITHOUT resolving
 * the entity against any participant list (that is classifyInsightCommand's job).
 */
export function detectInsightCommand(
  body: string,
): { kind: InsightKind; entityCandidate?: string } | null {
  const trimmed = body.trim();

  // insights: "insights", "what are my insights", "what are my insight?"
  if (/^(what are my\s+)?insights?\??$/i.test(trimmed)) {
    return { kind: "insights" };
  }

  // open loops
  if (/^(what are\s+)?(my\s+)?open loops( this week)?\??$/i.test(trimmed)) {
    return { kind: "insights" };
  }

  // status (alone)
  if (/^status\??$/i.test(trimmed)) {
    return { kind: "insights" };
  }

  // waiting_on
  if (/^what (am i|is) waiting on\??$/i.test(trimmed)) {
    return { kind: "waiting_on" };
  }

  // stale
  if (/^(what is stale|stale loops?)\??$/i.test(trimmed)) {
    return { kind: "stale" };
  }

  // weekly
  if (/^weekly (summary|digest)\??$/i.test(trimmed)) {
    return { kind: "weekly" };
  }

  // entity A: "show <entity> loops?"
  const showLoopsMatch = trimmed.match(/^show\s+(.+?)\s+loops?\??$/i);
  if (showLoopsMatch) {
    return { kind: "entity", entityCandidate: showLoopsMatch[1] };
  }

  // entity B: "loops for/with <entity>?"
  const loopsForMatch = trimmed.match(/^loops?\s+(?:for|with)\s+(.+?)\??$/i);
  if (loopsForMatch) {
    return { kind: "entity", entityCandidate: loopsForMatch[1] };
  }

  // entity C: "<entity> status?" — only if NOT "status" alone (already matched above)
  const entityStatusMatch = trimmed.match(/^(.+?)\s+status\??$/i);
  if (entityStatusMatch) {
    return { kind: "entity", entityCandidate: entityStatusMatch[1] };
  }

  // entity D: natural-language status queries. These are the phrasings people
  // actually type ("where do things stand with Acme?", "what's the status of
  // Globex?", "any update on Priya?"). The captured group is the entity
  // candidate; classifyInsightCommand resolves it (and returns "unknown" if it
  // matches no known person/company, so a non-entity question still falls
  // through to the question branch).
  const NL_ENTITY_PATTERNS: RegExp[] = [
    /^where\s+do\s+(?:things|we)\s+stand\s+(?:with|on)\s+(.+?)\??$/i,
    /^where\s+are\s+we\s+(?:with|on)\s+(.+?)\??$/i,
    /^where\s+(?:is|are)\s+(.+?)\s+at\??$/i,
    /^what(?:'s|s| is)\s+the\s+status\s+(?:of|on|with|for)\s+(.+?)\??$/i,
    /^status\s+(?:of|on|with|for)\s+(.+?)\??$/i,
    /^(?:any\s+)?updates?\s+(?:on|with|for|about)\s+(.+?)\??$/i,
    /^how(?:'s|s| is| are)\s+(.+?)\s+(?:going|coming\s+along|progressing|looking)\??$/i,
    /^what(?:'s|s| is)\s+(?:happening|going\s+on)\s+with\s+(.+?)\??$/i,
  ];
  for (const pattern of NL_ENTITY_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return { kind: "entity", entityCandidate: match[1].trim() };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// classifyInsightCommand
// ---------------------------------------------------------------------------

export type InsightClassification =
  | { kind: "insights" | "waiting_on" | "stale" | "weekly"; scope: Record<string, never>; basis: "rule" }
  | { kind: "entity"; scope: { entity: string }; basis: "rule" | "model" }
  | { kind: "unknown"; scope: Record<string, never>; basis: "rule" };

export type ClassifyInsightOptions = {
  useModel?: boolean;
  knownParticipants?: string[];
  /** Test/DI seam. Returns the model-extracted entity, or null if no model/creds. */
  generateEntity?: (text: string) => Promise<{ entity: string } | null>;
};

const defaultGenerateEntity = async (text: string): Promise<{ entity: string } | null> => {
  const model = getKeepsLanguageModel();
  if (!model) return null;
  const result = await instrumentedGenerateObject({
    purpose: "classify_intent",
    model,
    schema: z.object({ kind: z.literal("entity"), entity: z.string() }),
    schemaName: "KeepsInsightEntity",
    system: "Extract the participant or company name the user wants loops for. Return the single entity name.",
    prompt: text,
  });
  const object = result.object as { kind: "entity"; entity: string };
  return { entity: object.entity };
};

export async function classifyInsightCommand(
  text: string,
  opts?: ClassifyInsightOptions,
): Promise<InsightClassification> {
  const d = detectInsightCommand(text);

  if (d === null) {
    return { kind: "unknown", scope: {}, basis: "rule" };
  }

  if (d.kind !== "entity") {
    return { kind: d.kind, scope: {}, basis: "rule" } as InsightClassification;
  }

  // entity resolution
  const candidate = (d.entityCandidate ?? "").trim();
  const participants = opts?.knownParticipants ?? [];

  if (
    candidate.length > 0 &&
    participants.some(
      (p) =>
        p.toLowerCase().includes(candidate.toLowerCase()) ||
        candidate.toLowerCase().includes(p.toLowerCase()),
    )
  ) {
    return { kind: "entity", scope: { entity: candidate }, basis: "rule" };
  }

  if (opts?.useModel) {
    const generateEntity = opts.generateEntity ?? defaultGenerateEntity;
    const ent = await generateEntity(text);
    if (ent?.entity) {
      return { kind: "entity", scope: { entity: ent.entity }, basis: "model" };
    }
  }

  return { kind: "unknown", scope: {}, basis: "rule" };
}

// ---------------------------------------------------------------------------
// classifyEmailIntent
// ---------------------------------------------------------------------------

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

  // ---- CONNECTOR-COMMAND PRE-RULE (Phase 4 B4) ----
  // Deterministic first-line match: if the first NON-EMPTY line of the body starts
  // with @Slack or @Calendar (case-insensitive), classify as command/connector_command
  // without a model call. This intentionally covers only first-line mentions — mid-text
  // mentions like "can you @slack ping Maya?" deliberately fall through to existing rules
  // in V0 (model-classification for mid-text is deferred to a future phase).
  const firstNonEmptyLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
  if (/^\s*@(slack|calendar)\b/i.test(firstNonEmptyLine)) {
    return {
      intent: "command",
      basis: "rule",
      matchedRule: "connector-command",
      subtype: "connector_command",
    };
  }

  // ---- INSIGHT-COMMAND PRE-RULE (Phase 5 A3) ----
  // Placed immediately after the connector pre-rule so connector still wins,
  // but insight commands beat trailing-question, command-prefix, etc.
  if (detectInsightCommand(body) !== null) {
    return {
      intent: "command",
      basis: "rule",
      matchedRule: "insight-command",
      subtype: "insight_command",
    };
  }

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

  return { intent: "capture", basis: "rule", matchedRule: "capture-default" };
}
