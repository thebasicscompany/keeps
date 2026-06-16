/**
 * canView — THE visibility chokepoint (Wave 0, org-visibility re-founding).
 *
 * Pure, total, fails closed. Every read of org-owned data routes through this resolver (or its
 * SQL twin `visibleLoopFilter`/`visibleEntityFilter` in visible-filter.ts). No read path bypasses
 * it. A wrong `true` here is a confidentiality breach, so every branch fails closed.
 *
 * Visibility = union over the viewer's ACTIVE relation edges (Zanzibar-style), precomputed into a
 * `ViewerScope` by the (impure) loader from `visibility_edges` + memberships. This function NEVER
 * queries — it only decides. It is model-free (SR5): no model output influences a visibility grant.
 *
 * The degenerate solo case: a personal org of one whose viewer owns every resource → `canView`
 * is exactly "is this mine", which reproduces today's per-user behavior with zero config.
 */

export type ViewerScope = {
  userId: string;
  orgId: string;
  /** org_admin edge → whole-org visibility (owner/admin/COO role). */
  isOrgAdmin: boolean;
  /** user ids the viewer manages (manager_of edges) — down the reporting line. */
  managedUserIds: ReadonlySet<string>;
  /** scope ids the viewer is a member of (scope_member edges). */
  scopeIds: ReadonlySet<string>;
  /** specific resource ids explicitly shared with the viewer (explicit_share edges). */
  sharedResourceIds: ReadonlySet<string>;
};

export type ResourceDescriptor = {
  orgId: string;
  ownerUserId: string;
  /** scopes this resource belongs to (its deal/account/team tags). Empty = unscoped. */
  scopeIds: readonly string[];
  /** the resource's own id (loop id / entity id) — matched against explicit shares. */
  resourceId: string;
};

/**
 * Returns true iff `viewer` is authorized to see `resource`. Total + fails closed:
 * a missing/blank org on either side, or no connecting edge, yields false.
 */
export function canView(viewer: ViewerScope, resource: ResourceDescriptor): boolean {
  // Fail closed: cross-org (or unknown org) is never visible, regardless of any edge.
  if (!viewer.orgId || !resource.orgId || viewer.orgId !== resource.orgId) return false;

  // Own resource.
  if (resource.ownerUserId && resource.ownerUserId === viewer.userId) return true;

  // Whole-org scope (admin/owner/COO role).
  if (viewer.isOrgAdmin) return true;

  // Down the reporting line.
  if (resource.ownerUserId && viewer.managedUserIds.has(resource.ownerUserId)) return true;

  // Shared scope / deal team — any overlap.
  for (const scopeId of resource.scopeIds) {
    if (viewer.scopeIds.has(scopeId)) return true;
  }

  // Explicit one-off share of this exact resource.
  if (viewer.sharedResourceIds.has(resource.resourceId)) return true;

  // Default deny.
  return false;
}

/**
 * The minimal viewer scope: sees only their own resources within their org. This is the
 * degenerate solo case (a personal org of one) — no edges beyond self-ownership.
 */
export function selfOnlyScope(userId: string, orgId: string): ViewerScope {
  return {
    userId,
    orgId,
    isOrgAdmin: false,
    managedUserIds: new Set(),
    scopeIds: new Set(),
    sharedResourceIds: new Set(),
  };
}
