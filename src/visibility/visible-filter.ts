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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inline a list of UUIDs as a Postgres `ARRAY[...]::uuid[]` literal. drizzle's sql tag
 * serializes a JS array as a row-constructor tuple, which is invalid on the right of `= ANY(...)`,
 * so the proven pattern (used in extraction-context.ts) is to inline. We hard-guard every value
 * to the UUID shape first — these flow from visibility_edges, but inlining without a guard is a
 * latent injection footgun, so fail closed on anything that isn't a UUID.
 */
function uuidArrayLiteral(ids: string[]): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`uuidArrayLiteral: non-uuid value ${id}`);
  }
  return `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`;
}

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

/**
 * Raw-SQL twin of `visibleLoopFilter`, for the trigram/count generators that hand-write SQL over
 * a `loops` alias (e.g. "l"). Mirrors canView branch-for-branch. The org clause + the
 * self-ownership disjunct are always present (fail closed to "own rows in my org").
 */
export function visibleLoopSql(viewer: ViewerScope, alias: string): SQL {
  if (!UUID_RE.test(viewer.orgId)) throw new Error("visibleLoopSql: non-uuid orgId");
  if (!UUID_RE.test(viewer.userId)) throw new Error("visibleLoopSql: non-uuid userId");
  const a = sql.raw(alias);

  const disjuncts: SQL[] = [sql`${a}.user_id = ${viewer.userId}::uuid`];
  if (viewer.isOrgAdmin) disjuncts.push(sql`true`);
  if (viewer.managedUserIds.size > 0) {
    disjuncts.push(sql`${a}.user_id = ANY(${sql.raw(uuidArrayLiteral([...viewer.managedUserIds]))})`);
  }
  if (viewer.scopeIds.size > 0) {
    disjuncts.push(sql`${a}.scope_id = ANY(${sql.raw(uuidArrayLiteral([...viewer.scopeIds]))})`);
  }
  if (viewer.sharedResourceIds.size > 0) {
    disjuncts.push(sql`${a}.id = ANY(${sql.raw(uuidArrayLiteral([...viewer.sharedResourceIds]))})`);
  }

  let ored: SQL = disjuncts[0];
  for (let i = 1; i < disjuncts.length; i++) ored = sql`${ored} OR ${disjuncts[i]}`;
  return sql`(${a}.org_id = ${viewer.orgId}::uuid AND (${ored}))`;
}
