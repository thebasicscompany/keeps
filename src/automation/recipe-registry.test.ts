import { describe, it, expect } from "vitest";
import { isKnownRecipe, RECIPE_KEYS } from "@/automation/recipe-registry";

describe("recipe-registry (Wave B stub)", () => {
  it("recognizes exactly the four V2 recipe keys", () => {
    expect([...RECIPE_KEYS].sort()).toEqual(
      [
        "post_meeting_prompt",
        "pre_meeting_brief",
        "self_only_calendar_reminder",
        "stale_loop_followup",
      ].sort(),
    );
    for (const key of RECIPE_KEYS) expect(isKnownRecipe(key)).toBe(true);
  });

  it("denies unknown recipe keys (SR1, deny-by-default)", () => {
    expect(isKnownRecipe("ghost_recipe")).toBe(false);
    expect(isKnownRecipe("")).toBe(false);
    expect(isKnownRecipe("PRE_MEETING_BRIEF")).toBe(false);
  });
});
