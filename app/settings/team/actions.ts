"use server";

/**
 * app/settings/team/actions.ts
 *
 * One-shot backfill for Clerk orgs that already existed BEFORE the webhook was subscribed to
 * organization events (Clerk doesn't replay historical events). Pulls the signed-in user's Clerk
 * org memberships via the Clerk backend API and runs the same syncClerkOrgMembership the webhook
 * uses — for every member of each org — so the shared workspace + edges materialize in Keeps.
 * Idempotent (safe to click repeatedly); going forward the webhook keeps everything in sync.
 */
import { auth, clerkClient } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { syncClerkOrgMembership } from "@/auth/clerk-orgs";

export async function syncMyClerkOrgs(): Promise<void> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return;

  const client = await clerkClient();
  const myMemberships = await client.users.getOrganizationMembershipList({ userId: clerkUserId });

  for (const m of myMemberships.data) {
    const clerkOrgId = m.organization.id;
    const orgName = m.organization.name ?? "";

    // Sync every member of the org (not just me), so teammates already in Clerk land too. Members
    // who haven't signed into Keeps yet are skipped (user_not_found) and sync on their next login.
    const orgMembers = await client.organizations.getOrganizationMembershipList({ organizationId: clerkOrgId });
    for (const om of orgMembers.data) {
      const memberClerkUserId = om.publicUserData?.userId;
      if (!memberClerkUserId) continue;
      await syncClerkOrgMembership({
        clerkOrgId,
        orgName,
        clerkUserId: memberClerkUserId,
        clerkRole: om.role,
      });
    }
  }

  revalidatePath("/settings/team");
}
