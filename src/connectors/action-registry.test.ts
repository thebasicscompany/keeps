/**
 * Tests for the generic connector action core.
 *
 * No network, no Composio: buildComposioArguments is pure, and
 * executeConnectorPayload takes an injected fake executor returning canned
 * Composio `{ data, successful, error }` responses.
 */

import { describe, expect, it } from "vitest";
import {
  ACTION_REGISTRY,
  buildComposioArguments,
  classifyReversibility,
  executeConnectorPayload,
  ConnectorActionFailedError,
  type ConnectorExecutor,
} from "@/connectors/action-registry";
import type { ComposioToolResult } from "@/connectors/composio";
import type {
  SlackDmPayload,
  CalendarEventPayload,
} from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const slackPayload: SlackDmPayload = {
  kind: "slack_dm",
  destination: { kind: "person", nameText: "Maya", emailText: "maya@x.com" },
  message: "I'll send the deck Friday",
  channel: "U07MAYA123",
  recipientName: "Maya",
  recipientEmail: "maya@x.com",
};

const calendarPayloadSelf: CalendarEventPayload = {
  kind: "calendar_event",
  destination: { kind: "self", nameText: null, emailText: null },
  eventTitle: "Renewal call",
  // 2026-06-20 15:00:00 UTC → in America/Los_Angeles (PDT, -7) that's 08:00:00.
  whenAt: "2026-06-20T15:00:00.000Z",
  durationMinutes: 90,
  reminderMinutesBefore: 10,
  description: "https://keeps.ai/loops/abc-123",
  attendees: null,
};

const calendarPayloadWithAttendees: CalendarEventPayload = {
  ...calendarPayloadSelf,
  attendees: ["alice@x.com", "bob@x.com"],
};

const USER_LA = { timezone: "America/Los_Angeles" };
const USER_UTC = { timezone: "UTC" };

/** Build a fake executor from a slug→response map, recording calls. */
function fakeExecutor(
  responses: Record<string, ComposioToolResult>,
): ConnectorExecutor & {
  calls: { slug: string; arguments: Record<string, unknown> }[];
} {
  const calls: { slug: string; arguments: Record<string, unknown> }[] = [];
  const fn = (async (slug, params) => {
    calls.push({ slug, arguments: params.arguments });
    return (
      responses[slug] ?? {
        data: {},
        error: "no_canned_response",
        successful: false,
      }
    );
  }) as ConnectorExecutor & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const ok = (data: Record<string, unknown>): ComposioToolResult => ({
  data,
  error: null,
  successful: true,
});

// ---------------------------------------------------------------------------
// buildComposioArguments — slack_dm
// ---------------------------------------------------------------------------

describe("buildComposioArguments — slack_dm", () => {
  it("maps to SLACK_SEND_MESSAGE with the frozen channel and markdown_text", () => {
    const { slug, arguments: args } = buildComposioArguments(slackPayload, {
      user: USER_UTC,
    });
    expect(slug).toBe("SLACK_SEND_MESSAGE");
    expect(args.channel).toBe("U07MAYA123");
    expect(args.markdown_text).toBe("I'll send the deck Friday");
  });

  it("emits an empty markdown_text when the message is null", () => {
    const { arguments: args } = buildComposioArguments(
      { ...slackPayload, message: null },
      { user: USER_UTC },
    );
    expect(args.markdown_text).toBe("");
    // Still targets the frozen channel.
    expect(args.channel).toBe("U07MAYA123");
  });
});

// ---------------------------------------------------------------------------
// buildComposioArguments — calendar_event (tz + duration math)
// ---------------------------------------------------------------------------

describe("buildComposioArguments — calendar_event", () => {
  it("converts whenAt ISO to naive local start_datetime in the user's IANA tz", () => {
    const { slug, arguments: args } = buildComposioArguments(
      calendarPayloadSelf,
      { user: USER_LA },
    );
    expect(slug).toBe("GOOGLECALENDAR_CREATE_EVENT");
    expect(args.calendar_id).toBe("primary");
    expect(args.summary).toBe("Renewal call");
    // 15:00 UTC in PDT (-7) = 08:00 local, naive (no Z/offset).
    expect(args.start_datetime).toBe("2026-06-20T08:00:00");
    expect(args.timezone).toBe("America/Los_Angeles");
  });

  it("keeps the naive datetime equal to the ISO wall-clock under UTC", () => {
    const { arguments: args } = buildComposioArguments(calendarPayloadSelf, {
      user: USER_UTC,
    });
    expect(args.start_datetime).toBe("2026-06-20T15:00:00");
    expect(args.timezone).toBe("UTC");
  });

  it("falls back to UTC for an unknown / invalid timezone", () => {
    const { arguments: args } = buildComposioArguments(calendarPayloadSelf, {
      user: { timezone: "Mars/Phobos" },
    });
    expect(args.timezone).toBe("UTC");
    expect(args.start_datetime).toBe("2026-06-20T15:00:00");
  });

  it("falls back to UTC for a null timezone", () => {
    const { arguments: args } = buildComposioArguments(calendarPayloadSelf, {
      user: { timezone: null },
    });
    expect(args.timezone).toBe("UTC");
  });

  it("splits durationMinutes into hour + minutes(0-59)", () => {
    const { arguments: args } = buildComposioArguments(calendarPayloadSelf, {
      user: USER_UTC,
    });
    // 90 min → 1h 30m
    expect(args.event_duration_hour).toBe(1);
    expect(args.event_duration_minutes).toBe(30);
  });

  it("defaults to a 30-minute duration when durationMinutes is null", () => {
    const { arguments: args } = buildComposioArguments(
      { ...calendarPayloadSelf, durationMinutes: null },
      { user: USER_UTC },
    );
    expect(args.event_duration_hour).toBe(0);
    expect(args.event_duration_minutes).toBe(30);
  });

  it("passes attendees through and sets send_updates when attendees exist", () => {
    const { arguments: args } = buildComposioArguments(
      calendarPayloadWithAttendees,
      { user: USER_UTC },
    );
    expect(args.attendees).toEqual(["alice@x.com", "bob@x.com"]);
    expect(args.send_updates).toBe(true);
  });

  it("omits attendees / send_updates for a self-only event", () => {
    const { arguments: args } = buildComposioArguments(calendarPayloadSelf, {
      user: USER_UTC,
    });
    expect(args.attendees).toBeUndefined();
    expect(args.send_updates).toBeUndefined();
  });

  it("includes the description when present", () => {
    const { arguments: args } = buildComposioArguments(calendarPayloadSelf, {
      user: USER_UTC,
    });
    expect(args.description).toBe("https://keeps.ai/loops/abc-123");
  });
});

// ---------------------------------------------------------------------------
// classifyReversibility + ACTION_REGISTRY
// ---------------------------------------------------------------------------

describe("classifyReversibility", () => {
  it("classifies slack_dm as irreversible", () => {
    expect(classifyReversibility(slackPayload)).toBe("irreversible");
  });

  it("classifies a calendar event WITH attendees as irreversible", () => {
    expect(classifyReversibility(calendarPayloadWithAttendees)).toBe(
      "irreversible",
    );
  });

  it("classifies a self-only calendar event as reversible", () => {
    expect(classifyReversibility(calendarPayloadSelf)).toBe("reversible");
  });

  it("classifies a calendar event with an empty attendees array as reversible", () => {
    expect(
      classifyReversibility({ ...calendarPayloadSelf, attendees: [] }),
    ).toBe("reversible");
  });

  it("ACTION_REGISTRY entries agree with classifyReversibility and carry the right slugs", () => {
    expect(ACTION_REGISTRY.slack_dm.actionSlug).toBe("SLACK_SEND_MESSAGE");
    expect(ACTION_REGISTRY.calendar_event.actionSlug).toBe(
      "GOOGLECALENDAR_CREATE_EVENT",
    );
    expect(ACTION_REGISTRY.slack_dm.reversibility(slackPayload)).toBe(
      "irreversible",
    );
    expect(
      ACTION_REGISTRY.calendar_event.reversibility(calendarPayloadWithAttendees),
    ).toBe("irreversible");
    expect(
      ACTION_REGISTRY.calendar_event.reversibility(calendarPayloadSelf),
    ).toBe("reversible");
  });
});

// ---------------------------------------------------------------------------
// executeConnectorPayload — happy paths + failure
// ---------------------------------------------------------------------------

describe("executeConnectorPayload — slack_dm", () => {
  it("makes one execute call with the right slug + args and maps the FLAT result", async () => {
    const execute = fakeExecutor({
      SLACK_SEND_MESSAGE: ok({ ok: true, ts: "1718900000.000100", channel: "D07MAYA" }),
    });

    const result = await executeConnectorPayload({
      payload: slackPayload,
      keepsUserId: "user-uuid",
      connectedAccountId: "ca_slack",
      user: USER_UTC,
      execute,
    });

    expect(execute.calls).toHaveLength(1);
    expect(execute.calls[0].slug).toBe("SLACK_SEND_MESSAGE");
    expect(execute.calls[0].arguments).toEqual({
      channel: "U07MAYA123",
      markdown_text: "I'll send the deck Friday",
    });
    expect(result).toEqual({
      kind: "slack_dm",
      channel: "D07MAYA",
      ts: "1718900000.000100",
    });
  });
});

describe("executeConnectorPayload — calendar_event", () => {
  it("makes one execute call and maps the NESTED response_data result", async () => {
    const execute = fakeExecutor({
      GOOGLECALENDAR_CREATE_EVENT: ok({
        response_data: {
          id: "evt_abc123",
          htmlLink: "https://www.google.com/calendar/event?eid=evt_abc123",
        },
      }),
    });

    const result = await executeConnectorPayload({
      payload: calendarPayloadSelf,
      keepsUserId: "user-uuid",
      connectedAccountId: "ca_gcal",
      user: USER_LA,
      execute,
    });

    expect(execute.calls).toHaveLength(1);
    expect(execute.calls[0].slug).toBe("GOOGLECALENDAR_CREATE_EVENT");
    expect(execute.calls[0].arguments.start_datetime).toBe("2026-06-20T08:00:00");
    expect(result).toEqual({
      kind: "calendar_event",
      eventId: "evt_abc123",
      htmlLink: "https://www.google.com/calendar/event?eid=evt_abc123",
    });
  });
});

describe("executeConnectorPayload — failure", () => {
  it("throws ConnectorActionFailedError when Composio resolves successful:false", async () => {
    const execute = fakeExecutor({
      SLACK_SEND_MESSAGE: {
        data: { ok: false, error: "channel_not_found" },
        error: "channel_not_found",
        successful: false,
      },
    });

    await expect(
      executeConnectorPayload({
        payload: slackPayload,
        keepsUserId: "user-uuid",
        connectedAccountId: "ca_slack",
        user: USER_UTC,
        execute,
      }),
    ).rejects.toBeInstanceOf(ConnectorActionFailedError);

    // The error carries the Composio error string + raw data.
    try {
      await executeConnectorPayload({
        payload: slackPayload,
        keepsUserId: "user-uuid",
        connectedAccountId: "ca_slack",
        user: USER_UTC,
        execute,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorActionFailedError);
      expect((err as ConnectorActionFailedError).composioError).toBe(
        "channel_not_found",
      );
    }
  });
});
