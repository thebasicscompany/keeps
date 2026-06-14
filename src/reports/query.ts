import type { LoopStatus } from "@/agent/schemas";
import { reportConfig, type ReportConfig } from "./config";

// ── Input types ──────────────────────────────────────────────────────────────

export type ReportLoopParticipant = { name?: string | null; email?: string | null };

export type ReportLoop = {
  id: string;
  // Full persisted status set incl. Phase 7 'suppressed' (excluded from recall buckets).
  status: LoopStatus;
  summary: string;
  ownerText: string | null;
  requesterText: string | null;
  dueAt: Date | null;
  confidence: number;
  participants: ReportLoopParticipant[];
  sourceQuote: string;
  sourceEvidenceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ReportLoopActivity = {
  loopId: string;
  lastActivityAt: Date | null; // null => no activity since creation
};

export type ReportKind = "insights" | "waiting_on" | "stale" | "weekly" | "entity";

// `entity` is the raw user-typed name/term (legacy substring fallback). `entityId` is the
// resolved entity-graph id the routing task populates (Phase 7 C1) — when present, the entity
// report is synthesized from the graph instead of a substring match over the flat loop list.
export type ReportScope = {
  entity?: string;
  entityId?: string;
  daysStale?: number;
} & Record<string, unknown>;

// ── Output types ─────────────────────────────────────────────────────────────

export type SectionKey =
  | "needs_you"
  | "due_soon"
  | "overdue"
  | "waiting_on_others"
  | "stale"
  | "recently_done";

export type ReportRow = { loop: ReportLoop; dueRelativeMs: number | null; importance: number };

export type ReportSection = { key: SectionKey; title: string; rows: ReportRow[] };

export type ReportSections = {
  kind: ReportKind;
  scope: ReportScope;
  now: Date;
  totalOpen: number;
  sections: ReportSection[];
};

// ── Section metadata (fixed order) ───────────────────────────────────────────

const SECTION_ORDER: Array<{ key: SectionKey; title: string }> = [
  { key: "needs_you", title: "Needs you" },
  { key: "due_soon", title: "Due soon" },
  { key: "overdue", title: "Overdue" },
  { key: "waiting_on_others", title: "Waiting on others" },
  { key: "stale", title: "Stale" },
  { key: "recently_done", title: "Recently done" },
];

// ── Entity matching ──────────────────────────────────────────────────────────

function matchesEntity(loop: ReportLoop, entity: string): boolean {
  const needle = entity.toLowerCase();
  const hasAt = needle.includes("@");

  // Check participants
  for (const p of loop.participants) {
    if (p.name && p.name.toLowerCase().includes(needle)) return true;
    if (p.email) {
      const emailLower = p.email.toLowerCase();
      if (emailLower.includes(needle)) return true;
      // Domain match: if needle has no '@', match against email domain
      if (!hasAt) {
        const atIdx = emailLower.indexOf("@");
        if (atIdx !== -1) {
          const domain = emailLower.slice(atIdx + 1);
          if (domain.includes(needle)) return true;
        }
      }
    }
  }

  // Check ownerText
  if (loop.ownerText && loop.ownerText.toLowerCase().includes(needle)) return true;

  // Check requesterText
  if (loop.requesterText && loop.requesterText.toLowerCase().includes(needle)) return true;

  // Check sourceQuote
  if (loop.sourceQuote && loop.sourceQuote.toLowerCase().includes(needle)) return true;

  return false;
}

// ── Importance scoring ───────────────────────────────────────────────────────

function computeImportance(
  loop: ReportLoop,
  now: Date,
  lastActivityAt: Date | null,
): number {
  const nowMs = now.getTime();
  const dueMs = loop.dueAt ? loop.dueAt.getTime() : null;

  // Primary: due proximity
  let primary = 0;
  if (dueMs !== null) {
    if (dueMs < nowMs) {
      primary = 3; // overdue
    } else if (dueMs <= nowMs + 24 * 60 * 60 * 1000) {
      primary = 2; // due within 24h
    } else if (dueMs <= nowMs + 7 * 24 * 60 * 60 * 1000) {
      primary = 1; // due within 7d
    }
  }

  // Secondary: waiting duration (log-scaled days since last activity or createdAt)
  const activityTs = lastActivityAt ?? loop.createdAt;
  const daysSinceActivity = (nowMs - activityTs.getTime()) / (1000 * 60 * 60 * 24);
  const secondary = Math.log1p(daysSinceActivity);

  // Tertiary: confidence (higher first)
  const tertiary = loop.confidence;

  return primary * 1000 + secondary * 10 + tertiary;
}

// ── Main assembleReport function ──────────────────────────────────────────────

export function assembleReport(input: {
  kind: ReportKind;
  scope: ReportScope;
  now: Date;
  loops: ReportLoop[];
  loopActivity: ReportLoopActivity[];
  config?: ReportConfig;
}): ReportSections {
  const { kind, scope, now, loops, loopActivity, config = reportConfig } = input;
  const nowMs = now.getTime();

  // Build activity lookup map
  const activityMap = new Map<string, Date | null>();
  for (const a of loopActivity) {
    activityMap.set(a.loopId, a.lastActivityAt);
  }

  // Derived thresholds
  const needsYouCutoffMs = nowMs + config.needsYouHours * 60 * 60 * 1000;
  const dueSoonCutoffMs = nowMs + config.dueSoonDays * 24 * 60 * 60 * 1000;
  const staleCutoffMs = nowMs - config.staleDays * 24 * 60 * 60 * 1000;
  const recentlyDoneCutoffMs = nowMs - config.recentlyDoneDays * 24 * 60 * 60 * 1000;

  // Filter loops
  let workingLoops = loops;

  // Entity scoping: only filter when kind === 'entity' and entity is non-empty
  if (kind === "entity" && scope.entity && scope.entity.length > 0) {
    workingLoops = workingLoops.filter((l) => matchesEntity(l, scope.entity!));
  }

  // Exclude candidate, blocked, dismissed from all sections
  // (they won't match any predicate anyway, but be explicit)
  workingLoops = workingLoops.filter(
    (l) => l.status !== "candidate" && l.status !== "blocked" && l.status !== "dismissed",
  );

  // Count totalOpen before bucketing (open|waiting_on_me|waiting_on_other after scope filter)
  const totalOpen = workingLoops.filter(
    (l) =>
      l.status === "open" ||
      l.status === "waiting_on_me" ||
      l.status === "waiting_on_other",
  ).length;

  // Section buckets
  const buckets = new Map<SectionKey, ReportLoop[]>();
  for (const s of SECTION_ORDER) {
    buckets.set(s.key, []);
  }

  // Assign each loop to the first matching section (first-match-wins)
  for (const loop of workingLoops) {
    const dueMs = loop.dueAt ? loop.dueAt.getTime() : null;
    const lastActivityAt = activityMap.has(loop.id) ? activityMap.get(loop.id)! : null;
    // Effective activity timestamp: use lastActivityAt if present, else createdAt
    const effectiveActivityMs = (lastActivityAt ?? loop.createdAt).getTime();

    let assigned = false;

    // 1. needs_you: status === waiting_on_me, OR (status === open AND dueAt <= now + 48h)
    if (
      loop.status === "waiting_on_me" ||
      (loop.status === "open" && dueMs !== null && dueMs <= needsYouCutoffMs)
    ) {
      buckets.get("needs_you")!.push(loop);
      assigned = true;
    }

    // 2. due_soon: dueAt in (now, now+7d] and NOT already assigned
    if (!assigned && dueMs !== null && dueMs > nowMs && dueMs <= dueSoonCutoffMs) {
      buckets.get("due_soon")!.push(loop);
      assigned = true;
    }

    // 3. overdue: dueAt < now and status NOT in (done, dismissed, snoozed)
    if (
      !assigned &&
      dueMs !== null &&
      dueMs < nowMs &&
      loop.status !== "done" &&
      loop.status !== "dismissed" &&
      loop.status !== "snoozed"
    ) {
      buckets.get("overdue")!.push(loop);
      assigned = true;
    }

    // 4. waiting_on_others: status === waiting_on_other
    if (!assigned && loop.status === "waiting_on_other") {
      buckets.get("waiting_on_others")!.push(loop);
      assigned = true;
    }

    // 5. stale: status in (open, waiting_on_me, waiting_on_other) AND effectiveActivity <= now - staleDays
    if (
      !assigned &&
      (loop.status === "open" ||
        loop.status === "waiting_on_me" ||
        loop.status === "waiting_on_other") &&
      effectiveActivityMs <= staleCutoffMs
    ) {
      buckets.get("stale")!.push(loop);
      assigned = true;
    }

    // 6. recently_done: status === done AND updatedAt >= now - recentlyDoneDays
    if (!assigned && loop.status === "done" && loop.updatedAt.getTime() >= recentlyDoneCutoffMs) {
      buckets.get("recently_done")!.push(loop);
      assigned = true;
    }

    // Fallback: an `open` loop that matched no urgency/stale bucket (e.g. no due date and
    // recently active) still needs the user. Surface it under "Needs you" so EVERY
    // counted-open loop appears somewhere — otherwise such loops are invisible in the
    // report even though they are included in `totalOpen` (caught in the Phase 5 live
    // wave: an undated, freshly-updated open loop produced an empty report + a hallucinated
    // model summary). waiting_on_me is always caught by section 1 and waiting_on_other by
    // section 4, so `open` is the only status that can orphan here.
    if (!assigned && loop.status === "open") {
      buckets.get("needs_you")!.push(loop);
      assigned = true;
    }

    void assigned; // suppress unused warning — intentional fallthrough for unmatched loops
  }

  // Build sections in fixed order with importance-sorted rows
  const sections: ReportSection[] = SECTION_ORDER.map(({ key, title }) => {
    const sectionLoops = buckets.get(key)!;

    const rows: ReportRow[] = sectionLoops.map((loop) => {
      const lastActivityAt = activityMap.has(loop.id) ? activityMap.get(loop.id)! : null;
      const dueRelativeMs = loop.dueAt ? loop.dueAt.getTime() - nowMs : null;
      const importance = computeImportance(loop, now, lastActivityAt);
      return { loop, dueRelativeMs, importance };
    });

    // Sort by importance DESC, stable (JS sort is stable since ES2019)
    rows.sort((a, b) => b.importance - a.importance);

    return { key, title, rows };
  });

  return {
    kind,
    scope,
    now,
    totalOpen,
    sections,
  };
}

// ── Entity status report (Phase 7 C1) ─────────────────────────────────────────
//
// A real entity-scoped view assembled from the entity graph (NOT a substring match).
// Deterministic code gathers a FIXED, ORDERED, serialization-safe slice for ONE entity;
// the model later writes ONLY prose over this slice (AR-8) and may reference only these rows.

/** Open statuses surfaced as active work on an entity. */
const ENTITY_OPEN_STATUSES: ReadonlySet<LoopStatus> = new Set([
  "candidate",
  "open",
  "waiting_on_me",
  "waiting_on_other",
  "blocked",
  "snoozed",
]);
/** Closed statuses surfaced as resolved work on an entity. */
const ENTITY_CLOSED_STATUSES: ReadonlySet<LoopStatus> = new Set(["done", "dismissed"]);

export type EntityReportLoop = {
  id: string;
  status: LoopStatus;
  summary: string;
  dueAtIso: string | null;
  confidence: number;
  /** Roles the entity plays on this loop (owner/requester/participant), deduped + sorted. */
  roles: string[];
  emailThreadId: string;
  createdAtIso: string;
  updatedAtIso: string;
};

export type EntityReportEvent = {
  loopId: string;
  eventType: string;
  createdAtIso: string;
};

export type EntityReportSlice = {
  entity: {
    id: string;
    displayName: string;
    kind: string;
    canonicalEmail: string | null;
    firstSeenAtIso: string;
    lastSeenAtIso: string;
  };
  openLoops: EntityReportLoop[];
  closedLoops: EntityReportLoop[];
  openCount: number;
  closedCount: number;
  threadCount: number;
  mostRecentThreadId: string | null;
  /** Last ~15 loop_events across the entity's loops, newest first. */
  recentEvents: EntityReportEvent[];
};

/**
 * Minimal injectable DB surface for entity assembly — just enough to satisfy the four
 * reads below. Kept structural so DB-gated tests pass the real Drizzle handle and the
 * production caller defaults to getDb() (resolved lazily, never at module top level).
 */
type EntityReportDb = {
  // biome-ignore lint/suspicious/noExplicitAny: structural Drizzle query-builder surface
  select: (...args: any[]) => any;
};

/**
 * Assemble the deterministic entity slice. Gathers the entity row, every NON-suppressed
 * loop linked to it (via loop_entities OR loops.owner/requesterEntityId, deduped), grouped
 * OPEN vs CLOSED, the distinct linked-thread count + most-recent thread, and the recent
 * loop_events timeline. All timestamps are ISO strings; ordering is fixed (open by recency,
 * closed by recency, events newest-first) so the slice is a stable, serialization-safe
 * context for the model.
 */
export async function assembleEntityReport(input: {
  userId: string;
  entityId: string;
  clock?: () => Date;
  db?: EntityReportDb;
}): Promise<EntityReportSlice | null> {
  const { userId, entityId } = input;

  // Lazy imports — getDb() must never run at module load (NODE test env has no DB).
  const { and, desc, eq, inArray, or } = await import("drizzle-orm");
  const { entities, loopEntities, loopEvents, loops } = await import("@/db/schema");
  let db = input.db;
  if (!db) {
    const { getDb } = await import("@/db/client");
    db = getDb() as unknown as EntityReportDb;
  }

  // ── 1. Entity row (scoped by user) ──────────────────────────────────────────
  const [entityRow] = await db
    .select({
      id: entities.id,
      displayName: entities.displayName,
      kind: entities.kind,
      canonicalEmail: entities.canonicalEmail,
      firstSeenAt: entities.firstSeenAt,
      lastSeenAt: entities.lastSeenAt,
    })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.userId, userId)))
    .limit(1);

  if (!entityRow) return null;

  // ── 2. Loop ids linked to the entity (join roles + the two FK columns), deduped ──
  const joinRows: Array<{ loopId: string; role: string }> = await db
    .select({ loopId: loopEntities.loopId, role: loopEntities.role })
    .from(loopEntities)
    .where(eq(loopEntities.entityId, entityId));

  const fkRows: Array<{
    id: string;
    ownerEntityId: string | null;
    requesterEntityId: string | null;
  }> = await db
    .select({
      id: loops.id,
      ownerEntityId: loops.ownerEntityId,
      requesterEntityId: loops.requesterEntityId,
    })
    .from(loops)
    .where(
      and(
        eq(loops.userId, userId),
        or(eq(loops.ownerEntityId, entityId), eq(loops.requesterEntityId, entityId)),
      ),
    );

  // rolesByLoop: union of join-table roles + the FK-derived owner/requester roles. A loop
  // can carry the entity as BOTH owner and requester FK — both roles are added.
  const rolesByLoop = new Map<string, Set<string>>();
  const addRole = (loopId: string, role: string) => {
    let set = rolesByLoop.get(loopId);
    if (!set) {
      set = new Set<string>();
      rolesByLoop.set(loopId, set);
    }
    set.add(role);
  };
  for (const r of joinRows) addRole(r.loopId, r.role);
  for (const r of fkRows) {
    if (r.ownerEntityId === entityId) addRole(r.id, "owner");
    if (r.requesterEntityId === entityId) addRole(r.id, "requester");
  }

  const loopIds = [...rolesByLoop.keys()];
  if (loopIds.length === 0) {
    return {
      entity: {
        id: entityRow.id,
        displayName: entityRow.displayName,
        kind: entityRow.kind,
        canonicalEmail: entityRow.canonicalEmail ?? null,
        firstSeenAtIso: toIso(entityRow.firstSeenAt),
        lastSeenAtIso: toIso(entityRow.lastSeenAt),
      },
      openLoops: [],
      closedLoops: [],
      openCount: 0,
      closedCount: 0,
      threadCount: 0,
      mostRecentThreadId: null,
      recentEvents: [],
    };
  }

  // ── 3. Load the linked loops (scoped by user; EXCLUDE suppressed entirely) ───
  const loopRows: Array<{
    id: string;
    status: LoopStatus;
    summary: string;
    dueAt: Date | null;
    confidence: number;
    emailThreadId: string;
    createdAt: Date;
    updatedAt: Date;
  }> = await db
    .select({
      id: loops.id,
      status: loops.status,
      summary: loops.summary,
      dueAt: loops.dueAt,
      confidence: loops.confidence,
      emailThreadId: loops.emailThreadId,
      createdAt: loops.createdAt,
      updatedAt: loops.updatedAt,
    })
    .from(loops)
    .where(and(eq(loops.userId, userId), inArray(loops.id, loopIds)));

  const visibleLoops = loopRows.filter((l) => l.status !== "suppressed");

  const toEntityLoop = (l: (typeof visibleLoops)[number]): EntityReportLoop => ({
    id: l.id,
    status: l.status,
    summary: l.summary,
    dueAtIso: l.dueAt ? toIso(l.dueAt) : null,
    confidence: l.confidence,
    roles: [...(rolesByLoop.get(l.id) ?? new Set<string>())].sort(),
    emailThreadId: l.emailThreadId,
    createdAtIso: toIso(l.createdAt),
    updatedAtIso: toIso(l.updatedAt),
  });

  const byRecency = (a: EntityReportLoop, b: EntityReportLoop) =>
    b.updatedAtIso.localeCompare(a.updatedAtIso);

  const openLoops = visibleLoops
    .filter((l) => ENTITY_OPEN_STATUSES.has(l.status))
    .map(toEntityLoop)
    .sort(byRecency);
  const closedLoops = visibleLoops
    .filter((l) => ENTITY_CLOSED_STATUSES.has(l.status))
    .map(toEntityLoop)
    .sort(byRecency);

  // ── 4. Distinct linked threads + most-recent thread (by newest loop update) ──
  const threadIds = new Set<string>();
  let mostRecentThreadId: string | null = null;
  let mostRecentUpdate = "";
  for (const l of visibleLoops) {
    threadIds.add(l.emailThreadId);
    const u = toIso(l.updatedAt);
    if (u > mostRecentUpdate) {
      mostRecentUpdate = u;
      mostRecentThreadId = l.emailThreadId;
    }
  }

  // ── 5. Recent loop_events across the visible loops (last ~15, newest first) ──
  const visibleLoopIds = visibleLoops.map((l) => l.id);
  let recentEvents: EntityReportEvent[] = [];
  if (visibleLoopIds.length > 0) {
    const eventRows: Array<{ loopId: string; eventType: string; createdAt: Date }> = await db
      .select({
        loopId: loopEvents.loopId,
        eventType: loopEvents.eventType,
        createdAt: loopEvents.createdAt,
      })
      .from(loopEvents)
      .where(inArray(loopEvents.loopId, visibleLoopIds))
      .orderBy(desc(loopEvents.createdAt))
      .limit(15);
    recentEvents = eventRows.map((e) => ({
      loopId: e.loopId,
      eventType: e.eventType,
      createdAtIso: toIso(e.createdAt),
    }));
  }

  return {
    entity: {
      id: entityRow.id,
      displayName: entityRow.displayName,
      kind: entityRow.kind,
      canonicalEmail: entityRow.canonicalEmail ?? null,
      firstSeenAtIso: toIso(entityRow.firstSeenAt),
      lastSeenAtIso: toIso(entityRow.lastSeenAt),
    },
    openLoops,
    closedLoops,
    openCount: openLoops.length,
    closedCount: closedLoops.length,
    threadCount: threadIds.size,
    mostRecentThreadId,
    recentEvents,
  };
}

/** Coerce a DB timestamp (Date | string) to a stable ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Project the entity slice into a ReportSections shape so the existing email builder,
 * /r page, and ordinalMap (which all consume sections[].rows[].loop) render an entity
 * report with NO new view code. Open loops → an "Open" section (most-recent first),
 * closed → "Recently done". `now` is injected so the result is deterministic.
 */
export function entitySliceToSections(slice: EntityReportSlice, now: Date): ReportSections {
  const toRow = (l: EntityReportLoop): ReportRow => ({
    loop: {
      id: l.id,
      status: l.status,
      summary: l.summary,
      ownerText: null,
      requesterText: null,
      dueAt: l.dueAtIso ? new Date(l.dueAtIso) : null,
      confidence: l.confidence,
      participants: [],
      sourceQuote: "",
      sourceEvidenceId: "",
      createdAt: new Date(l.createdAtIso),
      updatedAt: new Date(l.updatedAtIso),
    },
    dueRelativeMs: l.dueAtIso ? new Date(l.dueAtIso).getTime() - now.getTime() : null,
    importance: 0,
  });

  const sections: ReportSection[] = [
    { key: "needs_you", title: "Open", rows: slice.openLoops.map(toRow) },
    { key: "recently_done", title: "Recently done", rows: slice.closedLoops.map(toRow) },
  ];

  return {
    kind: "entity",
    scope: {
      entityId: slice.entity.id,
      entity: slice.entity.displayName,
      entityKind: slice.entity.kind,
      firstSeenAt: slice.entity.firstSeenAtIso,
      lastSeenAt: slice.entity.lastSeenAtIso,
      closedCount: slice.closedCount,
    },
    now,
    totalOpen: slice.openCount,
    sections,
  };
}
