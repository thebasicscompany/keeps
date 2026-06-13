import { generateObject } from "ai";
import { z } from "zod";
import { getKeepsLanguageModel } from "@/agent/model";

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

  const result = await generateObject({
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
  return { headline: result.object.headline, bullets: result.object.bullets };
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
