/**
 * agent/extraction-context — per-extraction CONTEXT LOADER (Phase 7 B3)
 *
 * Loads the set of open loops + known entities that should be injected into
 * context-aware extraction (B1/B2). This is RETRIEVAL ONLY: it never creates
 * or mutates any rows. The goal is HIGH RECALL (cast a wide net); the
 * downstream decider is strict.
 *
 * Four candidate generators are union-merged, deduplicated, scored, and capped:
 *   A "thread"  — same emailThreadId as the inbound email
 *   B "entity"  — loops linked to a participant entity
 *   C "trigram" — trigram similarity on loop summary vs. queryText
 *   D "recent"  — most-recently-updated open loops (prevents empty context)
 *
 * Scoring weights (documented here for eval tuning):
 *   thread   +1.0  (highest — same conversation is strongest signal)
 *   entity   +0.7  (cross-thread but same person)
 *   trigram  +0.5 × similarity score (0–1 range, threshold 0.15)
 *   recent   +0.2  (decay factor, acts as fallback floor)
 *
 * Trigram threshold: 0.15 — deliberately low, wide net. The decider decides.
 *
 * All output is serialization-safe (ISO strings, no Date objects, no class instances).
 */

import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { entities, loopEntities, loops } from "@/db/schema";
import type { EntityKind } from "@/db/schema";
import { normalizeEmail } from "@/entities/resolve";
import type { LoopStatus } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Public types (stable — imported by B1 and B2)
// ---------------------------------------------------------------------------

export type CompactLoop = {
  id: string;                 // real loop id (decider uses it; do NOT show to the model)
  refId: string;              // opaque short id for the prompt, e.g. "L1","L2" (anti-anchoring)
  summary: string;
  status: LoopStatus;
  ownerText: string | null;
  requesterText: string | null;
  emailThreadId: string;      // STRUCTURED SIGNAL: same-thread check
  entityIds: string[];        // STRUCTURED SIGNAL: linked entity ids (owner/requester/participant)
  dueAt: string | null;       // ISO or null
  updatedAt: string;          // ISO
  generators: Array<"thread" | "entity" | "trigram" | "recent">; // which generator(s) surfaced it
  score: number;              // blended retrieval score (for ordering/capping)
};

export type CompactEntity = {
  id: string;
  displayName: string;
  kind: EntityKind;
  canonicalEmail: string | null;
  openLoopCount: number;
};

export type ExtractionContext = {
  openLoops: CompactLoop[];
  knownEntities: CompactEntity[];
};

export type LoadExtractionContextInput = {
  userId: string;
  threadId: string | null;            // the inbound email's emailThreadId
  participants: { name: string | null; email: string | null }[];
  queryText?: string | null;          // subject + short snippet for the trigram generator
  limit?: number;                     // max openLoops to return; default 10
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of statuses that constitute "open" for context purposes.
 * Excludes 'done', 'dismissed', 'suppressed'.
 */
export const OPEN_STATUSES: LoopStatus[] = [
  "candidate",
  "open",
  "waiting_on_me",
  "waiting_on_other",
  "blocked",
  "snoozed",
];

const DEFAULT_LIMIT = 10;
const TRIGRAM_THRESHOLD = 0.15;
const TRIGRAM_LIMIT = 15;
const RECENT_LIMIT = 10;
const ENTITY_CAP = 10;

// Scoring weights
const SCORE_THREAD = 1.0;
const SCORE_ENTITY = 0.7;
const SCORE_TRIGRAM_FACTOR = 0.5; // multiplied by similarity (0–1)
const SCORE_RECENT = 0.2;

type Db = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Intermediate candidate before scoring/dedup */
type LoopCandidate = {
  id: string;
  summary: string;
  status: LoopStatus;
  ownerText: string | null;
  requesterText: string | null;
  emailThreadId: string;
  ownerEntityId: string | null;
  requesterEntityId: string | null;
  dueAt: Date | null;
  updatedAt: Date;
  generators: Set<"thread" | "entity" | "trigram" | "recent">;
  trigramScore: number; // 0 when not surfaced by trigram
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Load the extraction context for a single inbound email processing step.
 *
 * DB-injectable: pass `db` in tests; production path uses `getDb()` lazily.
 * Serialization-safe: all dates converted to ISO strings in the return value.
 */
export async function loadExtractionContext(
  input: LoadExtractionContextInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any,
): Promise<ExtractionContext> {
  const database: Db = db ?? getDb();
  const { userId, threadId, participants, queryText, limit = DEFAULT_LIMIT } = input;

  // -------------------------------------------------------------------------
  // Step 0: Resolve participant entity ids (READ-ONLY)
  // normalizeEmail each participant email → SELECT entities WHERE userId AND
  // canonicalEmail IN (...). Collect ids = participantEntityIds.
  // -------------------------------------------------------------------------

  const normalizedEmails = participants
    .map((p) => normalizeEmail(p.email))
    .filter((e): e is string => e !== null);

  let participantEntityIds: string[] = [];
  let participantEntities: Array<{
    id: string;
    displayName: string;
    kind: EntityKind;
    canonicalEmail: string | null;
    lastSeenAt: Date;
  }> = [];

  if (normalizedEmails.length > 0) {
    const rows = await database
      .select({
        id: entities.id,
        displayName: entities.displayName,
        kind: entities.kind,
        canonicalEmail: entities.canonicalEmail,
        lastSeenAt: entities.lastSeenAt,
      })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          inArray(entities.canonicalEmail, normalizedEmails),
          isNotNull(entities.canonicalEmail),
        ),
      );

    participantEntities = rows;
    participantEntityIds = rows.map((r: { id: string }) => r.id);
  }

  // -------------------------------------------------------------------------
  // Generator A: "thread" — loops on the same emailThreadId
  // -------------------------------------------------------------------------

  const candidateMap = new Map<string, LoopCandidate>();

  if (threadId) {
    const threadLoops = await database
      .select({
        id: loops.id,
        summary: loops.summary,
        status: loops.status,
        ownerText: loops.ownerText,
        requesterText: loops.requesterText,
        emailThreadId: loops.emailThreadId,
        ownerEntityId: loops.ownerEntityId,
        requesterEntityId: loops.requesterEntityId,
        dueAt: loops.dueAt,
        updatedAt: loops.updatedAt,
      })
      .from(loops)
      .where(
        and(
          eq(loops.userId, userId),
          eq(loops.emailThreadId, threadId),
          inArray(loops.status, OPEN_STATUSES),
        ),
      );

    for (const row of threadLoops) {
      const existing = candidateMap.get(row.id);
      if (existing) {
        existing.generators.add("thread");
      } else {
        candidateMap.set(row.id, {
          ...row,
          generators: new Set(["thread"]),
          trigramScore: 0,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Generator B: "entity" — loops linked to participant entities
  // via loopEntities.entityId IN (...) OR ownerEntityId/requesterEntityId IN (...)
  // -------------------------------------------------------------------------

  if (participantEntityIds.length > 0) {
    // Find loopIds via loopEntities join table
    const leRows = await database
      .select({ loopId: loopEntities.loopId })
      .from(loopEntities)
      .where(inArray(loopEntities.entityId, participantEntityIds));

    const viaJoinLoopIds = leRows.map((r: { loopId: string }) => r.loopId);

    // Query loops that match via join table OR direct FK columns
    const entityLoops = await database
      .select({
        id: loops.id,
        summary: loops.summary,
        status: loops.status,
        ownerText: loops.ownerText,
        requesterText: loops.requesterText,
        emailThreadId: loops.emailThreadId,
        ownerEntityId: loops.ownerEntityId,
        requesterEntityId: loops.requesterEntityId,
        dueAt: loops.dueAt,
        updatedAt: loops.updatedAt,
      })
      .from(loops)
      .where(
        and(
          eq(loops.userId, userId),
          inArray(loops.status, OPEN_STATUSES),
          or(
            viaJoinLoopIds.length > 0 ? inArray(loops.id, viaJoinLoopIds) : sql`false`,
            inArray(loops.ownerEntityId, participantEntityIds),
            inArray(loops.requesterEntityId, participantEntityIds),
          ),
        ),
      );

    for (const row of entityLoops) {
      const existing = candidateMap.get(row.id);
      if (existing) {
        existing.generators.add("entity");
      } else {
        candidateMap.set(row.id, {
          ...row,
          generators: new Set(["entity"]),
          trigramScore: 0,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Generator C: "trigram" — trigram similarity on summary vs. queryText
  // Only runs when queryText is non-empty.
  // -------------------------------------------------------------------------

  const trimmedQuery = queryText?.trim() ?? "";
  if (trimmedQuery.length > 0) {
    // Build OPEN_STATUSES as a Postgres array literal for raw SQL (enum values, safe to inline)
    const openStatusesArrayLiteral = `ARRAY[${OPEN_STATUSES.map((s) => `'${s}'`).join(",")}]`;

    const trigramRows = await database.execute(
      sql`
        SELECT
          l.id,
          l.summary,
          l.status,
          l.owner_text,
          l.requester_text,
          l.email_thread_id,
          l.owner_entity_id,
          l.requester_entity_id,
          l.due_at,
          l.updated_at,
          similarity(l.summary, ${trimmedQuery}) AS sim
        FROM loops AS l
        WHERE
          l.user_id = ${userId}
          AND l.status = ANY(${sql.raw(openStatusesArrayLiteral)}::loop_status[])
          AND similarity(l.summary, ${trimmedQuery}) > ${TRIGRAM_THRESHOLD}
        ORDER BY sim DESC
        LIMIT ${TRIGRAM_LIMIT}
      `,
    );

    for (const rawRow of trigramRows) {
      // postgres-js returns rows as plain objects; column names are snake_case from the SQL.
      // date/timestamptz columns come back as strings when using database.execute() raw SQL
      // (unlike drizzle's typed .select() which auto-coerces). Normalize them to Date.
      const row = rawRow as {
        id: string;
        summary: string;
        status: LoopStatus;
        owner_text: string | null;
        requester_text: string | null;
        email_thread_id: string;
        owner_entity_id: string | null;
        requester_entity_id: string | null;
        due_at: Date | string | null;
        updated_at: Date | string;
        sim: number | string;
      };

      const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string);
      const dueAt = row.due_at == null ? null : (row.due_at instanceof Date ? row.due_at : new Date(row.due_at as string));
      const sim = typeof row.sim === "number" ? row.sim : Number(row.sim);

      const existing = candidateMap.get(row.id);
      if (existing) {
        existing.generators.add("trigram");
        // Update trigramScore if this hit has a higher sim
        if (sim > existing.trigramScore) {
          existing.trigramScore = sim;
        }
      } else {
        candidateMap.set(row.id, {
          id: row.id,
          summary: row.summary,
          status: row.status,
          ownerText: row.owner_text,
          requesterText: row.requester_text,
          emailThreadId: row.email_thread_id,
          ownerEntityId: row.owner_entity_id,
          requesterEntityId: row.requester_entity_id,
          dueAt,
          updatedAt,
          generators: new Set(["trigram"]),
          trigramScore: sim,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Generator D: "recent" — most-recently-updated open loops (fallback)
  // -------------------------------------------------------------------------

  const recentLoops = await database
    .select({
      id: loops.id,
      summary: loops.summary,
      status: loops.status,
      ownerText: loops.ownerText,
      requesterText: loops.requesterText,
      emailThreadId: loops.emailThreadId,
      ownerEntityId: loops.ownerEntityId,
      requesterEntityId: loops.requesterEntityId,
      dueAt: loops.dueAt,
      updatedAt: loops.updatedAt,
    })
    .from(loops)
    .where(
      and(
        eq(loops.userId, userId),
        inArray(loops.status, OPEN_STATUSES),
      ),
    )
    .orderBy(desc(loops.updatedAt))
    .limit(RECENT_LIMIT);

  for (const row of recentLoops) {
    const existing = candidateMap.get(row.id);
    if (existing) {
      existing.generators.add("recent");
    } else {
      candidateMap.set(row.id, {
        ...row,
        generators: new Set(["recent"]),
        trigramScore: 0,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scoring: compute blended score per candidate
  // -------------------------------------------------------------------------

  type ScoredCandidate = LoopCandidate & { computedScore: number };

  const scored: ScoredCandidate[] = Array.from(candidateMap.values()).map((c) => {
    let score = 0;
    if (c.generators.has("thread")) score += SCORE_THREAD;
    if (c.generators.has("entity")) score += SCORE_ENTITY;
    if (c.generators.has("trigram")) score += SCORE_TRIGRAM_FACTOR * c.trigramScore;
    if (c.generators.has("recent")) score += SCORE_RECENT;
    return { ...c, computedScore: score };
  });

  // Sort by score DESC, then updatedAt DESC as tiebreaker
  scored.sort((a, b) => {
    if (b.computedScore !== a.computedScore) return b.computedScore - a.computedScore;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  // Cap to limit
  const capped = scored.slice(0, limit);

  // -------------------------------------------------------------------------
  // Batch fetch entityIds for surviving candidates
  // For each surviving loop, gather: ownerEntityId, requesterEntityId, and
  // loopEntities.entityId (all roles). One batched query by loopId IN (...).
  // -------------------------------------------------------------------------

  const survivingLoopIds = capped.map((c) => c.id);
  const loopEntityMap = new Map<string, Set<string>>();

  for (const loopId of survivingLoopIds) {
    loopEntityMap.set(loopId, new Set());
  }

  // Seed with owner/requester from the loop row itself
  for (const c of capped) {
    const s = loopEntityMap.get(c.id)!;
    if (c.ownerEntityId) s.add(c.ownerEntityId);
    if (c.requesterEntityId) s.add(c.requesterEntityId);
  }

  // Add participant links from loopEntities join table
  if (survivingLoopIds.length > 0) {
    const leRows = await database
      .select({
        loopId: loopEntities.loopId,
        entityId: loopEntities.entityId,
      })
      .from(loopEntities)
      .where(inArray(loopEntities.loopId, survivingLoopIds));

    for (const row of leRows) {
      const s = loopEntityMap.get(row.loopId);
      if (s) s.add(row.entityId);
    }
  }

  // -------------------------------------------------------------------------
  // Build openLoops with refIds assigned in final order
  // -------------------------------------------------------------------------

  const openLoops: CompactLoop[] = capped.map((c, idx) => ({
    id: c.id,
    refId: `L${idx + 1}`,
    summary: c.summary,
    status: c.status,
    ownerText: c.ownerText,
    requesterText: c.requesterText,
    emailThreadId: c.emailThreadId,
    entityIds: Array.from(loopEntityMap.get(c.id) ?? []),
    dueAt: c.dueAt ? c.dueAt.toISOString() : null,
    updatedAt: c.updatedAt.toISOString(),
    generators: Array.from(c.generators) as CompactLoop["generators"],
    score: c.computedScore,
  }));

  // -------------------------------------------------------------------------
  // knownEntities: participant entities + any entity on a surviving candidate loop
  // Collect all entity ids, fetch them, compute openLoopCount, cap by lastSeenAt.
  // -------------------------------------------------------------------------

  // Collect all entity ids to surface
  const allEntityIds = new Set<string>(participantEntityIds);
  for (const entityIdSet of loopEntityMap.values()) {
    for (const eid of entityIdSet) {
      allEntityIds.add(eid);
    }
  }

  let knownEntities: CompactEntity[] = [];

  if (allEntityIds.size > 0) {
    const entityIdList = Array.from(allEntityIds);

    // Fetch entity rows
    const entityRows = await database
      .select({
        id: entities.id,
        displayName: entities.displayName,
        kind: entities.kind,
        canonicalEmail: entities.canonicalEmail,
        lastSeenAt: entities.lastSeenAt,
      })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          inArray(entities.id, entityIdList),
        ),
      );

    // For each entity, count open loops linked to it.
    // Batch: count loops WHERE status IN OPEN_STATUSES AND (ownerEntityId = e.id OR requesterEntityId = e.id)
    // UNION loopEntities join for participant rows.
    // We do this with a single raw SQL aggregation to avoid N+1.
    // Note: OPEN_STATUSES and entityIdList are inlined as Postgres array literals via
    // sql.raw() because drizzle's sql`` tag serializes JS arrays as row-constructor
    // tuples (($1,$2,...)) which are NOT valid on the right side of = ANY(...).
    // These values come from trusted constants (status enum) and DB-round-tripped UUIDs,
    // so inlining is safe.
    type CountRow = { entity_id: string; cnt: string };
    let openCountMap = new Map<string, number>();

    if (entityRows.length > 0) {
      const openStatusesLit = `ARRAY[${OPEN_STATUSES.map((s) => `'${s}'`).join(",")}]`;
      const entityIdsLit = `ARRAY[${entityIdList.map((id) => `'${id}'::uuid`).join(",")}]`;

      const countRows: CountRow[] = await database.execute(sql`
        SELECT e_id AS entity_id, COUNT(*) AS cnt
        FROM (
          SELECT owner_entity_id AS e_id
          FROM loops
          WHERE
            user_id = ${userId}
            AND status = ANY(${sql.raw(openStatusesLit)}::loop_status[])
            AND owner_entity_id = ANY(${sql.raw(entityIdsLit)})
          UNION ALL
          SELECT requester_entity_id AS e_id
          FROM loops
          WHERE
            user_id = ${userId}
            AND status = ANY(${sql.raw(openStatusesLit)}::loop_status[])
            AND requester_entity_id = ANY(${sql.raw(entityIdsLit)})
          UNION ALL
          SELECT le.entity_id AS e_id
          FROM loop_entities AS le
          INNER JOIN loops ON loops.id = le.loop_id
          WHERE
            loops.user_id = ${userId}
            AND loops.status = ANY(${sql.raw(openStatusesLit)}::loop_status[])
            AND le.entity_id = ANY(${sql.raw(entityIdsLit)})
        ) AS combined
        GROUP BY e_id
      `);

      openCountMap = new Map(
        countRows.map((r) => [r.entity_id, Number(r.cnt)]),
      );
    }

    // Build CompactEntity list, sort by lastSeenAt DESC, cap at ENTITY_CAP
    const entityList: CompactEntity[] = entityRows
      .sort((a: { lastSeenAt: Date }, b: { lastSeenAt: Date }) =>
        b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
      )
      .slice(0, ENTITY_CAP)
      .map((e: { id: string; displayName: string; kind: EntityKind; canonicalEmail: string | null }) => ({
        id: e.id,
        displayName: e.displayName,
        kind: e.kind,
        canonicalEmail: e.canonicalEmail,
        openLoopCount: openCountMap.get(e.id) ?? 0,
      }));

    knownEntities = entityList;
  }

  return { openLoops, knownEntities };
}
