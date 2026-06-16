/**
 * Calendar context loader (Wave D) — turns the user's connected calendar into the ALREADY-VISIBLE
 * context the pre/post-meeting recipe builders consume. READ-ONLY: it reads calendar metadata
 * (title/attendees/time, never the body) via the Composio reader and matches attendees to entities
 * the user ALREADY has, plus the open loops they ALREADY own. It NEVER creates entities or loops.
 *
 * Visibility: loop/entity lookups are scoped to loops the user owns (always within their canView
 * set), so a brief can only ever surface what the user can already see.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, entities, loopEntities, loops } from "@/db/schema";
import { readCalendarEvents, type CalendarEventMeta } from "@/connectors/calendar-read";

const ACTIVE_LOOP_STATUSES = ["open", "waiting_on_me", "waiting_on_other"] as const;

export type ConnectedCalendar = { connectedAccountId: string; ownerEmail: string | null };

/** The active google_calendar connector account for a user (null if none / disconnected). */
export async function loadConnectedCalendar(userId: string): Promise<ConnectedCalendar | null> {
  const [row] = await getDb()
    .select({
      connectedAccountId: connectorAccounts.composioConnectedAccountId,
      ownerEmail: connectorAccounts.externalAccountEmail,
    })
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, userId),
        eq(connectorAccounts.provider, "google_calendar"),
        eq(connectorAccounts.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

type AttendeeWithLoops = {
  entityId: string;
  displayName: string;
  openLoops: Array<{ id: string; summary: string }>;
};

/** Match attendee emails → person entities the user owns, then attach their OPEN loops. */
async function attendeesWithOpenLoops(
  userId: string,
  attendeeEmails: string[],
): Promise<AttendeeWithLoops[]> {
  if (attendeeEmails.length === 0) return [];
  const db = getDb();

  const ents = await db
    .select({ id: entities.id, displayName: entities.displayName, email: entities.canonicalEmail })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, "person"),
        isNull(entities.mergedIntoEntityId),
        inArray(entities.canonicalEmail, attendeeEmails),
      ),
    );
  if (ents.length === 0) return [];

  const entityIds = ents.map((e) => e.id);
  const loopRows = await db
    .select({ entityId: loopEntities.entityId, loopId: loops.id, summary: loops.summary })
    .from(loopEntities)
    .innerJoin(loops, eq(loops.id, loopEntities.loopId))
    .where(
      and(
        inArray(loopEntities.entityId, entityIds),
        eq(loops.userId, userId),
        inArray(loops.status, [...ACTIVE_LOOP_STATUSES]),
      ),
    );

  const byEntity = new Map<string, Array<{ id: string; summary: string }>>();
  for (const r of loopRows) {
    const list = byEntity.get(r.entityId) ?? [];
    list.push({ id: r.loopId, summary: r.summary });
    byEntity.set(r.entityId, list);
  }
  return ents.map((e) => ({
    entityId: e.id,
    displayName: e.displayName,
    openLoops: byEntity.get(e.id) ?? [],
  }));
}

/** Format a meeting start time for the provenance line (e.g. "Mon 2:00 PM"). */
function meetingTimeLabel(startIso: string | null): string | undefined {
  if (!startIso) return undefined;
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export type PreMeetingCandidate = {
  calendarEventId: string;
  meetingTimeLabel?: string;
  attendees: AttendeeWithLoops[];
};

/**
 * The soonest UPCOMING meeting (within `leadMinutes`) whose attendees include someone the user has
 * open loops with. Returns null when no connected calendar / no qualifying meeting.
 */
export async function loadPreMeetingCandidate(input: {
  userId: string;
  now: Date;
  leadMinutes?: number;
  /** Injectable Composio reader for tests. */
  readEvents?: typeof readCalendarEvents;
}): Promise<PreMeetingCandidate | null> {
  const cal = await loadConnectedCalendar(input.userId);
  if (!cal) return null;
  const leadMinutes = input.leadMinutes ?? 24 * 60; // default: look one day ahead
  const timeMin = input.now;
  const timeMax = new Date(input.now.getTime() + leadMinutes * 60 * 1000);

  const reader = input.readEvents ?? readCalendarEvents;
  const events = await reader({
    keepsUserId: input.userId,
    connectedAccountId: cal.connectedAccountId,
    timeMin,
    timeMax,
  });

  const upcoming = events
    .filter((e) => e.startIso && new Date(e.startIso).getTime() >= input.now.getTime())
    .sort((a, b) => new Date(a.startIso!).getTime() - new Date(b.startIso!).getTime());

  for (const ev of upcoming) {
    const emails = otherAttendees(ev, cal.ownerEmail);
    const attendees = await attendeesWithOpenLoops(input.userId, emails);
    if (attendees.some((a) => a.openLoops.length > 0)) {
      return {
        calendarEventId: ev.id,
        meetingTimeLabel: meetingTimeLabel(ev.startIso),
        attendees,
      };
    }
  }
  return null;
}

export type PostMeetingCandidate = {
  calendarEventId: string;
  attendeeName?: string;
};

/**
 * The most-recent meeting that ENDED within `lookbackMinutes` and had at least one other attendee.
 * (The "was a loop already captured?" absence signal is computed by the builder.) Null if none.
 */
export async function loadPostMeetingCandidate(input: {
  userId: string;
  now: Date;
  lookbackMinutes?: number;
  readEvents?: typeof readCalendarEvents;
}): Promise<PostMeetingCandidate | null> {
  const cal = await loadConnectedCalendar(input.userId);
  if (!cal) return null;
  const lookbackMinutes = input.lookbackMinutes ?? 4 * 60; // default: meetings ended in last 4h
  const timeMin = new Date(input.now.getTime() - lookbackMinutes * 60 * 1000);
  const timeMax = input.now;

  const reader = input.readEvents ?? readCalendarEvents;
  const events = await reader({
    keepsUserId: input.userId,
    connectedAccountId: cal.connectedAccountId,
    timeMin,
    timeMax,
  });

  const ended = events
    .filter((e) => e.endIso && new Date(e.endIso).getTime() <= input.now.getTime())
    .sort((a, b) => new Date(b.endIso!).getTime() - new Date(a.endIso!).getTime());

  for (const ev of ended) {
    const emails = otherAttendees(ev, cal.ownerEmail);
    if (emails.length === 0) continue;
    const matched = await attendeesWithOpenLoops(input.userId, emails);
    const attendeeName = matched[0]?.displayName ?? ev.title;
    return { calendarEventId: ev.id, attendeeName };
  }
  return null;
}

/** Attendee emails minus the calendar owner's own address. */
function otherAttendees(ev: CalendarEventMeta, ownerEmail: string | null): string[] {
  const owner = ownerEmail?.toLowerCase();
  return ev.attendeeEmails.filter((e) => e !== owner);
}
