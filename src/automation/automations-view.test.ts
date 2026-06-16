import { describe, it, expect } from "vitest";
import { buildRecipeCatalog, grantRowViewModel } from "@/automation/automations-view";

describe("buildRecipeCatalog", () => {
  it("returns all 4 recipes with disclosure fields", () => {
    const cat = buildRecipeCatalog();
    expect(cat.map((c) => c.key)).toEqual([
      "pre_meeting_brief",
      "post_meeting_prompt",
      "stale_loop_followup",
      "self_only_calendar_reminder",
    ]);
    for (const item of cat) {
      expect(item.displayName.length).toBeGreaterThan(0);
      expect(item.reads.length).toBeGreaterThan(0);
      expect(item.expiryDays).toBeGreaterThan(0);
    }
  });

  it("splits auto vs approval-required actions (stale-loop: private auto, slack/cal approval)", () => {
    const stale = buildRecipeCatalog().find((c) => c.key === "stale_loop_followup")!;
    expect(stale.autoActions.join(" ")).toContain("private");
    expect(stale.approvalActions.join(" ").toLowerCase()).toContain("slack");
  });

  it("pre-meeting brief takes no approval-required actions (fully private)", () => {
    const brief = buildRecipeCatalog().find((c) => c.key === "pre_meeting_brief")!;
    expect(brief.approvalActions).toEqual([]);
  });
});

describe("grantRowViewModel", () => {
  const NOW = new Date("2026-06-15T12:00:00Z");

  it("active + future expiry → live", () => {
    const vm = grantRowViewModel(
      { recipeKey: "stale_loop_followup", status: "active", expiresAt: new Date("2026-12-31T00:00:00Z") },
      NOW,
    );
    expect(vm.live).toBe(true);
    expect(vm.recipeName).toBe("Stale-loop follow-up draft");
  });

  it("active but past expiry → not live", () => {
    const vm = grantRowViewModel(
      { recipeKey: "stale_loop_followup", status: "active", expiresAt: new Date("2020-01-01T00:00:00Z") },
      NOW,
    );
    expect(vm.live).toBe(false);
  });

  it("paused/revoked → not live; unknown recipe falls back to its key", () => {
    expect(grantRowViewModel({ recipeKey: "x", status: "paused", expiresAt: null }, NOW).live).toBe(false);
    expect(grantRowViewModel({ recipeKey: "ghost", status: "active", expiresAt: null }, NOW).recipeName).toBe(
      "ghost",
    );
  });
});
