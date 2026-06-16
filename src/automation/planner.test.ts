import { describe, it, expect } from "vitest";
import { planAutomationRun } from "@/automation/planner";
import { defaultGrantForRecipe } from "@/automation/grant-validator";

const NOON = new Date("2026-06-15T12:00:00Z");
const NIGHT = new Date("2026-06-15T23:00:00Z");

describe("planAutomationRun (FR5/SR7)", () => {
  it("produces a sandbox plan in active hours", () => {
    const res = planAutomationRun({
      recipeKey: "pre_meeting_brief",
      triggerKind: "calendar_event",
      triggerRef: "evt-1",
      intendedActions: [{ kind: "send_private_email_to_user", target: { userId: "u1" } }],
      grant: defaultGrantForRecipe("pre_meeting_brief")!,
      provenanceContext: { attendeeName: "Maya", openLoopCount: 2 },
      userTimezone: "UTC",
      now: NOON,
    });
    expect(res.kind).toBe("plan");
    if (res.kind === "plan") expect(res.plan.requiresApproval).toBe(false);
  });

  it("defers a proactive recipe during quiet hours (SR7)", () => {
    const res = planAutomationRun({
      recipeKey: "pre_meeting_brief",
      triggerKind: "calendar_event",
      intendedActions: [{ kind: "send_private_email_to_user", target: {} }],
      grant: defaultGrantForRecipe("pre_meeting_brief")!,
      userTimezone: "UTC",
      now: NIGHT,
    });
    expect(res).toEqual({ kind: "skip", reason: "quiet hours" });
  });

  it("explicit-command recipe is exempt from quiet hours", () => {
    const res = planAutomationRun({
      recipeKey: "self_only_calendar_reminder",
      triggerKind: "explicit_command",
      intendedActions: [{ kind: "create_calendar_event", target: { attendees: [] } }],
      grant: defaultGrantForRecipe("self_only_calendar_reminder")!,
      userTimezone: "UTC",
      now: NIGHT,
    });
    expect(res.kind).toBe("plan");
  });

  it("skips when a cap is exhausted at plan time", () => {
    const res = planAutomationRun({
      recipeKey: "stale_loop_followup",
      triggerKind: "loop_stale",
      intendedActions: [{ kind: "create_private_report", target: {} }],
      grant: {
        ...defaultGrantForRecipe("stale_loop_followup")!,
        caps: { create_private_report: { limit: 5, window: "day" } },
      },
      capUsage: { create_private_report: 5 },
      userTimezone: "UTC",
      now: NOON,
    });
    expect(res).toEqual({ kind: "skip", reason: "cap exhausted for create_private_report" });
  });
});
