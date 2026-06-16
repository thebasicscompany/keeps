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
import { redirect } from "next/navigation";
import type { Route } from "next";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { createGrantForRecipe, revokeUserGrant } from "@/automation/grants-repository";
import { runAutomationNow } from "@/automation/run-now";

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

/**
 * Run an enabled recipe once, right now. On success → land on the run-detail page so the user sees
 * exactly what it did (provenance, actions, outcomes). On failure (not enabled, nothing to act on,
 * skipped by quiet-hours/caps) → return to the surface with a human-readable banner.
 */
export async function runAutomationNowAction(recipeKey: string): Promise<void> {
  const userId = await resolveUserId();
  if (!userId) redirect("/sign-in?redirect_url=/settings/automations" as Route);

  const result = await runAutomationNow({ userId, recipeKey });
  revalidatePath("/settings/automations");
  if (result.ok) {
    redirect(`/settings/automations/runs/${result.runId}` as Route);
  }
  redirect(`/settings/automations?notice=${encodeURIComponent(result.error)}` as Route);
}
