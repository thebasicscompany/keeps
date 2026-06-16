/**
 * Provenance (Wave C, SR6) — every automation run carries a one-sentence "Because …" line.
 * Pure + model-free; templates are pinned to the PRD copy.
 */
import type { RecipeKey } from "@/automation/types";

export type ProvenanceContext = {
  attendeeName?: string;
  meetingTimeLabel?: string;
  openLoopCount?: number;
  loopSummary?: string;
  staleDays?: number;
};

const TEMPLATES: Record<RecipeKey, (c: ProvenanceContext) => string> = {
  pre_meeting_brief: (c) =>
    `Because your calendar says you are meeting ${c.attendeeName ?? "someone"}` +
    `${c.meetingTimeLabel ? ` at ${c.meetingTimeLabel}` : ""} and you have ${c.openLoopCount ?? 0} ` +
    `open loop${(c.openLoopCount ?? 0) === 1 ? "" : "s"} with them.`,
  post_meeting_prompt: (c) =>
    `Because your calendar says you just met with ${c.attendeeName ?? "someone"} and no related commitments were captured.`,
  stale_loop_followup: (c) =>
    `Because the loop "${c.loopSummary ?? "this loop"}" has had no activity for ${c.staleDays ?? 7} days and is still open.`,
  self_only_calendar_reminder: () =>
    "Because you explicitly asked Keeps to create a self-only calendar reminder.",
};

export function provenanceLineFor(recipeKey: RecipeKey, ctx: ProvenanceContext = {}): string {
  return TEMPLATES[recipeKey](ctx);
}

export function assertProvenancePresent(line: string): void {
  if (!line || !line.trim()) {
    throw new Error("SR6: every automation run requires a non-empty provenance line");
  }
}
