/**
 * visible-filter — the SQL twin of `canView` (Wave 0). Builds the Drizzle WHERE predicate that
 * scopes a query to exactly the rows `canView(viewer, row)` would return, so visibility is
 * enforced AT THE QUERY (not post-filtered in app code). The disjuncts mirror canView's branches
 * one-to-one; keep the two in lockstep — a divergence is a leak.
 *
 * Empty edge sets are omitted (never `inArray(col, [])`, which is a footgun); the self-ownership
 * disjunct is always present, so the OR is never empty and reads fail closed to "own rows only".
 */
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { entities, loops } from "@/db/schema";
import type { ViewerScope } from "@/visibility/can-view";

/** WHERE predicate equivalent to canView(viewer, loop). */
export function visibleLoopFilter(viewer: ViewerScope): SQL {
  const disjuncts: SQL[] = [eq(loops.userId, viewer.userId)];
  if (viewer.isOrgAdmin) disjuncts.push(sql`true`);
  if (viewer.managedUserIds.size > 0) {
    disjuncts.push(inArray(loops.userId, [...viewer.managedUserIds]));
  }
  if (viewer.scopeIds.size > 0) {
    disjuncts.push(inArray(loops.scopeId, [...viewer.scopeIds]));
  }
  if (viewer.sharedResourceIds.size > 0) {
    disjuncts.push(inArray(loops.id, [...viewer.sharedResourceIds]));
  }
  // org match AND (any visibility disjunct). Non-null: disjuncts always has ≥1 element.
  return and(eq(loops.orgId, viewer.orgId), or(...disjuncts)!)!;
}

/** WHERE predicate equivalent to canView(viewer, entity). */
export function visibleEntityFilter(viewer: ViewerScope): SQL {
  const disjuncts: SQL[] = [eq(entities.userId, viewer.userId)];
  if (viewer.isOrgAdmin) disjuncts.push(sql`true`);
  if (viewer.managedUserIds.size > 0) {
    disjuncts.push(inArray(entities.userId, [...viewer.managedUserIds]));
  }
  if (viewer.scopeIds.size > 0) {
    disjuncts.push(inArray(entities.scopeId, [...viewer.scopeIds]));
  }
  if (viewer.sharedResourceIds.size > 0) {
    disjuncts.push(inArray(entities.id, [...viewer.sharedResourceIds]));
  }
  return and(eq(entities.orgId, viewer.orgId), or(...disjuncts)!)!;
}
