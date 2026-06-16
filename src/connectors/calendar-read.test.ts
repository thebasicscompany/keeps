import { describe, it, expect } from "vitest";
import { mapCalendarEvents, readCalendarEvents } from "./calendar-read";
import type { executeComposioTool } from "@/connectors/composio";

describe("mapCalendarEvents", () => {
  it("maps metadata only (title/attendees/start/end) and NEVER the description", () => {
    const data = {
      response_data: {
        items: [
          {
            id: "e1",
            summary: "Sync with Maya",
            description: "SECRET MEETING BODY",
            start: { dateTime: "2026-06-15T14:00:00Z" },
            end: { dateTime: "2026-06-15T14:30:00Z" },
            attendees: [{ email: "Maya@Acme.com" }, { email: "me@co.com" }],
          },
          { id: "e2", summary: "All-day", start: { date: "2026-06-16" }, end: { date: "2026-06-17" }, attendees: [] },
          { summary: "no id → skipped" },
        ],
      },
    };
    const events = mapCalendarEvents(data);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: "e1",
      title: "Sync with Maya",
      startIso: "2026-06-15T14:00:00Z",
      endIso: "2026-06-15T14:30:00Z",
      attendeeEmails: ["maya@acme.com", "me@co.com"],
    });
    expect(JSON.stringify(events)).not.toContain("SECRET MEETING BODY");
    expect(events[1].id).toBe("e2");
  });

  it("handles empty / missing items", () => {
    expect(mapCalendarEvents({})).toEqual([]);
    expect(mapCalendarEvents({ response_data: {} })).toEqual([]);
  });
});

describe("readCalendarEvents", () => {
  it("calls EVENTS_LIST with the ISO time window and maps the result", async () => {
    const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const fakeExec = (async (slug: string, params: { arguments: Record<string, unknown> }) => {
      calls.push({ slug, args: params.arguments });
      return {
        successful: true,
        error: null,
        data: {
          response_data: {
            items: [{ id: "e1", summary: "x", start: { dateTime: "2026-06-15T14:00:00Z" }, end: {}, attendees: [] }],
          },
        },
      };
    }) as unknown as typeof executeComposioTool;

    const events = await readCalendarEvents({
      keepsUserId: "u1",
      connectedAccountId: "ca_1",
      timeMin: new Date("2026-06-15T13:00:00Z"),
      timeMax: new Date("2026-06-15T15:00:00Z"),
      execute: fakeExec,
    });

    expect(calls[0].slug).toBe("GOOGLECALENDAR_EVENTS_LIST");
    expect(calls[0].args.time_min).toBe("2026-06-15T13:00:00.000Z");
    expect(calls[0].args.calendar_id).toBe("primary");
    expect(events[0].id).toBe("e1");
  });

  it("throws on an unsuccessful Composio result", async () => {
    const fakeExec = (async () => ({ successful: false, error: "nope", data: {} })) as unknown as typeof executeComposioTool;
    await expect(
      readCalendarEvents({
        keepsUserId: "u1",
        connectedAccountId: "ca_1",
        timeMin: new Date("2026-06-15T13:00:00Z"),
        timeMax: new Date("2026-06-15T15:00:00Z"),
        execute: fakeExec,
      }),
    ).rejects.toThrow(/calendar read failed/);
  });
});
