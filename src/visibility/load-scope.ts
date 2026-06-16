/**
 * ViewerScope loader (Wave 0) — turns a user's org membership + active visibility_edges into the
 * precomputed `ViewerScope` that `canView` / `visibleLoopFilter` consume. The fold is PURE +
 * model-free (`assembleViewerScope`); only the thin `loadViewerScope` wrapper touches the DB.
 *
 * Fails closed: a user with no membership in the requested org → null (the caller treats null as
 * "no visibility", i.e. sees nothing — never a wide-open default).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { orgMemberships, organizations, scopes, visibilityEdges } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { OrgMemberRole, VisibilityEdge } from "@/db/schema";
import type { ViewerScope } from "@/visibility/can-view";

/** The edge fields the scope assembler needs (a subset of VisibilityEdge). */
export type ScopeEdge = Pick<VisibilityEdge, "relation" | "objectType" | "objectId">;

/**
 * PURE: fold a member's role + their active edges into a ViewerScope. Total + model-free.
 * isOrgAdmin is true for an owner/admin role OR an explicit org_admin edge (defense in depth).
 */
export function assembleViewerScope(input: {
  userId: string;
  orgId: string;
  role: OrgMemberRole;
  edges: ScopeEdge[];
}): ViewerScope {
  const managedUserIds = new Set<string>();
  const scopeIds = new Set<string>();
  const sharedResourceIds = new Set<string>();
  let adminEdge = false;

  for (const e of input.edges) {
    if (e.relation === "org_admin") {
      adminEdge = true;
    } else if (e.relation === "manager_of" && e.objectType === "user") {
      managedUserIds.add(e.objectId);
    } else if (e.relation === "scope_member" && e.objectType === "scope") {
      scopeIds.add(e.objectId);
    } else if (e.relation === "explicit_share" && (e.objectType === "loop" || e.objectType === "entity")) {
      sharedResourceIds.add(e.objectId);
    }
  }

  return {
    userId: input.userId,
    orgId: input.orgId,
    isOrgAdmin: input.role === "owner" || input.role === "admin" || adminEdge,
    managedUserIds,
    scopeIds,
    sharedResourceIds,
  };
}

/**
 * Loads the viewer's scope for an org. With no `orgId`, picks the user's first membership
 * (the degenerate solo case has exactly one — their personal org). Returns null when the user
 * has no membership in the requested org (fail closed).
 */
export async function loadViewerScope(input: {
  userId: string;
  orgId?: string;
  db?: PostgresJsDatabase<typeof schema>;
}): Promise<ViewerScope | null> {
  const db = input.db ?? (getDb() as PostgresJsDatabase<typeof schema>);

  // Join org so we can prefer a SHARED (non-personal) org over the personal one when no orgId is
  // given — a user in a real team operates in the team's context, not their solo personal org.
  const memberships = await db
    .select({ orgId: orgMemberships.orgId, role: orgMemberships.role, isPersonal: organizations.isPersonal })
    .from(orgMemberships)
    .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
    .where(eq(orgMemberships.userId, input.userId));
  if (memberships.length === 0) return null;

  const membership = input.orgId
    ? memberships.find((m) => m.orgId === input.orgId)
    : (memberships.find((m) => !m.isPersonal) ?? memberships[0]);
  if (!membership) return null;

  const edges = await db
    .select({
      relation: visibilityEdges.relation,
      objectType: visibilityEdges.objectType,
      objectId: visibilityEdges.objectId,
    })
    .from(visibilityEdges)
    .where(
      and(
        eq(visibilityEdges.subjectUserId, input.userId),
        eq(visibilityEdges.orgId, membership.orgId),
        isNull(visibilityEdges.revokedAt),
      ),
    );

  return assembleViewerScope({
    userId: input.userId,
    orgId: membership.orgId,
    role: membership.role,
    edges,
  });
}

/**
 * The org + org_root scope that NEW captures should be stamped with: the user's SHARED org if they
 * belong to one (so teammates can see the capture via org_root), else their personal org. Null if
 * the user has no membership or the org has no root scope (fail closed → leave the capture
 * unstamped / per-user). Used by the capture path so new loops join the shared graph.
 */
export async function resolveActiveOrgScope(input: {
  userId: string;
  db?: PostgresJsDatabase<typeof schema>;
}): Promise<{ orgId: string; rootScopeId: string } | null> {
  const db = input.db ?? (getDb() as PostgresJsDatabase<typeof schema>);
  const memberships = await db
    .select({ orgId: orgMemberships.orgId, isPersonal: organizations.isPersonal })
    .from(orgMemberships)
    .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
    .where(eq(orgMemberships.userId, input.userId));
  if (memberships.length === 0) return null;

  const chosen = memberships.find((m) => !m.isPersonal) ?? memberships[0];
  const [scope] = await db
    .select({ id: scopes.id })
    .from(scopes)
    .where(and(eq(scopes.orgId, chosen.orgId), eq(scopes.kind, "org_root")))
    .limit(1);
  if (!scope) return null;
  return { orgId: chosen.orgId, rootScopeId: scope.id };
}
