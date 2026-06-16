/**
 * Recipe plan-input builder (Wave D) — SHARED by the Inngest planner (handle-automation-trigger)
 * and the synchronous "Run now" orchestrator (run-now). Loads each recipe's ALREADY-VISIBLE
 * context (by triggerRef / connected calendar) and hands it to the pure recipe builder, returning
 * the RecipePlanInput a sandbox plan is built from — or null when the recipe should not fire
 * (no stale loop, no qualifying meeting, no connected calendar, etc.).
 *
 * SR5: this only LOADS context + calls pure builders. Permission lives in the planner/executor.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loops } from "@/db/schema";
import {
  buildPostMeetingPrompt,
  buildPreMeetingBrief,
  buildSelfOnlyCalendarReminder,
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
    const res = await loadPreMeetingCandidate({ userId: ctx.userId, now: ctx.now, leadMinutes });
    if (!res.hasCalendar) return { ok: false, reason: "Connect Google Calendar first (Settings → Connectors)." };
    if (!res.candidate) {
      return {
        ok: false,
        reason:
          res.eventsRead === 0
            ? "No meetings on your calendar in the next 24h."
            : `Read ${res.eventsRead} upcoming meeting(s), but none are with someone you have open loops with.`,
      };
    }
    const input = buildPreMeetingBrief({
      userId: ctx.userId,
      calendarEventId: res.candidate.calendarEventId,
      meetingTimeLabel: res.candidate.meetingTimeLabel,
      attendees: res.candidate.attendees,
    });
    if (!input) return { ok: false, reason: "no open loops for the meeting attendees" };
    return { ok: true, input, triggerRef: res.candidate.calendarEventId };
  }

  if (recipeKey === "post_meeting_prompt") {
    const lookbackMinutes =
      typeof ctx.context?.lookbackMinutes === "number" ? ctx.context.lookbackMinutes : undefined;
    const res = await loadPostMeetingCandidate({ userId: ctx.userId, now: ctx.now, lookbackMinutes });
    if (!res.hasCalendar) return { ok: false, reason: "Connect Google Calendar first (Settings → Connectors)." };
    if (!res.candidate) {
      return {
        ok: false,
        reason:
          res.eventsRead === 0
            ? "No meetings ended on your calendar in the last 4h."
            : `Read ${res.eventsRead} recent meeting(s), but none had another attendee to prompt about.`,
      };
    }
    const input = buildPostMeetingPrompt({
      userId: ctx.userId,
      calendarEventId: res.candidate.calendarEventId,
      attendeeName: res.candidate.attendeeName,
      // Absence signal: a stricter "was a loop already captured?" check can tighten this later.
      hasRecentCapturedLoop: false,
    });
    if (!input) return { ok: false, reason: "a related loop was already captured" };
    return { ok: true, input, triggerRef: res.candidate.calendarEventId };
  }

  if (recipeKey === "self_only_calendar_reminder") {
    // Tie the reminder to the user's longest-idle open loop so it's meaningful; fall back to a
    // generic reminder if they have none. Self-only (no attendees) → grant auto-allows (SR8).
    const ACTIVE = ["open", "waiting_on_me", "waiting_on_other"] as const;
    const [loop] = await getDb()
      .select({ id: loops.id, summary: loops.summary })
      .from(loops)
      .where(and(eq(loops.userId, ctx.userId), inArray(loops.status, [...ACTIVE])))
      .orderBy(asc(loops.updatedAt))
      .limit(1);
    const whenAtIso = new Date(ctx.now.getTime() + 60 * 60 * 1000).toISOString(); // +1h
    const eventTitle = loop ? `Follow up: ${loop.summary}` : "Keeps reminder";
    const input = buildSelfOnlyCalendarReminder({
      userId: ctx.userId,
      eventTitle,
      whenAtIso,
      durationMinutes: 30,
      ...(loop ? { loopId: loop.id } : {}),
    });
    return { ok: true, input, triggerRef: loop?.id ?? null };
  }

  return { ok: false, reason: `recipe ${recipeKey} is not run-now eligible` };
}
