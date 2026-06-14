import { z } from "zod";
import { getKeepsLanguageModel } from "@/agent/model";
import { instrumentedGenerateObject } from "@/agent/instrumented-generate-object";
import type { EntityReportSlice } from "@/reports/query";

// ── Minimal local input type (structurally compatible with ReportSections) ───
// We only read totalOpen + sections[].rows[].loop.summary — nothing else.
type SummarizeInputSections = {
  rows: { loop: { summary: string } }[];
}[];

export type SuggestedSummary = {
  headline: string;
  bullets: string[];
};

export type SummarizeInput = {
  totalOpen: number;
  sections: SummarizeInputSections;
  useModel?: boolean;
  /**
   * Test/DI seam. Returns an object whose headline+bullets we read;
   * any extra fields on the returned object are silently dropped.
   * May return null to trigger the deterministic fallback.
   */
  generateSummary?: (input: {
    totalOpen: number;
    topSummaries: string[];
  }) => Promise<{ headline: string; bullets: string[] } | null>;
};

// ── Deterministic fallback ────────────────────────────────────────────────────

function deterministicFallback(
  totalOpen: number,
  topSummaries: string[],
): SuggestedSummary {
  const headline = `You have ${totalOpen} open loop${totalOpen === 1 ? "" : "s"}.`;
  return { headline, bullets: topSummaries };
}

// ── Default model implementation ──────────────────────────────────────────────

async function defaultGenerateSummary(input: {
  totalOpen: number;
  topSummaries: string[];
}): Promise<{ headline: string; bullets: string[] } | null> {
  const model = getKeepsLanguageModel();
  if (!model) return null;

  const result = await instrumentedGenerateObject({
    purpose: "summarize_report",
    model,
    // STRICT schema: all required, no .default()/.optional(), optionality via .nullable()
    schema: z.object({
      headline: z.string(),
      bullets: z.array(z.string()),
    }),
    schemaName: "KeepsReportSummary",
    system:
      "Write a short headline and up to 3 one-line bullets summarizing these already-selected open loops for an email. Do not invent or omit items; only rephrase the provided summaries.",
    prompt: [
      `Open loops: ${input.totalOpen}`,
      "Top items:",
      ...input.topSummaries.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n"),
  });

  // Return ONLY headline + bullets — drop everything else
  const object = result.object as { headline: string; bullets: string[] };
  return { headline: object.headline, bullets: object.bullets };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateSuggestedSummary(
  input: SummarizeInput,
): Promise<SuggestedSummary> {
  const { totalOpen, sections, useModel = false } = input;
  const generateSummary = input.generateSummary ?? defaultGenerateSummary;

  // Compute topSummaries: first up-to-3 row summaries across sections in order.
  // This is the deterministic pre-ranked set; the model can only rephrase, not reorder.
  const topSummaries: string[] = [];
  for (const section of sections) {
    for (const row of section.rows) {
      if (topSummaries.length >= 3) break;
      const s = row.loop.summary;
      if (s) topSummaries.push(s);
    }
    if (topSummaries.length >= 3) break;
  }

  // Deterministic path
  if (!useModel) {
    return deterministicFallback(totalOpen, topSummaries);
  }

  // Never hand the model an empty top-items list — with nothing to rephrase it
  // hallucinates (the Phase 5 live wave produced a "Top items: [no additional details
  // provided]" bullet from an empty list). With no items, the deterministic empty-state
  // is correct and honest.
  if (topSummaries.length === 0) {
    return deterministicFallback(totalOpen, topSummaries);
  }

  // Model path
  let modelResult: { headline: string; bullets: string[] } | null = null;
  try {
    modelResult = await generateSummary({ totalOpen, topSummaries });
  } catch {
    // If the model throws, fall back to deterministic
    return deterministicFallback(totalOpen, topSummaries);
  }

  if (modelResult === null) {
    return deterministicFallback(totalOpen, topSummaries);
  }

  // Read ONLY headline + bullets from whatever the model returned.
  // Coerce/guard each field; ignore all other fields on the object.
  const rawHeadline =
    typeof modelResult.headline === "string" ? modelResult.headline.trim() : "";
  const headline =
    rawHeadline.length > 0
      ? rawHeadline
      : deterministicFallback(totalOpen, topSummaries).headline;

  const rawBullets = Array.isArray(modelResult.bullets)
    ? modelResult.bullets.filter((b): b is string => typeof b === "string").slice(0, 3)
    : [];
  const bullets = rawBullets.length > 0 ? rawBullets : topSummaries;

  // Return ONLY headline + bullets — the model boundary
  return { headline, bullets };
}

// ── Entity status synthesis (Phase 7 C1) ──────────────────────────────────────
//
// The model writes ONLY a short human STATUS over the FIXED entity slice (AR-8): a 1–2
// sentence headline + a short state phrase. It may reference only the provided loop
// summaries/ids — assembleEntityReport decided the slice. No creds → deterministic
// structured status. Both honor the same boundary.

/** The short, recognized states the entity status collapses to. */
export type EntityStatusState =
  | "waiting on them"
  | "ball in your court"
  | "stalled"
  | "mostly done"
  | "no open items";

export type EntityStatusSummary = {
  /** 1–2 sentence human status. */
  headline: string;
  /** Short state phrase. */
  state: string;
  /** Structured open/closed counts (always deterministic, never model-authored). */
  openCount: number;
  closedCount: number;
};

/**
 * Deterministic state classification over the slice — used BOTH for the no-creds fallback
 * and as the state the model is asked to choose from (the model never invents a state).
 */
function classifyEntityState(slice: EntityReportSlice): EntityStatusState {
  if (slice.openCount === 0) {
    return slice.closedCount > 0 ? "mostly done" : "no open items";
  }
  // Any open loop the user owns or is awaited on → their court; else waiting on them.
  const ownerOpen = slice.openLoops.some((l) => l.roles.includes("owner"));
  const waitingOnMe = slice.openLoops.some((l) => l.status === "waiting_on_me");
  if (waitingOnMe || ownerOpen) return "ball in your court";
  const allWaitingOnOther = slice.openLoops.every(
    (l) => l.status === "waiting_on_other" || l.status === "snoozed",
  );
  if (allWaitingOnOther) return "waiting on them";
  return "stalled";
}

function deterministicEntityStatus(slice: EntityReportSlice): EntityStatusSummary {
  const { displayName } = slice.entity;
  const state = classifyEntityState(slice);
  const latest = slice.openLoops[0] ?? slice.closedLoops[0] ?? null;
  const latestClause = latest ? `; latest: ${latest.summary}` : "";
  const headline =
    `${displayName}: ${slice.openCount} open, ${slice.closedCount} closed${latestClause}.`;
  return { headline, state, openCount: slice.openCount, closedCount: slice.closedCount };
}

export type GenerateEntityStatusInput = {
  slice: EntityReportSlice;
  useModel?: boolean;
  /**
   * Test/DI seam. Returns the model's status (headline + state) or null to trigger the
   * deterministic fallback. Any extra fields on the returned object are dropped.
   */
  generateStatus?: (input: {
    displayName: string;
    openCount: number;
    closedCount: number;
    state: EntityStatusState;
    openSummaries: string[];
    closedSummaries: string[];
  }) => Promise<{ headline: string; state: string } | null>;
};

async function defaultGenerateEntityStatus(input: {
  displayName: string;
  openCount: number;
  closedCount: number;
  state: EntityStatusState;
  openSummaries: string[];
  closedSummaries: string[];
}): Promise<{ headline: string; state: string } | null> {
  const model = getKeepsLanguageModel();
  if (!model) return null;

  const result = await instrumentedGenerateObject({
    purpose: "summarize_entity",
    model,
    // STRICT schema: all required, optionality via .nullable() only.
    schema: z.object({
      headline: z.string(),
      state: z.string(),
    }),
    schemaName: "KeepsEntityStatus",
    system:
      "Write a 1-2 sentence status for ONE entity over their already-selected loops, plus a short state phrase. Do not invent or omit loops; only rephrase the provided summaries. Use the suggested state unless the provided loops clearly contradict it.",
    prompt: [
      `Entity: ${input.displayName}`,
      `Open loops: ${input.openCount}, Closed loops: ${input.closedCount}`,
      `Suggested state: ${input.state}`,
      "Open items:",
      ...input.openSummaries.map((s, i) => `${i + 1}. ${s}`),
      "Recently closed:",
      ...input.closedSummaries.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n"),
  });

  const object = result.object as { headline: string; state: string };
  return { headline: object.headline, state: object.state };
}

export async function generateEntityStatusSummary(
  input: GenerateEntityStatusInput,
): Promise<EntityStatusSummary> {
  const { slice, useModel = false } = input;
  const generateStatus = input.generateStatus ?? defaultGenerateEntityStatus;

  const fallback = deterministicEntityStatus(slice);

  // Deterministic path (default + no-creds): structured status. Tests rely on this.
  if (!useModel) {
    return fallback;
  }

  // Don't hand the model an entity with zero loops — nothing to rephrase, it hallucinates.
  if (slice.openCount === 0 && slice.closedCount === 0) {
    return fallback;
  }

  const openSummaries = slice.openLoops.slice(0, 5).map((l) => l.summary);
  const closedSummaries = slice.closedLoops.slice(0, 3).map((l) => l.summary);

  let modelResult: { headline: string; state: string } | null = null;
  try {
    modelResult = await generateStatus({
      displayName: slice.entity.displayName,
      openCount: slice.openCount,
      closedCount: slice.closedCount,
      state: fallback.state as EntityStatusState,
      openSummaries,
      closedSummaries,
    });
  } catch {
    return fallback;
  }

  if (modelResult === null) {
    return fallback;
  }

  const rawHeadline =
    typeof modelResult.headline === "string" ? modelResult.headline.trim() : "";
  const headline = rawHeadline.length > 0 ? rawHeadline : fallback.headline;

  const rawState = typeof modelResult.state === "string" ? modelResult.state.trim() : "";
  const state = rawState.length > 0 ? rawState : fallback.state;

  // Counts are ALWAYS the deterministic slice values — never model-authored.
  return { headline, state, openCount: slice.openCount, closedCount: slice.closedCount };
}
