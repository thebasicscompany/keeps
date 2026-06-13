/**
 * Google Calendar connector tool module for Keeps.
 *
 * Architecture:
 *   - CalendarTransport — a Google-shaped, Composio-free interface so tests
 *     and future provider swaps never touch business logic.
 *   - createComposioCalendarTransport — real transport using Composio's raw
 *     proxy (composio.tools.proxyExecute) to POST Google Calendar v3
 *     events.insert with full reminder override support.
 *   - createFakeCalendarTransport — deterministic in-memory transport for
 *     unit tests; records every insertEvent call.
 *
 * ENDPOINT CONVENTION (verified against @composio/client types):
 *   The @composio/client ToolProxyParams docs say:
 *     "The API endpoint to call (absolute URL or path relative to base URL of
 *      the connected account)"
 *   The connected account base URL for Google Calendar is
 *   https://www.googleapis.com, NOT a Composio API URL. To avoid any
 *   ambiguity we always pass the absolute URL:
 *     https://www.googleapis.com/calendar/v3/calendars/primary/events
 *   This is unambiguous regardless of what the SDK treats as "base URL".
 *
 * NOTE: This module NEVER checks approvals — the execute funnel (Wave D)
 * authorizes before calling any function here.
 *
 * @see src/connectors/composio.ts — getComposioClient() singleton
 * @see src/agent/schemas.ts — CalendarEventPayload
 */

import { getComposioClient } from "@/connectors/composio";
import type { CalendarEventPayload } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Google Calendar event resource types (subset we care about)
// ---------------------------------------------------------------------------

/**
 * A Google Calendar event resource time boundary as required by the API.
 * @see https://developers.google.com/calendar/api/v3/reference/events#resource
 */
interface GoogleDateTime {
  dateTime: string; // RFC 3339 format e.g. "2026-06-20T15:00:00-07:00"
  timeZone: string; // IANA timezone e.g. "America/Los_Angeles"
}

/**
 * A single Google Calendar reminder override.
 * method "popup" triggers a notification/popup in Google Calendar clients.
 */
interface GoogleReminderOverride {
  method: "popup" | "email" | "sms";
  minutes: number;
}

/**
 * Google Calendar event reminders block.
 * useDefault: false means we supply our own overrides array.
 * useDefault: true means use the calendar's default reminders.
 */
interface GoogleReminders {
  useDefault: boolean;
  overrides?: GoogleReminderOverride[];
}

/**
 * Minimal Google Calendar event resource for events.insert.
 * Only the fields Keeps populates are typed here; Google accepts many more.
 */
interface GoogleEventResource {
  summary: string;
  description?: string;
  start: GoogleDateTime;
  end: GoogleDateTime;
  reminders: GoogleReminders;
}

/**
 * The fields we extract from the Google Calendar API response.
 * The proxy returns the raw Google event resource as res.data.
 * We type this defensively since the proxy wraps generically.
 */
interface GoogleEventInsertResult {
  id: string;
  htmlLink: string;
}

// ---------------------------------------------------------------------------
// CalendarTransport interface
// ---------------------------------------------------------------------------

/**
 * The transport interface for Google Calendar operations.
 * Composio-free: implementations may call Composio, the Google API directly,
 * or a fake store — callers see only this shape.
 */
export interface CalendarTransport {
  /**
   * Inserts a Google Calendar event.
   *
   * @param eventResource - A fully-formed Google Calendar event resource
   * @returns The inserted event's id and htmlLink (URL to open in Calendar)
   */
  insertEvent(eventResource: GoogleEventResource): Promise<GoogleEventInsertResult>;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when executeCalendarEvent is called with a null whenAt.
 * The execute funnel must resolve the date/time before calling this module.
 */
export class CalendarEventMissingWhenError extends Error {
  readonly code = "CALENDAR_EVENT_MISSING_WHEN" as const;

  constructor() {
    super(
      "CalendarEventPayload.whenAt must be non-null at execute time — resolve the event date/time before calling executeCalendarEvent",
    );
    this.name = "CalendarEventMissingWhenError";
  }
}

/**
 * Thrown when the Composio proxy returns an unexpected or missing response.
 */
export class CalendarTransportError extends Error {
  readonly code = "CALENDAR_TRANSPORT_ERROR" as const;

  constructor(
    message: string,
    public readonly status?: number,
    public readonly rawResponse?: unknown,
  ) {
    super(message);
    this.name = "CalendarTransportError";
  }
}

// ---------------------------------------------------------------------------
// Real transport: Composio raw proxy → Google Calendar v3 events.insert
// ---------------------------------------------------------------------------

/**
 * Parameters for constructing the real Composio calendar transport.
 */
export interface ComposioCalendarTransportParams {
  /**
   * The Keeps user UUID — used as the Composio entity/userId for account
   * resolution (though connectedAccountId pinning is our primary auth strategy).
   */
  keepsUserId: string;
  /**
   * The Composio connected account ID (ca_…) for Google Calendar.
   * Always pass this to pin the exact account approved by the user,
   * avoiding any ambiguity when a user has multiple stale accounts.
   */
  connectedAccountId: string;
}

/**
 * Creates the real CalendarTransport backed by Composio's raw proxy.
 *
 * Uses composio.tools.proxyExecute to POST Google Calendar v3 events.insert
 * with the full event resource (including reminder overrides when requested).
 * This bypasses the curated GOOGLECALENDAR_CREATE_EVENT tool, which does NOT
 * expose reminder overrides in its input schema (verified live 2026-06-13 —
 * see RESEARCH-COMPOSIO.md Q5).
 *
 * ENDPOINT: Absolute URL https://www.googleapis.com/calendar/v3/calendars/primary/events
 * Rationale: The @composio/client proxy docs say endpoint can be absolute URL
 * or relative to the connected account's base URL. For Google Calendar the
 * "base URL" is ambiguous (could be the Composio API URL). Absolute URL is
 * unambiguous and matches the Google Calendar REST API spec exactly.
 *
 * RESPONSE: ToolProxyResponse.data contains the raw Google Calendar event
 * resource (not wrapped in response_data — that wrapper is only for curated
 * tool execute calls). We type it defensively and check id/htmlLink.
 *
 * @param params.keepsUserId - Keeps user UUID
 * @param params.connectedAccountId - Composio ca_… id to pin the connection
 */
export function createComposioCalendarTransport(
  params: ComposioCalendarTransportParams,
): CalendarTransport {
  const { connectedAccountId } = params;

  return {
    async insertEvent(eventResource: GoogleEventResource): Promise<GoogleEventInsertResult> {
      const composio = getComposioClient();

      /**
       * Absolute URL per the endpoint convention documented at module top.
       * Google Calendar v3 events.insert on the user's primary calendar.
       * @see https://developers.google.com/calendar/api/v3/reference/events/insert
       */
      const GCAL_INSERT_ENDPOINT =
        "https://www.googleapis.com/calendar/v3/calendars/primary/events";

      let res: Awaited<ReturnType<typeof composio.tools.proxyExecute>>;
      try {
        res = await composio.tools.proxyExecute({
          endpoint: GCAL_INSERT_ENDPOINT,
          method: "POST",
          body: eventResource,
          connectedAccountId,
        });
      } catch (err) {
        throw new CalendarTransportError(
          `Composio proxy network/transport error: ${String(err)}`,
          undefined,
          err,
        );
      }

      if (res.status < 200 || res.status >= 300) {
        throw new CalendarTransportError(
          `Google Calendar API returned HTTP ${res.status}`,
          res.status,
          res.data,
        );
      }

      /**
       * Unwrap the raw Google event resource.
       * ToolProxyResponse.data is typed as `unknown` — we unwrap defensively.
       * The raw Google Calendar events.insert response is the event resource
       * directly (id, htmlLink, etc.) — NOT wrapped in response_data.
       * (response_data wrapping only applies to curated composio.tools.execute calls.)
       */
      const raw = res.data as Record<string, unknown> | null | undefined;

      if (!raw || typeof raw.id !== "string" || typeof raw.htmlLink !== "string") {
        throw new CalendarTransportError(
          "Google Calendar API response missing expected fields (id, htmlLink)",
          res.status,
          raw,
        );
      }

      return {
        id: raw.id,
        htmlLink: raw.htmlLink,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake transport for tests
// ---------------------------------------------------------------------------

/**
 * A recorded insertEvent call — inspect this in tests to assert behavior.
 */
export interface FakeCalendarInsertCall {
  eventResource: GoogleEventResource;
  result: GoogleEventInsertResult;
}

/**
 * The fake CalendarTransport returned by createFakeCalendarTransport().
 * Extends CalendarTransport with test-inspection APIs.
 */
export interface FakeCalendarTransport extends CalendarTransport {
  /**
   * All insertEvent calls recorded in order, including the result returned.
   * Use this in tests to assert event shape and reminder configuration.
   */
  calls: FakeCalendarInsertCall[];
  /**
   * Resets recorded calls — useful when sharing a transport across tests.
   */
  reset(): void;
}

/** Counter for generating deterministic fake event IDs. */
let _fakeEventCounter = 0;

/**
 * Creates an in-memory CalendarTransport for unit tests.
 *
 * - Records every insertEvent call in .calls
 * - Returns deterministic { id, htmlLink } values (no network)
 * - Never throws (unless you explicitly test error paths with a custom impl)
 *
 * @example
 * ```ts
 * const transport = createFakeCalendarTransport();
 * await executeCalendarEvent(payload, user, transport, extras);
 * expect(transport.calls).toHaveLength(1);
 * expect(transport.calls[0].eventResource.reminders.useDefault).toBe(false);
 * ```
 */
export function createFakeCalendarTransport(): FakeCalendarTransport {
  const calls: FakeCalendarInsertCall[] = [];

  return {
    calls,
    reset() {
      calls.splice(0, calls.length);
    },
    async insertEvent(eventResource: GoogleEventResource): Promise<GoogleEventInsertResult> {
      const id = `fake-event-${++_fakeEventCounter}`;
      const result: GoogleEventInsertResult = {
        id,
        htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
      };
      calls.push({ eventResource, result });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Timezone utilities
// ---------------------------------------------------------------------------

/** Fallback timezone when none is configured or the configured one is invalid. */
const DEFAULT_TIMEZONE = "UTC";

/**
 * Resolves the user's IANA timezone string, falling back to 'UTC' if the
 * user has no timezone set or the value is empty.
 *
 * This function does NOT validate that the timezone is a real IANA zone —
 * validation happens implicitly when Intl.DateTimeFormat is constructed.
 * If the IANA zone is invalid, convertToGoogleDateTime falls back to UTC.
 *
 * @param user - An object with a nullable timezone field
 * @returns IANA timezone string, or 'UTC' as fallback
 */
export function resolveTimezone(user: { timezone: string | null }): string {
  if (!user.timezone || user.timezone.trim() === "") {
    return DEFAULT_TIMEZONE;
  }
  return user.timezone.trim();
}

// ---------------------------------------------------------------------------
// ISO timestamp → Google DateTime conversion
// ---------------------------------------------------------------------------

/**
 * Converts an ISO 8601 timestamp (e.g. "2026-06-20T15:00:00.000Z") to a
 * Google Calendar API dateTime+timeZone pair using the given IANA timezone.
 *
 * Algorithm (no new deps — pure Intl.DateTimeFormat):
 *   1. Parse the ISO string into a Date.
 *   2. Format with Intl.DateTimeFormat using the target IANA timezone and
 *      en-US locale to get local year/month/day/hour/minute/second parts.
 *   3. Reconstruct an RFC 3339 offset string by computing the UTC offset via
 *      the numeric part of the timezone's UTC offset (using a second
 *      Intl.DateTimeFormat with timeZoneName:'shortOffset').
 *   4. Return { dateTime: "YYYY-MM-DDTHH:MM:SS±HH:MM", timeZone: iana }.
 *
 * Falls back to UTC if the IANA timezone string is unrecognized by Intl.
 *
 * Injected `now` is unused here (the function is pure: same ISO + tz = same
 * result). It's accepted by the outer functions that do need it.
 *
 * @param isoString - ISO 8601 timestamp string
 * @param ianaTimezone - IANA timezone string (e.g. "America/Los_Angeles")
 * @returns Google Calendar dateTime + timeZone pair
 */
function convertToGoogleDateTime(
  isoString: string,
  ianaTimezone: string,
): GoogleDateTime {
  const date = new Date(isoString);

  // Try the requested timezone; fall back to UTC on invalid zone.
  let tz = ianaTimezone;
  try {
    // Intl will throw RangeError for invalid timezone identifiers.
    Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = DEFAULT_TIMEZONE;
  }

  // Get all numeric date-time components in the target timezone.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );

  // formatToParts gives us: year, month, day, hour, minute, second (as strings).
  // hour can be "24" when it's midnight in some locales — normalize to "00".
  const year = parts["year"] ?? "0000";
  const month = parts["month"] ?? "01";
  const day = parts["day"] ?? "01";
  const rawHour = parts["hour"] ?? "00";
  const minute = parts["minute"] ?? "00";
  const second = parts["second"] ?? "00";
  const hour = rawHour === "24" ? "00" : rawHour;

  // Compute UTC offset using a short-offset formatter (e.g. "GMT-7" or "GMT+5:30").
  // We compare Date.UTC (the wall-clock millis of our date in the target tz interpreted
  // naively as UTC) vs the actual UTC millis to get the offset.
  // Simpler: reconstruct a Date from the naive local string + UTC, diff the millis.
  const naiveLocalString = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const naiveUtcMs = Date.UTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
    parseInt(second),
  );
  const offsetMinutes = Math.round((naiveUtcMs - date.getTime()) / 60_000);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffsetMinutes / 60)).padStart(2, "0");
  const offsetMins = String(absOffsetMinutes % 60).padStart(2, "0");
  const offsetString = `${offsetSign}${offsetHours}:${offsetMins}`;

  return {
    dateTime: `${naiveLocalString}${offsetString}`,
    timeZone: tz,
  };
}

// ---------------------------------------------------------------------------
// createEvent — builds the Google event resource
// ---------------------------------------------------------------------------

/** Input to createEvent — all optional fields nullable. */
export interface CreateEventInput {
  /** Event title displayed in Google Calendar. */
  summary: string;
  /** Event description (optional, may contain plain text or HTML). */
  description: string | null;
  /** ISO 8601 start timestamp (e.g. "2026-06-20T15:00:00.000Z"). */
  startISO: string;
  /**
   * ISO 8601 end timestamp. If null, durationMinutes is used to compute it.
   * At least one of endISO or durationMinutes must be non-null.
   */
  endISO: string | null;
  /**
   * Duration in minutes from startISO when endISO is null.
   * Defaults to 30 minutes when both endISO and durationMinutes are null.
   */
  durationMinutes: number | null;
  /** IANA timezone for the event (e.g. "America/Los_Angeles"). */
  timeZone: string;
  /**
   * Minutes before the event to show a popup reminder.
   * When null: useDefault: true (use calendar's default reminders).
   * When set: useDefault: false with a single popup override.
   */
  reminderMinutesBefore: number | null;
  /**
   * Keeps loop ID to embed as a back-link in the description.
   * When set, a line is appended to the description: `${appUrl}/loops/<loopId>`
   */
  sourceLoopId: string | null;
  /**
   * App base URL for building the source loop back-link.
   * Not read from env here — caller provides it.
   */
  appUrl: string;
}

/**
 * Builds a Google Calendar event resource from Keeps-structured input.
 *
 * Duration logic:
 *   - endISO provided → use directly
 *   - endISO null, durationMinutes provided → compute end = start + durationMinutes
 *   - Both null → default to 30-minute duration
 *
 * Reminder logic:
 *   - reminderMinutesBefore null → reminders: { useDefault: true }
 *   - reminderMinutesBefore set → reminders: { useDefault: false, overrides: [{ method: 'popup', minutes }] }
 *
 * Description logic:
 *   - description is used as-is when sourceLoopId is null
 *   - When sourceLoopId is set, a back-link line is appended:
 *     "Source loop: <appUrl>/loops/<sourceLoopId>"
 *
 * @param input - CreateEventInput
 * @returns GoogleEventResource ready for events.insert
 */
export function createEvent(input: CreateEventInput): GoogleEventResource {
  const {
    summary,
    description,
    startISO,
    endISO,
    durationMinutes,
    timeZone,
    reminderMinutesBefore,
    sourceLoopId,
    appUrl,
  } = input;

  // Compute end time
  let computedEndISO: string;
  if (endISO !== null) {
    computedEndISO = endISO;
  } else {
    const durationMs = (durationMinutes ?? 30) * 60_000;
    computedEndISO = new Date(new Date(startISO).getTime() + durationMs).toISOString();
  }

  // Convert start/end to Google's dateTime+timeZone format
  const start = convertToGoogleDateTime(startISO, timeZone);
  const end = convertToGoogleDateTime(computedEndISO, timeZone);

  // Build description with optional loop back-link
  let finalDescription: string | undefined;
  const backLink =
    sourceLoopId !== null
      ? `Source loop: ${appUrl}/loops/${sourceLoopId}`
      : null;

  if (description !== null && backLink !== null) {
    finalDescription = `${description}\n\n${backLink}`;
  } else if (description !== null) {
    finalDescription = description;
  } else if (backLink !== null) {
    finalDescription = backLink;
  }

  // Build reminders block
  const reminders: GoogleReminders =
    reminderMinutesBefore !== null
      ? {
          useDefault: false,
          overrides: [{ method: "popup", minutes: reminderMinutesBefore }],
        }
      : { useDefault: true };

  const eventResource: GoogleEventResource = {
    summary,
    start,
    end,
    reminders,
  };

  if (finalDescription !== undefined) {
    eventResource.description = finalDescription;
  }

  return eventResource;
}

// ---------------------------------------------------------------------------
// executeCalendarEvent — orchestrates the full calendar action
// ---------------------------------------------------------------------------

/** Extra context needed to orchestrate a calendar event. */
export interface CalendarEventExtras {
  /** App base URL for the source loop back-link. */
  appUrl: string;
  /** Keeps loop ID to embed in the event description, or null. */
  sourceLoopId: string | null;
}

/** Result returned from a successful executeCalendarEvent call. */
export interface CalendarEventResult {
  /** Google Calendar event ID (e.g. "abc123xyz"). */
  eventId: string;
  /** URL to open the event in Google Calendar. */
  htmlLink: string;
}

/**
 * Orchestrates creating a Google Calendar event from a CalendarEventPayload.
 *
 * Steps:
 *   1. Guard: whenAt must be non-null — throws CalendarEventMissingWhenError otherwise.
 *   2. Resolve IANA timezone from user.timezone (falls back to 'UTC').
 *   3. Convert whenAt ISO string to Google's dateTime+timeZone using Intl.DateTimeFormat.
 *   4. Compute end from durationMinutes (or default 30 min).
 *   5. Build GoogleEventResource via createEvent (handles reminders, description, back-link).
 *   6. Call transport.insertEvent and return { eventId, htmlLink }.
 *
 * This function does NOT check approvals — the Wave D execute funnel handles that.
 *
 * @param payload - CalendarEventPayload from connector_actions.payload
 * @param user - User record with nullable timezone field
 * @param transport - CalendarTransport implementation (real or fake)
 * @param extras - appUrl and sourceLoopId for the description back-link
 * @returns Promise<CalendarEventResult> with the created event's id and URL
 * @throws CalendarEventMissingWhenError if payload.whenAt is null
 * @throws CalendarTransportError if the transport call fails
 */
export async function executeCalendarEvent(
  payload: CalendarEventPayload,
  user: { timezone: string | null },
  transport: CalendarTransport,
  extras: CalendarEventExtras,
): Promise<CalendarEventResult> {
  // Guard: whenAt must be non-null at execute time
  if (payload.whenAt === null) {
    throw new CalendarEventMissingWhenError();
  }

  const ianaTimezone = resolveTimezone(user);

  const eventResource = createEvent({
    summary: payload.eventTitle ?? "Keeps reminder",
    description: payload.description,
    startISO: payload.whenAt,
    endISO: null, // always derive from durationMinutes
    durationMinutes: payload.durationMinutes,
    timeZone: ianaTimezone,
    reminderMinutesBefore: payload.reminderMinutesBefore,
    sourceLoopId: extras.sourceLoopId,
    appUrl: extras.appUrl,
  });

  const result = await transport.insertEvent(eventResource);

  return {
    eventId: result.id,
    htmlLink: result.htmlLink,
  };
}
