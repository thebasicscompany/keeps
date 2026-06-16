/**
 * Recipe builders (Wave D) — PURE functions mapping ALREADY-LOADED, already-visible context
 * to the intended actions + provenance + draft for a sandbox plan. They never read new data,
 * decide permission, or escalate — the sweep loads context, the planner/executor + authorize()
 * own permission (SR5). Each returns null when the recipe should not fire for this trigger.
 */
import type { IntendedAction } from "@/automation/sandbox-plan";
import type { ProvenanceContext } from "@/automation/provenance";

export type RecipePlanInput = {
  intendedActions: IntendedAction[];
  provenanceContext: ProvenanceContext;
  contextUsed: { loopIds?: string[]; entityIds?: string[]; eventIds?: string[]; calendarEventId?: string };
  draft: { subject: string; body: string };
};

// ── Recipe 1: pre-meeting brief ──────────────────────────────────────────────
export type PreMeetingContext = {
  userId: string;
  calendarEventId: string;
  meetingTimeLabel?: string;
  attendees: Array<{
    entityId: string;
    displayName: string;
    openLoops: Array<{ id: string; summary: string }>;
  }>;
};

export function buildPreMeetingBrief(ctx: PreMeetingContext): RecipePlanInput | null {
  const withLoops = ctx.attendees.filter((a) => a.openLoops.length > 0);
  if (withLoops.length === 0) return null; // no brief for events with no matching loops
  const loops = withLoops.flatMap((a) => a.openLoops);
  const primary = withLoops[0];
  const lines = loops.map((l, i) => `${i + 1}. ${l.summary}`);
  return {
    intendedActions: [
      { kind: "send_private_email_to_user", target: { userId: ctx.userId, calendarEventId: ctx.calendarEventId } },
    ],
    provenanceContext: {
      attendeeName: primary.displayName,
      meetingTimeLabel: ctx.meetingTimeLabel,
      openLoopCount: loops.length,
    },
    contextUsed: {
      loopIds: loops.map((l) => l.id),
      entityIds: withLoops.map((a) => a.entityId),
      calendarEventId: ctx.calendarEventId,
    },
    draft: { subject: `Pre-meeting brief: ${primary.displayName}`, body: `Open loops:\n${lines.join("\n")}` },
  };
}

// ── Recipe 2: post-meeting capture prompt ────────────────────────────────────
export type PostMeetingContext = {
  userId: string;
  calendarEventId: string;
  attendeeName?: string;
  hasRecentCapturedLoop: boolean;
};

export function buildPostMeetingPrompt(ctx: PostMeetingContext): RecipePlanInput | null {
  if (ctx.hasRecentCapturedLoop) return null; // a related loop was already captured
  return {
    intendedActions: [
      { kind: "send_private_email_to_user", target: { userId: ctx.userId, calendarEventId: ctx.calendarEventId } },
    ],
    provenanceContext: { attendeeName: ctx.attendeeName },
    contextUsed: { calendarEventId: ctx.calendarEventId },
    // NEVER claims commitments exist — only asks.
    draft: {
      subject: "Anything to capture from your meeting?",
      body: `You just met${ctx.attendeeName ? ` with ${ctx.attendeeName}` : ""}. If there's anything to track, reply with the notes and I'll capture it.`,
    },
  };
}

// ── Recipe 3: stale-loop follow-up draft ─────────────────────────────────────
export type StaleLoopContext = {
  userId: string;
  loop: { id: string; summary: string };
  staleDays: number;
  entityName?: string;
};

export function buildStaleLoopFollowup(ctx: StaleLoopContext): RecipePlanInput {
  return {
    intendedActions: [
      { kind: "send_private_email_to_user", target: { userId: ctx.userId, loopId: ctx.loop.id } },
      { kind: "create_private_report", target: { loopId: ctx.loop.id } },
    ],
    provenanceContext: { loopSummary: ctx.loop.summary, staleDays: ctx.staleDays },
    contextUsed: { loopIds: [ctx.loop.id] },
    draft: {
      subject: `Follow-up draft: ${ctx.loop.summary}`,
      body: `No activity for ${ctx.staleDays} days. Reply "done", "snooze 1 until Friday", or approve an external send.`,
    },
  };
}

// ── Recipe 4: self-only calendar reminder ────────────────────────────────────
export type SelfOnlyReminderContext = {
  userId: string;
  eventTitle: string;
  /** ISO 8601 start time. */
  whenAtIso: string;
  durationMinutes: number;
  loopId?: string;
};

/**
 * Build a SELF-ONLY calendar reminder (no attendees → never externally visible, so the grant can
 * auto-allow it per SR8). The connector dispatch reads the event spec off the action target.
 */
export function buildSelfOnlyCalendarReminder(ctx: SelfOnlyReminderContext): RecipePlanInput {
  return {
    intendedActions: [
      {
        kind: "create_calendar_event",
        target: {
          eventTitle: ctx.eventTitle,
          whenAt: ctx.whenAtIso,
          durationMinutes: ctx.durationMinutes,
          ...(ctx.loopId ? { loopId: ctx.loopId } : {}),
        },
      },
    ],
    provenanceContext: {},
    contextUsed: ctx.loopId ? { loopIds: [ctx.loopId] } : {},
    draft: { subject: ctx.eventTitle, body: `Self-only reminder at ${ctx.whenAtIso}.` },
  };
}

export type SelfOnlyCalendarBounds = { maxDurationMinutes?: number; maxLookaheadDays?: number };

export function selfOnlyCalendarWithinBounds(input: {
  attendees: unknown[];
  durationMinutes: number;
  lookaheadDays: number;
  bounds?: SelfOnlyCalendarBounds;
}): { ok: true } | { ok: false; reason: string } {
  if (input.attendees.length > 0) return { ok: false, reason: "has attendees" };
  const maxDuration = input.bounds?.maxDurationMinutes ?? 60;
  const maxLookahead = input.bounds?.maxLookaheadDays ?? 180;
  if (input.durationMinutes > maxDuration) return { ok: false, reason: `exceeds max duration ${maxDuration}m` };
  if (input.lookaheadDays > maxLookahead) return { ok: false, reason: `exceeds max lookahead ${maxLookahead}d` };
  return { ok: true };
}
