/**
 * Calendar READ (Wave D) — the one genuinely-new connector capability for V2.
 *
 * Recipes 1 & 2 trigger from calendar METADATA (title, attendees, start/end). This is
 * READ-ONLY → deliberately NOT in ACTION_REGISTRY: no approval, no execute-once, no side
 * effect. It reads ONLY metadata, NEVER the event description/body (capture-scope boundary).
 *
 * VERIFY against the live Composio account: the `GOOGLECALENDAR_EVENTS_LIST` slug must exist
 * in the pinned googlecalendar toolkit version. If it does not, swap only the body of
 * `readCalendarEvents` for a thin direct Google Calendar API call — the interface and the
 * pure `mapCalendarEvents` mapping below stay unchanged (triggers depend on those, not on
 * the transport).
 */
import { executeComposioTool } from "@/connectors/composio";

export type CalendarEventMeta = {
  id: string;
  title: string;
  startIso: string | null;
  endIso: string | null;
  /** Attendee emails, lowercased. Google includes the organizer; callers filter as needed. */
  attendeeEmails: string[];
};

const CALENDAR_EVENTS_LIST_SLUG = "GOOGLECALENDAR_EVENTS_LIST";

/**
 * Pure mapping of the Composio EVENTS_LIST payload → metadata-only CalendarEventMeta[].
 * Composio nests the provider payload under `response_data` (mirrors mapCalendarResult).
 * Description/body is intentionally never read.
 */
export function mapCalendarEvents(data: Record<string, unknown>): CalendarEventMeta[] {
  const responseData = ((data?.response_data as Record<string, unknown>) ?? data) ?? {};
  const items = Array.isArray(responseData.items) ? responseData.items : [];
  const out: CalendarEventMeta[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    if (!id) continue;
    const start = e.start as Record<string, unknown> | undefined;
    const end = e.end as Record<string, unknown> | undefined;
    const startIso =
      (typeof start?.dateTime === "string" ? start.dateTime : null) ??
      (typeof start?.date === "string" ? start.date : null);
    const endIso =
      (typeof end?.dateTime === "string" ? end.dateTime : null) ??
      (typeof end?.date === "string" ? end.date : null);
    const attendees = Array.isArray(e.attendees) ? e.attendees : [];
    const attendeeEmails = attendees
      .map((a) => (a && typeof a === "object" ? (a as { email?: unknown }).email : null))
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.toLowerCase());
    out.push({
      id,
      title: typeof e.summary === "string" ? e.summary : "(no title)",
      startIso,
      endIso,
      attendeeEmails,
    });
  }
  return out;
}

export async function readCalendarEvents(input: {
  keepsUserId: string;
  connectedAccountId: string;
  timeMin: Date;
  timeMax: Date;
  /** Injectable transport for tests; defaults to the real Composio pass-through. */
  execute?: typeof executeComposioTool;
}): Promise<CalendarEventMeta[]> {
  const exec = input.execute ?? executeComposioTool;
  const result = await exec(CALENDAR_EVENTS_LIST_SLUG, {
    userId: input.keepsUserId,
    connectedAccountId: input.connectedAccountId,
    arguments: {
      calendar_id: "primary",
      time_min: input.timeMin.toISOString(),
      time_max: input.timeMax.toISOString(),
      single_events: true,
      order_by: "startTime",
    },
  });
  if (!result.successful) {
    throw new Error(`calendar read failed: ${result.error ?? "unknown"}`);
  }
  return mapCalendarEvents(result.data);
}
