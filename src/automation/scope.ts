/**
 * Scope matching (Wave C, SR2) — does a specific trigger target fall within a grant's
 * scope for the recipe? Fails closed: unknown recipe or unparseable scope → no match.
 */
import { getRecipe } from "@/automation/recipe-registry";
import type { GrantScope } from "@/automation/types";

export type ScopeMatchResult = { matches: boolean; reason?: string };

export function scopeMatches(input: {
  recipeKey: string;
  grantScope: GrantScope | undefined;
  target?: {
    attendees?: unknown[];
    durationMinutes?: number;
    lookaheadDays?: number;
    entityId?: string;
  };
}): ScopeMatchResult {
  const recipe = getRecipe(input.recipeKey);
  if (!recipe) return { matches: false, reason: "unknown recipe" };

  const parsed = recipe.scopeSchema.safeParse(input.grantScope ?? {});
  if (!parsed.success) return { matches: false, reason: "scope does not satisfy recipe schema" };

  // Self-only calendar: the target must have zero attendees and respect the bounds.
  if (input.recipeKey === "self_only_calendar_reminder" && input.target) {
    const attendees = input.target.attendees ?? [];
    if (attendees.length > 0) {
      return { matches: false, reason: "self-only recipe rejects attendees" };
    }
    const scope = parsed.data as { maxDurationMinutes?: number; maxLookaheadDays?: number };
    const maxDuration = scope.maxDurationMinutes ?? 60;
    const maxLookahead = scope.maxLookaheadDays ?? 180;
    if (input.target.durationMinutes !== undefined && input.target.durationMinutes > maxDuration) {
      return { matches: false, reason: `exceeds max duration ${maxDuration}m` };
    }
    if (input.target.lookaheadDays !== undefined && input.target.lookaheadDays > maxLookahead) {
      return { matches: false, reason: `exceeds max lookahead ${maxLookahead}d` };
    }
  }

  return { matches: true };
}
