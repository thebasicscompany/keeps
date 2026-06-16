/**
 * Grant validator (Wave C, SR1/SR2) — proves a standing grant stays inside its recipe's
 * declared envelope. Run at grant-creation time and asserted in tests. Pure + model-free.
 *
 *   allowed ⊆ recipe.allowed        (a grant cannot widen the recipe)
 *   recipe.blocked ⊆ grant.blocked  (a grant must keep every recipe block — narrow-only)
 *   cap keys ⊆ grant.allowed        (cannot cap an action the grant does not allow)
 *   scope satisfies recipe.scopeSchema
 */
import { getRecipe, type RecipeDefinition } from "@/automation/recipe-registry";
import type { StandingGrantContext } from "@/automation/types";
import type { KeepsActionKind } from "@/policy/actions";

export type GrantValidation = { valid: boolean; errors: string[] };

export function validateGrantAgainstRecipe(
  grant: Pick<
    StandingGrantContext,
    "recipeKey" | "allowedActionKinds" | "blockedActionKinds" | "caps" | "scope"
  >,
  recipe?: RecipeDefinition | null,
): GrantValidation {
  const def = recipe ?? getRecipe(grant.recipeKey);
  if (!def) return { valid: false, errors: [`unknown recipe ${grant.recipeKey}`] };

  const errors: string[] = [];

  const recipeAllowed = new Set<KeepsActionKind>(def.allowedActionKinds);
  for (const kind of grant.allowedActionKinds) {
    if (!recipeAllowed.has(kind)) errors.push(`grant allows ${kind} outside recipe envelope`);
  }

  const grantBlocked = new Set<KeepsActionKind>(grant.blockedActionKinds);
  for (const kind of def.blockedActionKinds) {
    if (!grantBlocked.has(kind)) errors.push(`grant must block ${kind} (recipe requires it)`);
  }

  const grantAllowed = new Set<KeepsActionKind>(grant.allowedActionKinds);
  for (const key of Object.keys(grant.caps ?? {})) {
    if (!grantAllowed.has(key as KeepsActionKind)) {
      errors.push(`cap references non-allowed action ${key}`);
    }
  }

  if (!def.scopeSchema.safeParse(grant.scope ?? {}).success) {
    errors.push("scope does not satisfy recipe schema");
  }

  return { valid: errors.length === 0, errors };
}

/** A grant that exactly fills a recipe's envelope — the default offered at grant creation. */
export function defaultGrantForRecipe(recipeKey: string): StandingGrantContext | null {
  const def = getRecipe(recipeKey);
  if (!def) return null;
  return {
    recipeKey: def.key,
    status: "active",
    allowedActionKinds: [...def.allowedActionKinds],
    blockedActionKinds: [...def.blockedActionKinds],
    caps: def.defaultCaps,
    scope: {},
  };
}
