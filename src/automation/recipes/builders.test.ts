import { describe, it, expect } from "vitest";
import {
  buildPreMeetingBrief,
  buildPostMeetingPrompt,
  buildStaleLoopFollowup,
  selfOnlyCalendarWithinBounds,
} from "@/automation/recipes/builders";

describe("buildPreMeetingBrief (Recipe 1)", () => {
  it("null when no attendee entity has open loops", () => {
    expect(
      buildPreMeetingBrief({
        userId: "u1",
        calendarEventId: "evt-1",
        attendees: [{ entityId: "e1", displayName: "Maya", openLoops: [] }],
      }),
    ).toBeNull();
  });

  it("private email only, with loop/entity ids + provenance", () => {
    const plan = buildPreMeetingBrief({
      userId: "u1",
      calendarEventId: "evt-1",
      meetingTimeLabel: "2:00 PM",
      attendees: [{ entityId: "e1", displayName: "Maya", openLoops: [{ id: "l1", summary: "Send packet" }] }],
    });
    expect(plan).not.toBeNull();
    expect(plan!.intendedActions).toEqual([
      { kind: "send_private_email_to_user", target: { userId: "u1", calendarEventId: "evt-1" } },
    ]);
    expect(plan!.contextUsed.loopIds).toEqual(["l1"]);
    expect(plan!.provenanceContext.openLoopCount).toBe(1);
  });
});

describe("buildPostMeetingPrompt (Recipe 2)", () => {
  it("null when a related loop was already captured", () => {
    expect(
      buildPostMeetingPrompt({ userId: "u1", calendarEventId: "evt-1", hasRecentCapturedLoop: true }),
    ).toBeNull();
  });

  it("prompt never claims commitments exist", () => {
    const plan = buildPostMeetingPrompt({
      userId: "u1",
      calendarEventId: "evt-1",
      attendeeName: "Maya",
      hasRecentCapturedLoop: false,
    });
    expect(plan).not.toBeNull();
    expect(plan!.intendedActions[0].kind).toBe("send_private_email_to_user");
    expect(plan!.draft.body.toLowerCase()).not.toContain("you committed");
    expect(plan!.draft.body.toLowerCase()).toContain("if there's anything");
  });
});

describe("buildStaleLoopFollowup (Recipe 3)", () => {
  it("private email + private report only (no external send by default)", () => {
    const plan = buildStaleLoopFollowup({
      userId: "u1",
      loop: { id: "l1", summary: "Acme renewal" },
      staleDays: 7,
    });
    const kinds = plan.intendedActions.map((a) => a.kind).sort();
    expect(kinds).toEqual(["create_private_report", "send_private_email_to_user"]);
    expect(plan.provenanceContext.loopSummary).toBe("Acme renewal");
  });
});

describe("selfOnlyCalendarWithinBounds (Recipe 4)", () => {
  it("rejects attendees", () => {
    expect(selfOnlyCalendarWithinBounds({ attendees: ["a@b.com"], durationMinutes: 30, lookaheadDays: 1 }).ok).toBe(false);
  });
  it("enforces default bounds (60m / 180d)", () => {
    expect(selfOnlyCalendarWithinBounds({ attendees: [], durationMinutes: 90, lookaheadDays: 1 }).ok).toBe(false);
    expect(selfOnlyCalendarWithinBounds({ attendees: [], durationMinutes: 30, lookaheadDays: 200 }).ok).toBe(false);
    expect(selfOnlyCalendarWithinBounds({ attendees: [], durationMinutes: 30, lookaheadDays: 30 }).ok).toBe(true);
  });
  it("honors custom bounds", () => {
    expect(
      selfOnlyCalendarWithinBounds({
        attendees: [],
        durationMinutes: 90,
        lookaheadDays: 1,
        bounds: { maxDurationMinutes: 120 },
      }).ok,
    ).toBe(true);
  });
});
