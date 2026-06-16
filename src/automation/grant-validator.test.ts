import { describe, it, expect } from "vitest";
import { validateGrantAgainstRecipe, defaultGrantForRecipe } from "@/automation/grant-validator";
import { RECIPE_KEYS, getRecipe } from "@/automation/recipe-registry";

describe("validateGrantAgainstRecipe (SR1/SR2)", () => {
  it("the default grant for every recipe validates", () => {
    for (const key of RECIPE_KEYS) {
      const grant = defaultGrantForRecipe(key);
      expect(grant).not.toBeNull();
      const v = validateGrantAgainstRecipe(grant!);
      expect(v.valid, `${key}: ${v.errors.join("; ")}`).toBe(true);
    }
  });

  it("unknown recipe → invalid", () => {
    expect(
      validateGrantAgainstRecipe({ recipeKey: "ghost", allowedActionKinds: [], blockedActionKinds: [] }).valid,
    ).toBe(false);
    expect(defaultGrantForRecipe("ghost")).toBeNull();
  });

  it("a grant that widens beyond the recipe envelope → invalid", () => {
    const v = validateGrantAgainstRecipe({
      recipeKey: "pre_meeting_brief",
      allowedActionKinds: ["send_private_email_to_user", "send_slack_message"],
      blockedActionKinds: getRecipe("pre_meeting_brief")!.blockedActionKinds,
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("send_slack_message");
  });

  it("a grant that drops a required recipe block → invalid", () => {
    const v = validateGrantAgainstRecipe({
      recipeKey: "pre_meeting_brief",
      allowedActionKinds: ["send_private_email_to_user"],
      blockedActionKinds: [],
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("must block");
  });

  it("a cap on a non-allowed action → invalid", () => {
    const v = validateGrantAgainstRecipe({
      recipeKey: "pre_meeting_brief",
      allowedActionKinds: ["send_private_email_to_user"],
      blockedActionKinds: getRecipe("pre_meeting_brief")!.blockedActionKinds,
      caps: { create_calendar_event: { limit: 1, window: "day" } },
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("cap references");
  });

  it("an unparseable scope → invalid", () => {
    const v = validateGrantAgainstRecipe({
      recipeKey: "pre_meeting_brief",
      allowedActionKinds: ["send_private_email_to_user"],
      blockedActionKinds: getRecipe("pre_meeting_brief")!.blockedActionKinds,
      scope: { leadMinutes: "soon" } as unknown as Record<string, unknown>,
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("scope");
  });
});
