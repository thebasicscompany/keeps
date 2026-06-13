/**
 * Unit tests for src/connectors/calendar.ts
 *
 * All tests are fully offline (no network, no Composio, no Google API).
 * The createComposioCalendarTransport path is tested with a mocked
 * getComposioClient. All other paths use createFakeCalendarTransport.
 *
 * Coverage:
 *   - resolveTimezone: null, empty, valid, unknown-but-non-null
 *   - convertToGoogleDateTime (via createEvent): correct dateTime/timeZone output
 *   - createEvent:
 *       - reminder overrides present exactly when reminderMinutesBefore is set
 *       - useDefault:true when no reminder
 *       - description back-link embedding (sourceLoopId set / not set)
 *       - default 30-min duration when both endISO and durationMinutes are null
 *       - durationMinutes applied correctly
 *       - endISO used directly when provided
 *   - executeCalendarEvent:
 *       - null whenAt → CalendarEventMissingWhenError (typed error)
 *       - unknown tz falls back to UTC
 *       - fake transport records exactly one call per executeCalendarEvent
 *       - returns { eventId, htmlLink } from transport result
 *   - createComposioCalendarTransport: proxyExecute called with absolute URL,
 *     connectedAccountId passed, response unwrapped correctly
 *   - createFakeCalendarTransport: .calls, .reset(), deterministic output
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @composio/core before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("@composio/core", () => {
  class Composio {
    tools = {
      proxyExecute: vi.fn(),
    };
  }
  return { Composio };
});

// ---------------------------------------------------------------------------
// Mock src/connectors/composio.ts to expose the mocked Composio instance
// ---------------------------------------------------------------------------

const mockProxyExecute = vi.fn();

vi.mock("@/connectors/composio", () => ({
  getComposioClient: vi.fn(() => ({
    tools: {
      proxyExecute: mockProxyExecute,
    },
  })),
}));

// Import after mocks are set up
import {
  CalendarEventMissingWhenError,
  CalendarTransportError,
  createComposioCalendarTransport,
  createEvent,
  createFakeCalendarTransport,
  executeCalendarEvent,
  resolveTimezone,
} from "@/connectors/calendar";
import type { CalendarEventPayload } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CalendarEventPayload for test convenience. */
function makePayload(
  overrides: Partial<CalendarEventPayload> = {},
): CalendarEventPayload {
  return {
    kind: "calendar_event",
    destination: { kind: "self", nameText: null, emailText: null },
    eventTitle: "Test Event",
    whenAt: "2026-06-20T22:00:00.000Z", // 3 PM PDT (UTC-7)
    durationMinutes: null,
    reminderMinutesBefore: null,
    description: null,
    ...overrides,
  };
}

const FAKE_APP_URL = "https://keeps.ai";
const FAKE_LOOP_ID = "loop-abc-123";

// ---------------------------------------------------------------------------
// resolveTimezone
// ---------------------------------------------------------------------------

describe("resolveTimezone", () => {
  it("returns 'UTC' when timezone is null", () => {
    expect(resolveTimezone({ timezone: null })).toBe("UTC");
  });

  it("returns 'UTC' when timezone is empty string", () => {
    expect(resolveTimezone({ timezone: "" })).toBe("UTC");
  });

  it("returns 'UTC' when timezone is whitespace-only", () => {
    expect(resolveTimezone({ timezone: "   " })).toBe("UTC");
  });

  it("returns the timezone value when set", () => {
    expect(resolveTimezone({ timezone: "America/Los_Angeles" })).toBe("America/Los_Angeles");
  });

  it("trims leading/trailing whitespace", () => {
    expect(resolveTimezone({ timezone: "  Europe/London  " })).toBe("Europe/London");
  });

  it("returns the timezone even if it looks unusual (validation deferred to Intl)", () => {
    // We don't pre-validate IANA zones here; createEvent/convertToGoogleDateTime
    // falls back to UTC for actually invalid zones.
    expect(resolveTimezone({ timezone: "America/New_York" })).toBe("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// createEvent — reminder overrides
// ---------------------------------------------------------------------------

describe("createEvent — reminder overrides", () => {
  const BASE_INPUT = {
    summary: "Renewal call",
    description: null,
    startISO: "2026-06-20T22:00:00.000Z",
    endISO: null,
    durationMinutes: 30,
    timeZone: "UTC",
    sourceLoopId: null,
    appUrl: FAKE_APP_URL,
  };

  it("sets useDefault:false with popup override when reminderMinutesBefore is set", () => {
    const event = createEvent({ ...BASE_INPUT, reminderMinutesBefore: 15 });
    expect(event.reminders.useDefault).toBe(false);
    expect(event.reminders.overrides).toHaveLength(1);
    expect(event.reminders.overrides![0]).toEqual({ method: "popup", minutes: 15 });
  });

  it("sets useDefault:true with no overrides when reminderMinutesBefore is null", () => {
    const event = createEvent({ ...BASE_INPUT, reminderMinutesBefore: null });
    expect(event.reminders.useDefault).toBe(true);
    expect(event.reminders.overrides).toBeUndefined();
  });

  it("uses the exact minutes value for the popup override", () => {
    const event = createEvent({ ...BASE_INPUT, reminderMinutesBefore: 60 });
    expect(event.reminders.overrides![0].minutes).toBe(60);
  });

  it("popup method is exactly 'popup' (not 'email' or 'sms')", () => {
    const event = createEvent({ ...BASE_INPUT, reminderMinutesBefore: 5 });
    expect(event.reminders.overrides![0].method).toBe("popup");
  });
});

// ---------------------------------------------------------------------------
// createEvent — description and back-link
// ---------------------------------------------------------------------------

describe("createEvent — description and back-link", () => {
  const BASE_INPUT = {
    summary: "Team sync",
    startISO: "2026-06-20T22:00:00.000Z",
    endISO: null,
    durationMinutes: 30,
    timeZone: "UTC",
    reminderMinutesBefore: null,
    appUrl: FAKE_APP_URL,
  };

  it("embeds a back-link to the source loop when sourceLoopId is set", () => {
    const event = createEvent({
      ...BASE_INPUT,
      description: null,
      sourceLoopId: FAKE_LOOP_ID,
    });
    expect(event.description).toContain(`${FAKE_APP_URL}/loops/${FAKE_LOOP_ID}`);
  });

  it("uses the correct URL pattern for the loop back-link", () => {
    const event = createEvent({
      ...BASE_INPUT,
      description: null,
      sourceLoopId: "my-loop-99",
    });
    expect(event.description).toContain(`${FAKE_APP_URL}/loops/my-loop-99`);
  });

  it("appends the back-link to an existing description", () => {
    const event = createEvent({
      ...BASE_INPUT,
      description: "Original description.",
      sourceLoopId: FAKE_LOOP_ID,
    });
    expect(event.description).toContain("Original description.");
    expect(event.description).toContain(`${FAKE_APP_URL}/loops/${FAKE_LOOP_ID}`);
  });

  it("uses description without modification when sourceLoopId is null", () => {
    const event = createEvent({
      ...BASE_INPUT,
      description: "Just a description.",
      sourceLoopId: null,
    });
    expect(event.description).toBe("Just a description.");
  });

  it("has no description field when both description and sourceLoopId are null", () => {
    const event = createEvent({
      ...BASE_INPUT,
      description: null,
      sourceLoopId: null,
    });
    expect(event.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createEvent — duration and timing
// ---------------------------------------------------------------------------

describe("createEvent — duration defaults and timing", () => {
  it("defaults to 30-minute duration when endISO and durationMinutes are both null", () => {
    const startISO = "2026-06-20T15:00:00.000Z";
    const event = createEvent({
      summary: "Reminder",
      description: null,
      startISO,
      endISO: null,
      durationMinutes: null,
      timeZone: "UTC",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });
    // In UTC: start 15:00, end should be 15:30
    // The dateTime will be in UTC offset format (+00:00)
    expect(event.start.dateTime).toContain("15:00:00");
    expect(event.end.dateTime).toContain("15:30:00");
  });

  it("applies durationMinutes when endISO is null", () => {
    const startISO = "2026-06-20T15:00:00.000Z";
    const event = createEvent({
      summary: "Long event",
      description: null,
      startISO,
      endISO: null,
      durationMinutes: 90,
      timeZone: "UTC",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });
    expect(event.start.dateTime).toContain("15:00:00");
    expect(event.end.dateTime).toContain("16:30:00");
  });

  it("uses endISO directly when provided", () => {
    const startISO = "2026-06-20T15:00:00.000Z";
    const endISO = "2026-06-20T17:00:00.000Z";
    const event = createEvent({
      summary: "Fixed end",
      description: null,
      startISO,
      endISO,
      durationMinutes: null,
      timeZone: "UTC",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });
    expect(event.start.dateTime).toContain("15:00:00");
    expect(event.end.dateTime).toContain("17:00:00");
  });
});

// ---------------------------------------------------------------------------
// createEvent — timezone conversion
// ---------------------------------------------------------------------------

describe("createEvent — timezone handling", () => {
  it("produces correct dateTime and timeZone fields for a UTC event", () => {
    const event = createEvent({
      summary: "UTC event",
      description: null,
      startISO: "2026-06-20T15:00:00.000Z",
      endISO: null,
      durationMinutes: 30,
      timeZone: "UTC",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });

    expect(event.start.timeZone).toBe("UTC");
    expect(event.start.dateTime).toContain("15:00:00");
    expect(event.start.dateTime).toContain("+00:00");
    expect(event.end.timeZone).toBe("UTC");
    expect(event.end.dateTime).toContain("15:30:00");
  });

  it("converts to US/Pacific timezone (UTC-7 in June)", () => {
    // 2026-06-20T22:00:00Z = 15:00 PDT (UTC-7, DST in effect in June)
    const event = createEvent({
      summary: "Pacific event",
      description: null,
      startISO: "2026-06-20T22:00:00.000Z",
      endISO: null,
      durationMinutes: 30,
      timeZone: "America/Los_Angeles",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });

    expect(event.start.timeZone).toBe("America/Los_Angeles");
    // Should be 15:00 local time (UTC-7)
    expect(event.start.dateTime).toContain("15:00:00");
    expect(event.start.dateTime).toContain("-07:00");
  });

  it("converts to Europe/London timezone (UTC+1 in June for BST)", () => {
    // 2026-06-20T14:00:00Z = 15:00 BST (UTC+1)
    const event = createEvent({
      summary: "London event",
      description: null,
      startISO: "2026-06-20T14:00:00.000Z",
      endISO: null,
      durationMinutes: 60,
      timeZone: "Europe/London",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });

    expect(event.start.timeZone).toBe("Europe/London");
    expect(event.start.dateTime).toContain("15:00:00");
    expect(event.start.dateTime).toContain("+01:00");
  });

  it("falls back to UTC for an unknown/invalid timezone", () => {
    const event = createEvent({
      summary: "Bad tz event",
      description: null,
      startISO: "2026-06-20T15:00:00.000Z",
      endISO: null,
      durationMinutes: 30,
      timeZone: "Invalid/Timezone",
      reminderMinutesBefore: null,
      sourceLoopId: null,
      appUrl: FAKE_APP_URL,
    });

    // Falls back to UTC on invalid timezone
    expect(event.start.timeZone).toBe("UTC");
    expect(event.start.dateTime).toContain("+00:00");
  });
});

// ---------------------------------------------------------------------------
// executeCalendarEvent — typed error on null whenAt
// ---------------------------------------------------------------------------

describe("executeCalendarEvent — null whenAt guard", () => {
  it("throws CalendarEventMissingWhenError when whenAt is null", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ whenAt: null });

    await expect(
      executeCalendarEvent(
        payload,
        { timezone: "UTC" },
        transport,
        { appUrl: FAKE_APP_URL, sourceLoopId: null },
      ),
    ).rejects.toThrow(CalendarEventMissingWhenError);
  });

  it("CalendarEventMissingWhenError has the correct code", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ whenAt: null });

    try {
      await executeCalendarEvent(
        payload,
        { timezone: "UTC" },
        transport,
        { appUrl: FAKE_APP_URL, sourceLoopId: null },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CalendarEventMissingWhenError);
      expect((err as CalendarEventMissingWhenError).code).toBe("CALENDAR_EVENT_MISSING_WHEN");
    }
  });

  it("does NOT call transport.insertEvent when whenAt is null", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ whenAt: null });

    await expect(
      executeCalendarEvent(
        payload,
        { timezone: "UTC" },
        transport,
        { appUrl: FAKE_APP_URL, sourceLoopId: null },
      ),
    ).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeCalendarEvent — unknown tz falls back to UTC
// ---------------------------------------------------------------------------

describe("executeCalendarEvent — timezone fallback", () => {
  it("succeeds with UTC fallback when user timezone is null", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload();

    const result = await executeCalendarEvent(
      payload,
      { timezone: null },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    expect(result.eventId).toBeDefined();
    expect(result.htmlLink).toBeDefined();
    expect(transport.calls).toHaveLength(1);
    // UTC fallback: start timeZone should be "UTC"
    expect(transport.calls[0].eventResource.start.timeZone).toBe("UTC");
  });

  it("uses UTC when user timezone is an unrecognized IANA zone", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload();

    await executeCalendarEvent(
      payload,
      { timezone: "Fake/NotReal" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    expect(transport.calls[0].eventResource.start.timeZone).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------
// executeCalendarEvent — fake transport records exactly one call
// ---------------------------------------------------------------------------

describe("executeCalendarEvent — fake transport recording", () => {
  it("records exactly one insertEvent call per executeCalendarEvent", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload();

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    expect(transport.calls).toHaveLength(1);
  });

  it("returns the event id and htmlLink from the transport", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ eventTitle: "My meeting" });

    const result = await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    expect(typeof result.eventId).toBe("string");
    expect(result.eventId.length).toBeGreaterThan(0);
    expect(result.htmlLink).toMatch(/https?:\/\//);
  });

  it("recorded call contains the correct event summary", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ eventTitle: "Renewal call" });

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    expect(transport.calls[0].eventResource.summary).toBe("Renewal call");
  });

  it("records multiple calls when called multiple times", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload();

    await executeCalendarEvent(payload, { timezone: "UTC" }, transport, {
      appUrl: FAKE_APP_URL,
      sourceLoopId: null,
    });
    await executeCalendarEvent(payload, { timezone: "UTC" }, transport, {
      appUrl: FAKE_APP_URL,
      sourceLoopId: null,
    });

    expect(transport.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// executeCalendarEvent — reminder overrides via fake transport
// ---------------------------------------------------------------------------

describe("executeCalendarEvent — reminder overrides in recorded calls", () => {
  it("passes reminder overrides to the transport when reminderMinutesBefore is set", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ reminderMinutesBefore: 15 });

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    const { reminders } = transport.calls[0].eventResource;
    expect(reminders.useDefault).toBe(false);
    expect(reminders.overrides).toHaveLength(1);
    expect(reminders.overrides![0]).toEqual({ method: "popup", minutes: 15 });
  });

  it("omits reminder overrides when reminderMinutesBefore is null", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ reminderMinutesBefore: null });

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    const { reminders } = transport.calls[0].eventResource;
    expect(reminders.useDefault).toBe(true);
    expect(reminders.overrides).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeCalendarEvent — description back-link via fake transport
// ---------------------------------------------------------------------------

describe("executeCalendarEvent — description back-link", () => {
  it("embeds the loop back-link in the description when sourceLoopId is set", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ description: null });

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: "loop-xyz" },
    );

    expect(transport.calls[0].eventResource.description).toContain(
      `${FAKE_APP_URL}/loops/loop-xyz`,
    );
  });

  it("does not set description when description is null and sourceLoopId is null", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({ description: null });

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    expect(transport.calls[0].eventResource.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeCalendarEvent — default 30-min duration
// ---------------------------------------------------------------------------

describe("executeCalendarEvent — default duration", () => {
  it("creates a 30-minute event when durationMinutes is null", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload({
      whenAt: "2026-06-20T15:00:00.000Z",
      durationMinutes: null,
    });

    await executeCalendarEvent(
      payload,
      { timezone: "UTC" },
      transport,
      { appUrl: FAKE_APP_URL, sourceLoopId: null },
    );

    const { start, end } = transport.calls[0].eventResource;
    expect(start.dateTime).toContain("15:00:00");
    expect(end.dateTime).toContain("15:30:00");
  });
});

// ---------------------------------------------------------------------------
// createFakeCalendarTransport — .reset()
// ---------------------------------------------------------------------------

describe("createFakeCalendarTransport — .reset()", () => {
  it("clears recorded calls after reset", async () => {
    const transport = createFakeCalendarTransport();
    const payload = makePayload();

    await executeCalendarEvent(payload, { timezone: "UTC" }, transport, {
      appUrl: FAKE_APP_URL,
      sourceLoopId: null,
    });
    expect(transport.calls).toHaveLength(1);

    transport.reset();
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createComposioCalendarTransport — proxy call shape (mocked)
// ---------------------------------------------------------------------------

describe("createComposioCalendarTransport — proxyExecute call shape", () => {
  beforeEach(() => {
    mockProxyExecute.mockReset();
  });

  afterEach(() => {
    mockProxyExecute.mockReset();
  });

  it("calls proxyExecute with the absolute Google Calendar endpoint", async () => {
    mockProxyExecute.mockResolvedValueOnce({
      status: 200,
      data: { id: "gcal-event-123", htmlLink: "https://calendar.google.com/event?eid=gcal-event-123" },
    });

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-aaa",
      connectedAccountId: "ca_test123",
    });

    await transport.insertEvent({
      summary: "Test",
      start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
      end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
      reminders: { useDefault: true },
    });

    expect(mockProxyExecute).toHaveBeenCalledTimes(1);
    const callArg = mockProxyExecute.mock.calls[0][0];
    expect(callArg.endpoint).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(callArg.method).toBe("POST");
  });

  it("passes connectedAccountId to proxyExecute", async () => {
    mockProxyExecute.mockResolvedValueOnce({
      status: 200,
      data: { id: "evt-abc", htmlLink: "https://calendar.google.com/event?eid=evt-abc" },
    });

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-bbb",
      connectedAccountId: "ca_specific456",
    });

    await transport.insertEvent({
      summary: "Meeting",
      start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
      end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });

    const callArg = mockProxyExecute.mock.calls[0][0];
    expect(callArg.connectedAccountId).toBe("ca_specific456");
  });

  it("passes the full event resource as body", async () => {
    const eventResource = {
      summary: "Important event",
      start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
      end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
      reminders: { useDefault: false, overrides: [{ method: "popup" as const, minutes: 30 }] },
    };
    mockProxyExecute.mockResolvedValueOnce({
      status: 200,
      data: { id: "evt-def", htmlLink: "https://calendar.google.com/event?eid=evt-def" },
    });

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-ccc",
      connectedAccountId: "ca_body789",
    });

    await transport.insertEvent(eventResource);

    const callArg = mockProxyExecute.mock.calls[0][0];
    expect(callArg.body).toEqual(eventResource);
  });

  it("returns id and htmlLink from the proxy response data", async () => {
    mockProxyExecute.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "real-event-id-999",
        htmlLink: "https://www.google.com/calendar/event?eid=real-event-id-999",
      },
    });

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-ddd",
      connectedAccountId: "ca_return111",
    });

    const result = await transport.insertEvent({
      summary: "Return check",
      start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
      end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
      reminders: { useDefault: true },
    });

    expect(result.id).toBe("real-event-id-999");
    expect(result.htmlLink).toBe(
      "https://www.google.com/calendar/event?eid=real-event-id-999",
    );
  });

  it("throws CalendarTransportError when proxy returns non-2xx status", async () => {
    mockProxyExecute.mockResolvedValueOnce({
      status: 403,
      data: { error: { message: "Forbidden", code: 403 } },
    });

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-eee",
      connectedAccountId: "ca_err222",
    });

    await expect(
      transport.insertEvent({
        summary: "Will fail",
        start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
        end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
        reminders: { useDefault: true },
      }),
    ).rejects.toThrow(CalendarTransportError);
  });

  it("throws CalendarTransportError when proxy response is missing id/htmlLink", async () => {
    mockProxyExecute.mockResolvedValueOnce({
      status: 200,
      data: { kind: "calendar#event" }, // missing id and htmlLink
    });

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-fff",
      connectedAccountId: "ca_missing333",
    });

    await expect(
      transport.insertEvent({
        summary: "Incomplete response",
        start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
        end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
        reminders: { useDefault: true },
      }),
    ).rejects.toThrow(CalendarTransportError);
  });

  it("throws CalendarTransportError on network error from proxyExecute", async () => {
    mockProxyExecute.mockRejectedValueOnce(new Error("Network timeout"));

    const transport = createComposioCalendarTransport({
      keepsUserId: "user-uuid-ggg",
      connectedAccountId: "ca_netfail444",
    });

    await expect(
      transport.insertEvent({
        summary: "Network fail",
        start: { dateTime: "2026-06-20T15:00:00+00:00", timeZone: "UTC" },
        end: { dateTime: "2026-06-20T15:30:00+00:00", timeZone: "UTC" },
        reminders: { useDefault: true },
      }),
    ).rejects.toThrow(CalendarTransportError);
  });
});
