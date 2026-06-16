/**
 * Standing-grant repository (Wave 4 / Wave 2 surface). Thin SQL over standing_grants for the
 * /settings/automations flow: list a user's grants, enable a recipe (create a default grant
 * validated against its envelope), and revoke. Org-policy validation hooks in once an org
 * envelope table exists; for a personal org there is no envelope, so the recipe envelope governs.
 */
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { orgMemberships, standingGrants } from "@/db/schema";
import type * as schema from "@/db/schema";
import { getRecipe } from "@/automation/recipe-registry";
import { defaultGrantForRecipe, validateGrantAgainstRecipe } from "@/automation/grant-validator";

type Db = PostgresJsDatabase<typeof schema>;

export type CreateGrantResult =
  | { ok: true; id: string }
  | { ok: false; error: "unknown_recipe" | "invalid_grant" | "already_active" };

/** The user's first org membership id, or null (no membership → personal/legacy). */
export async function loadUserOrgId(userId: string, db?: Db): Promise<string | null> {
  const database = db ?? (getDb() as Db);
  const [m] = await database
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId))
    .limit(1);
  return m?.orgId ?? null;
}

export async function listUserGrants(userId: string, db?: Db) {
  const database = db ?? (getDb() as Db);
  return database
    .select({
      id: standingGrants.id,
      recipeKey: standingGrants.recipeKey,
      status: standingGrants.status,
      expiresAt: standingGrants.expiresAt,
    })
    .from(standingGrants)
    .where(eq(standingGrants.userId, userId))
    .orderBy(desc(standingGrants.createdAt));
}

/**
 * Enable a recipe for a user: build the recipe's default grant, validate it sits inside the
 * recipe envelope (SR1/SR2), and insert it active with the recipe's default expiry/caps/quiet
 * hours. Refuses if the recipe is unknown or an active grant already exists for it.
 */
export async function createGrantForRecipe(input: {
  userId: string;
  recipeKey: string;
  now: Date;
  db?: Db;
}): Promise<CreateGrantResult> {
  const database = input.db ?? (getDb() as Db);
  const recipe = getRecipe(input.recipeKey);
  if (!recipe) return { ok: false, error: "unknown_recipe" };

  const def = defaultGrantForRecipe(input.recipeKey);
  if (!def) return { ok: false, error: "unknown_recipe" };

  // Deny-by-default safety: the default grant must validate against the recipe envelope.
  const validation = validateGrantAgainstRecipe(def, recipe);
  if (!validation.valid) return { ok: false, error: "invalid_grant" };

  // One active grant per (user, recipe).
  const [existing] = await database
    .select({ id: standingGrants.id })
    .from(standingGrants)
    .where(
      and(
        eq(standingGrants.userId, input.userId),
        eq(standingGrants.recipeKey, input.recipeKey),
        eq(standingGrants.status, "active"),
      ),
    )
    .limit(1);
  if (existing) return { ok: false, error: "already_active" };

  const orgId = await loadUserOrgId(input.userId, database);
  const expiresAt = new Date(input.now.getTime() + recipe.defaultExpiryDays * 24 * 60 * 60 * 1000);

  const [row] = await database
    .insert(standingGrants)
    .values({
      userId: input.userId,
      recipeKey: input.recipeKey,
      status: "active",
      scope: {},
      allowedActionKinds: def.allowedActionKinds,
      blockedActionKinds: def.blockedActionKinds,
      caps: def.caps ?? {},
      quietHours: recipe.defaultQuietHours,
      constraints: orgId ? { orgId } : {},
      expiresAt,
    })
    .returning({ id: standingGrants.id });

  return { ok: true, id: row.id };
}

/** Revoke a grant (only the owner's). Immediate: status='revoked' + revokedAt. */
export async function revokeUserGrant(input: {
  userId: string;
  grantId: string;
  now: Date;
  db?: Db;
}): Promise<{ ok: boolean }> {
  const database = input.db ?? (getDb() as Db);
  const rows = await database
    .update(standingGrants)
    .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
    .where(and(eq(standingGrants.id, input.grantId), eq(standingGrants.userId, input.userId)))
    .returning({ id: standingGrants.id });
  return { ok: rows.length === 1 };
}
