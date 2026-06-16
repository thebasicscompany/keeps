/**
 * scripts/backfill-merge-entities.ts
 *
 * Wave 0.3 — entity org-canonicalization (SOFT-merge). Within each org, collapse duplicate
 * person/company entities (same canonical_email / same company domain) into one canonical row:
 *   - canonical = earliest-seen (planEntityMerges, pure + deterministic)
 *   - each duplicate: merged_into_entity_id := canonical (NEVER deleted → reversible), its
 *     display name / email / aliases union onto the canonical, and its FK links
 *     (loops.owner/requester_entity_id, loop_entities) re-point to the canonical.
 *
 * Idempotent: only ACTIVE rows (merged_into_entity_id IS NULL) are considered; re-running finds
 * nothing new. Run BEFORE migration 0022 (which then adds the per-org active unique indexes).
 *
 * Usage:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm tsx scripts/backfill-merge-entities.ts [--dry-run]
 * NEVER point DATABASE_URL at prod from a local run.
 */
import nextEnv from "@next/env";

try {
  (nextEnv as { loadEnvConfig?: (dir: string) => void }).loadEnvConfig?.(process.cwd());
} catch {
  // Best-effort.
}

import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { entities, loops, loopEntities } from "@/db/schema";
import { getEnv } from "@/config/env";
import { planEntityMerges, type EntityForMerge } from "@/entities/merge-plan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type MergeEntitiesResult = { orgsScanned: number; merges: number };

/** Soft-merge duplicate active entities within a single org. Returns the number of remaps applied. */
export async function mergeEntitiesInOrg(opts: {
  db: AnyDb;
  orgId: string;
  dryRun?: boolean;
}): Promise<number> {
  const { db, orgId, dryRun = false } = opts;

  const rows: {
    id: string;
    kind: string;
    canonicalEmail: string | null;
    displayName: string;
    aliases: unknown;
    metadata: Record<string, unknown> | null;
    firstSeenAt: Date;
  }[] = await db
    .select({
      id: entities.id,
      kind: entities.kind,
      canonicalEmail: entities.canonicalEmail,
      displayName: entities.displayName,
      aliases: entities.aliases,
      metadata: entities.metadata,
      firstSeenAt: entities.firstSeenAt,
    })
    .from(entities)
    .where(and(eq(entities.orgId, orgId), isNull(entities.mergedIntoEntityId)));

  const forMerge: EntityForMerge[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    canonicalEmail: r.canonicalEmail,
    domain: typeof r.metadata?.domain === "string" ? (r.metadata.domain as string) : null,
    mergedIntoEntityId: null,
    firstSeenAtMs: r.firstSeenAt.getTime(),
  }));

  const plan = planEntityMerges(forMerge);
  if (dryRun || plan.remaps.length === 0) return plan.remaps.length;

  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const { from, into } of plan.remaps) {
    await db.transaction(async (tx: AnyDb) => {
      // Re-point direct FK columns.
      await tx.update(loops).set({ ownerEntityId: into }).where(eq(loops.ownerEntityId, from));
      await tx.update(loops).set({ requesterEntityId: into }).where(eq(loops.requesterEntityId, from));

      // Re-point the join table; drop rows that would collide on (loop_id, entity_id, role) first.
      await tx.execute(sql`
        DELETE FROM loop_entities le
        WHERE le.entity_id = ${from}::uuid
          AND EXISTS (
            SELECT 1 FROM loop_entities x
            WHERE x.loop_id = le.loop_id AND x.entity_id = ${into}::uuid AND x.role = le.role
          )
      `);
      await tx.update(loopEntities).set({ entityId: into }).where(eq(loopEntities.entityId, from));

      // Union the duplicate's identifiers onto the canonical's aliases (helps recall).
      const dupe = byId.get(from);
      const extra = [dupe?.displayName, dupe?.canonicalEmail, ...((dupe?.aliases as string[]) ?? [])]
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      if (extra.length > 0) {
        await tx
          .update(entities)
          .set({ aliases: sql`${entities.aliases} || ${JSON.stringify(extra)}::jsonb` })
          .where(eq(entities.id, into));
      }

      // Tombstone the duplicate (reversible: clear this column to un-merge).
      await tx
        .update(entities)
        .set({ mergedIntoEntityId: into })
        .where(eq(entities.id, from));
    });
  }

  return plan.remaps.length;
}

/** Iterate every org with entities and soft-merge duplicates within each. */
export async function backfillMergeEntities(opts: { db: AnyDb; dryRun?: boolean }): Promise<MergeEntitiesResult> {
  const orgRows: { orgId: string }[] = await opts.db
    .selectDistinct({ orgId: entities.orgId })
    .from(entities)
    .where(isNotNull(entities.orgId));

  let merges = 0;
  for (const { orgId } of orgRows) {
    if (!orgId) continue;
    merges += await mergeEntitiesInOrg({ db: opts.db, orgId, dryRun: opts.dryRun });
  }
  return { orgsScanned: orgRows.length, merges };
}

// ---------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const databaseUrl = getEnv().DATABASE_URL;
  if (!databaseUrl) throw new Error("[backfill-merge-entities] DATABASE_URL is required");
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const r = await backfillMergeEntities({ db, dryRun });
    console.log(
      `[backfill-merge-entities] ${dryRun ? "DRY-RUN " : ""}orgsScanned=${r.orgsScanned} merges=${r.merges}`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[backfill-merge-entities] failed:", err);
    process.exit(1);
  });
}
