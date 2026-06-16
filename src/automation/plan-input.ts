/**
 * Recipe plan-input builder (Wave D) — SHARED by the Inngest planner (handle-automation-trigger)
 * and the synchronous "Run now" orchestrator (run-now). Loads each recipe's ALREADY-VISIBLE
 * context (by triggerRef / connected calendar) and hands it to the pure recipe builder, returning
 * the RecipePlanInput a sandbox plan is built from — or null when the recipe should not fire
 * (no stale loop, no qualifying meeting, no connected calendar, etc.).
 *
 * SR5: this only LOADS context + calls pure builders. Permission lives in the planner/executor.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loops } from "@/db/schema";
import {
  buildPostMeetingPrompt,
  buildPreMeetingBrief,
  buildStaleLoopFollowup,
  type RecipePlanInput,
} from "@/automation/recipes/builders";
import { loadPreMeetingCandidate, loadPostMeetingCandidate } from "@/automation/calendar-context";

export type PlanInputContext = {
  userId: string;
  triggerRef?: string;
  context?: Record<string, unknown>;
  now: Date;
};

export type PlanInputResult =
  | { ok: true; input: RecipePlanInput; triggerRef: string | null }
  | { ok: false; reason: string };

/**
 * Build the plan input for a recipe + trigger. Returns `{ ok: false, reason }` (not a throw) so the
 * caller can persist a skipped run with a human reason — the same reason the UI surfaces.
 */
export async function buildPlanInputForRecipe(
  recipeKey: string,
  ctx: PlanInputContext,
): Promise<PlanInputResult> {
  if (recipeKey === "stale_loop_followup") {
    if (!ctx.triggerRef) return { ok: false, reason: "no stale loop to follow up" };
    const [loop] = await getDb()
      .select({ id: loops.id, summary: loops.summary })
      .from(loops)
      .where(and(eq(loops.id, ctx.triggerRef), eq(loops.userId, ctx.userId)))
      .limit(1);
    if (!loop) return { ok: false, reason: "loop not found or not yours" };
    const staleDays = typeof ctx.context?.staleDays === "number" ? ctx.context.staleDays : 7;
    return { ok: true, input: buildStaleLoopFollowup({ userId: ctx.userId, loop, staleDays }), triggerRef: loop.id };
  }

  if (recipeKey === "pre_meeting_brief") {
    const leadMinutes = typeof ctx.context?.leadMinutes === "number" ? ctx.context.leadMinutes : undefined;
    const candidate = await loadPreMeetingCandidate({ userId: ctx.userId, now: ctx.now, leadMinutes });
    if (!candidate) return { ok: false, reason: "no upcoming meeting with open loops" };
    const input = buildPreMeetingBrief({
      userId: ctx.userId,
      calendarEventId: candidate.calendarEventId,
      meetingTimeLabel: candidate.meetingTimeLabel,
      attendees: candidate.attendees,
    });
    if (!input) return { ok: false, reason: "no open loops for the meeting attendees" };
    return { ok: true, input, triggerRef: candidate.calendarEventId };
  }

  if (recipeKey === "post_meeting_prompt") {
    const lookbackMinutes =
      typeof ctx.context?.lookbackMinutes === "number" ? ctx.context.lookbackMinutes : undefined;
    const candidate = await loadPostMeetingCandidate({ userId: ctx.userId, now: ctx.now, lookbackMinutes });
    if (!candidate) return { ok: false, reason: "no recently-ended meeting" };
    const input = buildPostMeetingPrompt({
      userId: ctx.userId,
      calendarEventId: candidate.calendarEventId,
      attendeeName: candidate.attendeeName,
      // Absence signal: a stricter "was a loop already captured?" check can tighten this later.
      hasRecentCapturedLoop: false,
    });
    if (!input) return { ok: false, reason: "a related loop was already captured" };
    return { ok: true, input, triggerRef: candidate.calendarEventId };
  }

  // self_only_calendar_reminder is driven by the explicit @Calendar command path, not a sweep.
  return { ok: false, reason: `recipe ${recipeKey} is not run-now eligible` };
}
