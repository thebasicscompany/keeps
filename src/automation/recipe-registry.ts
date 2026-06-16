/**
 * Recipe registry — Wave B stub.
 *
 * The four V2 recipe keys are the ONLY automations the policy gate recognizes;
 * any unknown key denies (SR1, deny-by-default). Wave C replaces the internals with
 * full RecipeDefinition objects (declared reads, allowed/blocked action kinds, trigger,
 * scope schema, caps, expiry) but KEEPS this `isKnownRecipe` signature stable so
 * `authorize()` never has to change again.
 */
import type { RecipeKey } from "@/automation/types";

export const RECIPE_KEYS = [
  "pre_meeting_brief",
  "post_meeting_prompt",
  "stale_loop_followup",
  "self_only_calendar_reminder",
] as const;

const RECIPE_KEY_SET: ReadonlySet<string> = new Set(RECIPE_KEYS);

export function isKnownRecipe(recipeKey: string): recipeKey is RecipeKey {
  return RECIPE_KEY_SET.has(recipeKey);
}
