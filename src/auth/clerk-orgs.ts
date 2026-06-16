/**
 * Clerk organization sync (Wave 6 — multi-member orgs).
 *
 * Keeps mirrors Clerk Organizations (the `organizations.clerk_org_id` link) rather than running its
 * own invite system — Clerk Billing already owns orgs + invites + roles. The Clerk webhook calls
 * these on `organization.*` / `organizationMembership.*` events. Idempotent (Clerk delivers
 * at-least-once): every step is a select-then-write or revoke-by-set.
 *
 * Whole-org sharing model (v1): every member gets a `scope_member` edge to the org's `org_root`
 * scope, and their loops are stamped with that org + `org_root`. canView then lets any member see
 * any loop tagged `org_root` in their org — and NOTHING across orgs (canView fails closed on a
 * cross-org mismatch). Owners/admins additionally get whole-org visibility via their role.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  loops,
  orgMemberships,
  organizations,
  scopes,
  userIdentities,
  visibilityEdges,
} from "@/db/schema";
import type { OrgMemberRole } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** Map a Clerk role string ("org:admin", "admin", "org:member", …) to a Keeps membership role. */
export function mapClerkRole(role: string | null | undefined): OrgMemberRole {
  const r = (role ?? "").toLowerCase();
  if (r.includes("owner")) return "owner";
  if (r.includes("admin")) return "admin";
  return "member";
}

async function resolveKeepsUserId(clerkUserId: string, db: AnyDb): Promise<string | null> {
  const [row] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, "clerk"), eq(userIdentities.providerAccountId, clerkUserId)))
    .limit(1);
  return row?.userId ?? null;
}

/** Find-or-create the Keeps org mirroring a Clerk org; returns its id + the org_root scope id. */
async function ensureSharedOrg(
  input: { clerkOrgId: string; orgName: string },
  db: AnyDb,
): Promise<{ orgId: string; rootScopeId: string }> {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.clerkOrgId, input.clerkOrgId))
    .limit(1);

  let orgId: string;
  if (existing) {
    orgId = existing.id;
    if (input.orgName) {
      await db.update(organizations).set({ name: input.orgName, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    }
  } else {
    const [created] = await db
      .insert(organizations)
      .values({ clerkOrgId: input.clerkOrgId, name: input.orgName || "Organization", isPersonal: false })
      .returning({ id: organizations.id });
    orgId = created.id;
  }

  const [scope] = await db
    .select({ id: scopes.id })
    .from(scopes)
    .where(and(eq(scopes.orgId, orgId), eq(scopes.kind, "org_root")))
    .limit(1);
  let rootScopeId: string;
  if (scope) {
    rootScopeId = scope.id;
  } else {
    const [createdScope] = await db
      .insert(scopes)
      .values({ orgId, kind: "org_root", name: "All" })
      .returning({ id: scopes.id });
    rootScopeId = createdScope.id;
  }

  return { orgId, rootScopeId };
}

export type SyncOrgMembershipResult =
  | { status: "synced"; orgId: string; userId: string; backfilledLoops: number }
  | { status: "user_not_found" };

/**
 * Sync one Clerk org membership into Keeps: ensure the org + org_root scope, upsert the membership,
 * grant the member a scope_member edge to org_root, and backfill their loops into the shared org so
 * teammates can see their history. Returns user_not_found if the Clerk user hasn't synced yet
 * (Clerk's at-least-once retries will replay once user.created lands).
 */
export async function syncClerkOrgMembership(input: {
  clerkOrgId: string;
  orgName: string;
  clerkUserId: string;
  clerkRole: string | null | undefined;
  db?: AnyDb;
}): Promise<SyncOrgMembershipResult> {
  const db: AnyDb = input.db ?? getDb();
  const userId = await resolveKeepsUserId(input.clerkUserId, db);
  if (!userId) return { status: "user_not_found" };
  const role = mapClerkRole(input.clerkRole);

  return db.transaction(async (tx: AnyDb) => {
    const { orgId, rootScopeId } = await ensureSharedOrg(
      { clerkOrgId: input.clerkOrgId, orgName: input.orgName },
      tx,
    );

    // Upsert membership (role can change over time).
    const [existingMembership] = await tx
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .limit(1);
    if (existingMembership) {
      await tx.update(orgMemberships).set({ role }).where(eq(orgMemberships.id, existingMembership.id));
    } else {
      await tx.insert(orgMemberships).values({ orgId, userId, role });
    }

    // Grant (or re-activate) the scope_member edge to org_root — whole-org visibility for members.
    const [existingEdge] = await tx
      .select({ id: visibilityEdges.id, revokedAt: visibilityEdges.revokedAt })
      .from(visibilityEdges)
      .where(
        and(
          eq(visibilityEdges.orgId, orgId),
          eq(visibilityEdges.subjectUserId, userId),
          eq(visibilityEdges.relation, "scope_member"),
          eq(visibilityEdges.objectType, "scope"),
          eq(visibilityEdges.objectId, rootScopeId),
        ),
      )
      .limit(1);
    if (existingEdge) {
      if (existingEdge.revokedAt) {
        await tx.update(visibilityEdges).set({ revokedAt: null }).where(eq(visibilityEdges.id, existingEdge.id));
      }
    } else {
      await tx.insert(visibilityEdges).values({
        orgId,
        subjectUserId: userId,
        relation: "scope_member",
        objectType: "scope",
        objectId: rootScopeId,
      });
    }

    // Backfill: re-stamp the member's loops into the shared org + org_root so teammates see history.
    // Loops carry no org-uniqueness, so a plain re-stamp is safe (unlike entities, which need merge).
    const restamped = await tx
      .update(loops)
      .set({ orgId, scopeId: rootScopeId, updatedAt: new Date() })
      .where(eq(loops.userId, userId))
      .returning({ id: loops.id });

    return { status: "synced" as const, orgId, userId, backfilledLoops: restamped.length };
  });
}

/**
 * Remove a Clerk org membership: drop the Keeps membership and revoke the member's org edges, so
 * they immediately lose visibility into the org (canView fails closed without the membership/edge).
 * Their loops keep the org stamp (harmless — they can no longer load a viewer scope for that org).
 */
export async function removeClerkOrgMembership(input: {
  clerkOrgId: string;
  clerkUserId: string;
  db?: AnyDb;
}): Promise<{ status: "removed" | "user_not_found" | "org_not_found" }> {
  const db: AnyDb = input.db ?? getDb();
  const userId = await resolveKeepsUserId(input.clerkUserId, db);
  if (!userId) return { status: "user_not_found" };

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.clerkOrgId, input.clerkOrgId))
    .limit(1);
  if (!org) return { status: "org_not_found" };

  await db.transaction(async (tx: AnyDb) => {
    await tx
      .delete(orgMemberships)
      .where(and(eq(orgMemberships.orgId, org.id), eq(orgMemberships.userId, userId)));
    await tx
      .update(visibilityEdges)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(visibilityEdges.orgId, org.id),
          eq(visibilityEdges.subjectUserId, userId),
          isNull(visibilityEdges.revokedAt),
        ),
      );
  });
  return { status: "removed" };
}
