/**
 * src/approvals/describe-action.test.ts
 *
 * Tests for describeApprovalAction — specifically:
 *   1. Each known action kind renders the expected rows.
 *   2. A nested destination object renders "Maya (maya@x.com)", not JSON.
 *   3. An attendees array renders names, not `["..."]`.
 *   4. An UNKNOWN kind with a nested object produces NO raw JSON substring.
 */

import { describe, expect, it } from "vitest";
import { describeApprovalAction } from "@/approvals/describe-action";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert no row value (and no title) contains a raw JSON substring. */
function assertNoRawJson(result: { title: string; rows: { label: string; value: string }[] }) {
  const allText = [result.title, ...result.rows.map((r) => r.value)].join("\n");
  expect(allText).not.toMatch(/\{"/);
  expect(allText).not.toMatch(/\["/);
  // Also make sure stringified arrays like ["alice"] don't appear
  expect(allText).not.toMatch(/\[.*\]/);
}

// ---------------------------------------------------------------------------
// slack_dm
// ---------------------------------------------------------------------------

describe("describeApprovalAction — slack_dm", () => {
  const payload = {
    kind: "slack_dm",
    destination: { kind: "person", nameText: "Maya", emailText: "maya@x.com" },
    message: "I'll send the deck Friday",
    channel: "U0123",
    recipientName: "Maya",
    recipientEmail: "maya@x.com",
  };

  it("returns the correct title", () => {
    const result = describeApprovalAction("slack_dm", payload);
    expect(result.title).toBe("Send a Slack message");
  });

  it("renders To as name + email, not JSON", () => {
    const result = describeApprovalAction("slack_dm", payload);
    const toRow = result.rows.find((r) => r.label === "To");
    expect(toRow?.value).toBe("Maya (maya@x.com)");
    assertNoRawJson(result);
  });

  it("renders Message row", () => {
    const result = describeApprovalAction("slack_dm", payload);
    const msgRow = result.rows.find((r) => r.label === "Message");
    expect(msgRow?.value).toBe("I'll send the deck Friday");
  });

  it("handles self-DM destination", () => {
    const selfPayload = {
      kind: "slack_dm",
      destination: { kind: "self", nameText: null, emailText: null },
      message: "Reminder",
      channel: "D999",
      recipientName: null,
      recipientEmail: null,
    };
    const result = describeApprovalAction("slack_dm", selfPayload);
    // No explicit recipientName/recipientEmail → falls back to destination
    const toRow = result.rows.find((r) => r.label === "To");
    expect(toRow?.value).toBe("yourself");
    assertNoRawJson(result);
  });
});

// ---------------------------------------------------------------------------
// calendar_event
// ---------------------------------------------------------------------------

describe("describeApprovalAction — calendar_event", () => {
  const payload = {
    kind: "calendar_event",
    destination: { kind: "self", nameText: null, emailText: null },
    eventTitle: "Team standup",
    whenAt: "2026-06-20T15:00:00.000Z",
    durationMinutes: 30,
    reminderMinutesBefore: 10,
    attendees: ["alice@x.com", "bob@x.com"],
    description: null,
  };

  it("returns the correct title", () => {
    const result = describeApprovalAction("calendar_event", payload);
    expect(result.title).toBe("Add a calendar event");
  });

  it("renders Event row", () => {
    const result = describeApprovalAction("calendar_event", payload);
    const row = result.rows.find((r) => r.label === "Event");
    expect(row?.value).toBe("Team standup");
  });

  it("renders When as a human date string, not ISO", () => {
    const result = describeApprovalAction("calendar_event", payload);
    const row = result.rows.find((r) => r.label === "When");
    expect(row?.value).not.toMatch(/T\d{2}:\d{2}:\d{2}/); // no raw ISO T-time
    expect(row?.value).not.toBe("—");
  });

  it("renders Duration row", () => {
    const result = describeApprovalAction("calendar_event", payload);
    const row = result.rows.find((r) => r.label === "Duration");
    expect(row?.value).toBe("30 minutes");
  });

  it("renders Attendees as names, not a JSON array", () => {
    const result = describeApprovalAction("calendar_event", payload);
    const row = result.rows.find((r) => r.label === "Attendees");
    expect(row?.value).toContain("alice@x.com");
    expect(row?.value).toContain("bob@x.com");
    expect(row?.value).not.toMatch(/\[/);
    assertNoRawJson(result);
  });

  it("renders Reminder row", () => {
    const result = describeApprovalAction("calendar_event", payload);
    const row = result.rows.find((r) => r.label === "Reminder");
    expect(row?.value).toBe("10 min before");
  });

  it("omits Duration and Reminder when null", () => {
    const minimal = { ...payload, durationMinutes: null, reminderMinutesBefore: null };
    const result = describeApprovalAction("calendar_event", minimal);
    expect(result.rows.find((r) => r.label === "Duration")).toBeUndefined();
    expect(result.rows.find((r) => r.label === "Reminder")).toBeUndefined();
  });

  it("renders null whenAt as 'time to be confirmed'", () => {
    const noWhen = { ...payload, whenAt: null };
    const result = describeApprovalAction("calendar_event", noWhen);
    const row = result.rows.find((r) => r.label === "When");
    expect(row?.value).toBe("time to be confirmed");
  });
});

// ---------------------------------------------------------------------------
// test_action
// ---------------------------------------------------------------------------

describe("describeApprovalAction — test_action", () => {
  it("returns title 'Test action'", () => {
    const result = describeApprovalAction("test_action", { note: "hello", count: 3 });
    expect(result.title).toBe("Test action");
  });

  it("renders scalar fields as rows", () => {
    const result = describeApprovalAction("test_action", { note: "hello", count: 3 });
    expect(result.rows.find((r) => r.label === "Note")?.value).toBe("hello");
    expect(result.rows.find((r) => r.label === "Count")?.value).toBe("3");
  });

  it("strips internal keys", () => {
    const result = describeApprovalAction("test_action", {
      token: "abc",
      tokenHash: "xyz",
      id: "1",
      userId: "2",
      draftId: "3",
      note: "visible",
    });
    const labels = result.rows.map((r) => r.label);
    expect(labels).not.toContain("Token");
    expect(labels).not.toContain("Token hash");
    expect(labels).toContain("Note");
  });
});

// ---------------------------------------------------------------------------
// policy alias — send_slack_message
// ---------------------------------------------------------------------------

describe("describeApprovalAction — send_slack_message (policy alias)", () => {
  it("routes to Slack handler when payload has message shape", () => {
    const payload = {
      destination: { kind: "person", nameText: "Bob", emailText: "bob@co.com" },
      message: "Hey Bob",
      channel: "U999",
      recipientName: "Bob",
      recipientEmail: "bob@co.com",
    };
    const result = describeApprovalAction("send_slack_message", payload);
    expect(result.title).toBe("Send a Slack message");
    assertNoRawJson(result);
  });
});

// ---------------------------------------------------------------------------
// policy alias — create_calendar_event
// ---------------------------------------------------------------------------

describe("describeApprovalAction — create_calendar_event (policy alias)", () => {
  it("routes to calendar handler when payload has eventTitle", () => {
    const payload = {
      eventTitle: "Planning",
      whenAt: "2026-07-01T10:00:00.000Z",
      durationMinutes: 60,
      reminderMinutesBefore: null,
      attendees: null,
      destination: { kind: "self", nameText: null, emailText: null },
      description: null,
    };
    const result = describeApprovalAction("create_calendar_event", payload);
    expect(result.title).toBe("Add a calendar event");
    assertNoRawJson(result);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN kind — the no-raw-JSON guarantee
// ---------------------------------------------------------------------------

describe("describeApprovalAction — unknown kind with nested objects", () => {
  it("does NOT produce raw JSON substrings", () => {
    const payload = {
      recipient: { kind: "person", nameText: "Maya", emailText: "maya@x.com" },
      tags: ["urgent", "follow-up"],
      note: "Important",
    };
    const result = describeApprovalAction("custom_action_xyz", payload);
    assertNoRawJson(result);
  });

  it("renders a destination-shaped nested object as 'Name (email)', not JSON", () => {
    const payload = {
      recipient: { kind: "person", nameText: "Maya", emailText: "maya@x.com" },
    };
    const result = describeApprovalAction("custom_action_xyz", payload);
    const row = result.rows.find((r) => r.label === "Recipient");
    expect(row?.value).toBe("Maya (maya@x.com)");
  });

  it("humanizes the action kind as the title", () => {
    const result = describeApprovalAction("share_loop", { loopId: "abc" });
    expect(result.title).toBe("Share loop");
  });

  it("renders array of strings with count but no raw brackets", () => {
    const payload = { emails: ["alice@x.com", "bob@x.com"] };
    const result = describeApprovalAction("notify_many", payload);
    const row = result.rows.find((r) => r.label === "Emails");
    expect(row?.value).toContain("alice@x.com");
    expect(row?.value).not.toMatch(/\[/);
    assertNoRawJson(result);
  });

  it("never contains {\" or [\" substring in any output", () => {
    // Deeply nested object
    const payload = {
      outer: {
        inner: { key: "value" },
        list: ["a", "b"],
      },
    };
    const result = describeApprovalAction("weird_action", payload);
    assertNoRawJson(result);
  });
});
