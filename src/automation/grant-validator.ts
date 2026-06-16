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
import type { ViewerScope } from "@/visibility/can-view";

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

/**
 * Admin-authored org policy envelope (Wave 2, two-tier grants). A personal grant must stay
 * inside BOTH the recipe envelope (validateGrantAgainstRecipe) AND this org envelope.
 */
export type OrgPolicyEnvelope = {
  /** Recipes the org permits at all. */
  allowedRecipeKeys: string[];
  /** Optional per-role allowlist; when the granter's role is present here it OVERRIDES the default. */
  perRoleAllowedRecipeKeys?: Record<string, string[]>;
  /** Action kinds the org forbids any grant from auto-acting on (never-auto-act data classes). */
  forbiddenActionKinds?: string[];
};

/**
 * Validate a personal grant against the org policy envelope AND the granter's own visibility
 * ("you cannot grant access to data you can't see"). PURE. Layers ON TOP of
 * validateGrantAgainstRecipe — callers run both and union the errors.
 */
export function validateGrantWithinOrgPolicy(input: {
  grant: Pick<StandingGrantContext, "recipeKey" | "allowedActionKinds" | "scope">;
  envelope: OrgPolicyEnvelope;
  granterScope: ViewerScope;
  role?: string;
}): GrantValidation {
  const { grant, envelope, granterScope, role } = input;
  const errors: string[] = [];

  // 1. Recipe must be permitted by the org (a per-role allowlist overrides the org default).
  const allowedRecipes =
    (role && envelope.perRoleAllowedRecipeKeys?.[role]) ?? envelope.allowedRecipeKeys;
  if (!allowedRecipes.includes(grant.recipeKey)) {
    errors.push(
      `recipe ${grant.recipeKey} not permitted by org policy${role ? ` for role ${role}` : ""}`,
    );
  }

  // 2. No action kind the org forbids (never-auto-act data classes).
  const forbidden = new Set(envelope.forbiddenActionKinds ?? []);
  for (const kind of grant.allowedActionKinds) {
    if (forbidden.has(kind)) errors.push(`action ${kind} forbidden by org policy`);
  }

  // 3. "Can't grant what you can't see": a grant targeting a scope must target one the granter
  //    can actually see (org admin, or a member of that scope). Fails closed on an unseen scope.
  const targetedScopeId = typeof grant.scope?.scopeId === "string" ? grant.scope.scopeId : null;
  if (targetedScopeId && !granterScope.isOrgAdmin && !granterScope.scopeIds.has(targetedScopeId)) {
    errors.push(`granter cannot grant scope ${targetedScopeId} they cannot see`);
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
