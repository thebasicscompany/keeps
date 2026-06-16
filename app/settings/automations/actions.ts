"use server";

/**
 * app/settings/automations/actions.ts
 *
 * Clerk-gated server actions for the automations surface (Wave 4). Enable creates a default,
 * envelope-validated standing grant for a recipe; revoke deactivates one immediately. Auth pattern
 * mirrors the other settings actions: Clerk user id → internal users.id via user_identities.
 */
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { createGrantForRecipe, revokeUserGrant } from "@/automation/grants-repository";

async function resolveUserId(): Promise<string | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const [identity] = await getDb()
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(eq(userIdentities.provider, "clerk"), eq(userIdentities.providerAccountId, clerkUserId)),
    )
    .limit(1);
  return identity?.userId ?? null;
}

export async function enableAutomation(recipeKey: string): Promise<void> {
  const userId = await resolveUserId();
  if (!userId) return;
  await createGrantForRecipe({ userId, recipeKey, now: new Date() });
  revalidatePath("/settings/automations");
}

export async function revokeAutomation(grantId: string): Promise<void> {
  const userId = await resolveUserId();
  if (!userId) return;
  await revokeUserGrant({ userId, grantId, now: new Date() });
  revalidatePath("/settings/automations");
}
