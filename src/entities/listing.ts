/**
 * entities/listing — the user-facing knowledge-graph query.
 *
 * Lists every ACTIVE entity (people + companies) Keeps has resolved for a user,
 * each with its open/closed loop counts and open loops, then links people to
 * their company by email domain — i.e. the graph in browsable form. Read-only;
 * the page at /settings/graph renders it.
 *
 * Loops are gathered through loop_entities (which already carries owner /
 * requester / participant rows from capture), excluding the 'suppressed'
 * decider-only state — mirroring assembleEntityReport's visibility rules.
 */

import { and, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { entities, loopEntities, loops } from "@/db/schema";
import type { LoopStatus } from "@/agent/schemas";
import { isOrgVisibilityEnabled } from "@/config/env";
import { loadViewerScope } from "@/visibility/load-scope";
import { visibleLoopFilter } from "@/visibility/visible-filter";

type Db = ReturnType<typeof getDb>;

const OPEN_STATUSES = new Set<LoopStatus>([
  "candidate",
  "open",
  "waiting_on_me",
  "waiting_on_other",
  "blocked",
  "snoozed",
]);
const CLOSED_STATUSES = new Set<LoopStatus>(["done", "dismissed"]);

export type GraphLoop = {
  id: string;
  summary: string;
  status: LoopStatus;
  dueAtIso: string | null;
  updatedAtIso: string;
  roles: string[];
};

export type GraphEntity = {
  id: string;
  displayName: string;
  kind: "person" | "company" | "other";
  canonicalEmail: string | null;
  domain: string | null;
  firstSeenAtIso: string;
  lastSeenAtIso: string;
  openCount: number;
  closedCount: number;
  openLoops: GraphLoop[];
};

export type GraphCompany = GraphEntity & { people: GraphEntity[] };

export type UserGraph = {
  companies: GraphCompany[];
  /** People NOT attached to a known company (personal / freemail addresses). */
  people: GraphEntity[];
  totals: { entities: number; companies: number; people: number; openLoops: number };
};

function domainOf(kind: string, canonicalEmail: string | null, metadata: unknown): string | null {
  if (kind === "company") {
    const meta = metadata as { domain?: string } | null;
    return meta?.domain ?? null;
  }
  const at = canonicalEmail?.lastIndexOf("@") ?? -1;
  return at >= 0 ? canonicalEmail!.slice(at + 1).toLowerCase() : null;
}

export async function getUserGraph(userId: string, dbHandle?: Db): Promise<UserGraph> {
  const db = dbHandle ?? getDb();

  // Visibility (Wave 6): when org-visibility is on, the graph shows every loop the viewer can SEE
  // (their own + whole-org shared, via visibleLoopFilter / canView) and the entities those loops
  // reference — so teammates' shared loops appear, and nothing across an org boundary ever does.
  // Flag off (or no scope) → own loops only, byte-for-byte the legacy per-user graph.
  // Loop-FIRST (vs entity-first): an entity surfaces only through an authorized loop, so this can
  // never leak a contact the viewer isn't entitled to, and needs no cross-member entity merge.
  const viewerScope = isOrgVisibilityEnabled()
    ? await loadViewerScope({ userId, db: db as Parameters<typeof loadViewerScope>[0]["db"] })
    : null;
  const loopWhere: SQL = viewerScope ? visibleLoopFilter(viewerScope) : eq(loops.userId, userId);

  // 1. Visible loop links (excluding the suppressed decider-only state).
  const links = await db
    .select({
      entityId: loopEntities.entityId,
      role: loopEntities.role,
      loopId: loops.id,
      summary: loops.summary,
      status: loops.status,
      dueAt: loops.dueAt,
      updatedAt: loops.updatedAt,
    })
    .from(loopEntities)
    .innerJoin(loops, eq(loops.id, loopEntities.loopId))
    .where(and(loopWhere, ne(loops.status, "suppressed")));

  if (links.length === 0) {
    return { companies: [], people: [], totals: { entities: 0, companies: 0, people: 0, openLoops: 0 } };
  }

  const entityIds = [...new Set(links.map((l) => l.entityId))];

  // 2. The (active, non-merged) entities those visible loops reference.
  const rows = await db
    .select({
      id: entities.id,
      displayName: entities.displayName,
      kind: entities.kind,
      canonicalEmail: entities.canonicalEmail,
      metadata: entities.metadata,
      firstSeenAt: entities.firstSeenAt,
      lastSeenAt: entities.lastSeenAt,
    })
    .from(entities)
    .where(and(inArray(entities.id, entityIds), isNull(entities.mergedIntoEntityId)));

  if (rows.length === 0) {
    return { companies: [], people: [], totals: { entities: 0, companies: 0, people: 0, openLoops: 0 } };
  }

  // 3. Per-entity loop map (dedupe by loopId, union roles).
  type Acc = { loop: (typeof links)[number]; roles: Set<string> };
  const byEntity = new Map<string, Map<string, Acc>>();
  const distinctOpenLoopIds = new Set<string>();
  for (const l of links) {
    let m = byEntity.get(l.entityId);
    if (!m) byEntity.set(l.entityId, (m = new Map()));
    let row = m.get(l.loopId);
    if (!row) m.set(l.loopId, (row = { loop: l, roles: new Set() }));
    row.roles.add(l.role);
    if (OPEN_STATUSES.has(l.status as LoopStatus)) distinctOpenLoopIds.add(l.loopId);
  }

  const toGraphEntity = (r: (typeof rows)[number]): GraphEntity => {
    const loopRows = [...(byEntity.get(r.id)?.values() ?? [])];
    const open = loopRows.filter((x) => OPEN_STATUSES.has(x.loop.status as LoopStatus));
    const closed = loopRows.filter((x) => CLOSED_STATUSES.has(x.loop.status as LoopStatus));
    open.sort((a, b) => (b.loop.updatedAt?.getTime() ?? 0) - (a.loop.updatedAt?.getTime() ?? 0));
    return {
      id: r.id,
      displayName: r.displayName,
      kind: r.kind,
      canonicalEmail: r.canonicalEmail,
      domain: domainOf(r.kind, r.canonicalEmail, r.metadata),
      firstSeenAtIso: (r.firstSeenAt ?? new Date()).toISOString(),
      lastSeenAtIso: (r.lastSeenAt ?? new Date()).toISOString(),
      openCount: open.length,
      closedCount: closed.length,
      openLoops: open.map((x) => ({
        id: x.loop.loopId,
        summary: x.loop.summary,
        status: x.loop.status as LoopStatus,
        dueAtIso: x.loop.dueAt ? x.loop.dueAt.toISOString() : null,
        updatedAtIso: (x.loop.updatedAt ?? new Date()).toISOString(),
        roles: [...x.roles].sort(),
      })),
    };
  };

  const all = rows.map(toGraphEntity);
  const companies = all.filter((e) => e.kind === "company");
  const persons = all.filter((e) => e.kind !== "company");

  // 4. Link people to their company by domain.
  const companyByDomain = new Map<string, GraphCompany>();
  const companiesOut: GraphCompany[] = companies.map((c) => {
    const out: GraphCompany = { ...c, people: [] };
    if (c.domain) companyByDomain.set(c.domain, out);
    return out;
  });

  const standalone: GraphEntity[] = [];
  for (const p of persons) {
    const company = p.domain ? companyByDomain.get(p.domain) : undefined;
    if (company) company.people.push(p);
    else standalone.push(p);
  }

  const byRecency = (a: GraphEntity, b: GraphEntity) => b.lastSeenAtIso.localeCompare(a.lastSeenAtIso);
  companiesOut.forEach((c) => c.people.sort(byRecency));
  companiesOut.sort((a, b) => b.openCount - a.openCount || byRecency(a, b));
  standalone.sort((a, b) => b.openCount - a.openCount || byRecency(a, b));

  return {
    companies: companiesOut,
    people: standalone,
    totals: {
      entities: all.length,
      companies: companies.length,
      people: persons.length,
      openLoops: distinctOpenLoopIds.size,
    },
  };
}
