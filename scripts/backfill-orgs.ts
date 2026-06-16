/**
 * scripts/backfill-orgs.ts
 *
 * One-time idempotent backfill for the org-visibility re-founding (Wave 0). For every user
 * WITHOUT an org membership it creates a PERSONAL org of one (the degenerate single-member
 * case = the old per-user behavior) and stamps org_id onto their existing rows:
 *   1. organizations (is_personal = true)
 *   2. org_memberships (role = 'owner')
 *   3. scopes (kind = 'org_root')           — the whole-org scope
 *   4. visibility_edges (org_admin → org)   — so the owner sees their whole personal org
 *   5. UPDATE loops / entities / source_evidence SET org_id = <personal org> WHERE org_id IS NULL
 *
 * Idempotency: users who already have ANY org membership are SKIPPED. Re-running is safe.
 * This does NOT touch entity uniqueness (per-user → per-org) — that destructive canonicalization
 * is a separate, review-gated migration (0022). This backfill is purely additive/forward.
 *
 * Usage:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm tsx scripts/backfill-orgs.ts [--user <userId>] [--dry-run]
 *
 * NEVER point DATABASE_URL at the prod RDS from a local run.
 */
import nextEnv from "@next/env";

try {
  (nextEnv as { loadEnvConfig?: (dir: string) => void }).loadEnvConfig?.(process.cwd());
} catch {
  // Best-effort: Doppler / CI / an explicit DATABASE_URL already populate process.env.
}

import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  entities,
  loops,
  organizations,
  orgMemberships,
  scopes,
  sourceEvidence,
  users,
  visibilityEdges,
} from "@/db/schema";
import { getEnv } from "@/config/env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type BackfillOrgsOptions = {
  /** Drizzle DB handle — the caller creates it so tests can inject one. */
  db: AnyDb;
  /** When provided, only backfill this user. */
  userId?: string;
  /** When true, count what WOULD be processed but make no writes. */
  dryRun?: boolean;
};

export type BackfillOrgsResult = {
  /** Users given a fresh personal org (or that would be, in dry-run). */
  processed: number;
  /** Users already in an org — skipped. */
  skipped: number;
};

/**
 * Core: create a personal org + membership + org_root scope + org_admin edge for each user
 * lacking any membership, then stamp org_id onto their loops/entities/source_evidence.
 * No import-time side effects; the caller injects the db.
 */
export async function backfillOrgs(opts: BackfillOrgsOptions): Promise<BackfillOrgsResult> {
  const { db, userId, dryRun = false } = opts;

  // Users who already have a membership are skipped (idempotency).
  const membered = await db
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships);
  const memberedIds = new Set<string>(membered.map((r: { userId: string }) => r.userId));

  const candidateRows: { id: string; displayName: string | null; email: string }[] = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(userId ? eq(users.id, userId) : sql`true`);

  const todo = candidateRows.filter((u) => !memberedIds.has(u.id));
  const skipped = candidateRows.length - todo.length;

  if (dryRun) return { processed: todo.length, skipped };

  let processed = 0;
  for (const u of todo) {
    await db.transaction(async (tx: AnyDb) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: u.displayName ?? u.email, isPersonal: true })
        .returning({ id: organizations.id });

      await tx
        .insert(orgMemberships)
        .values({ orgId: org.id, userId: u.id, role: "owner" });

      const [scope] = await tx
        .insert(scopes)
        .values({ orgId: org.id, kind: "org_root", name: "All" })
        .returning({ id: scopes.id });

      await tx.insert(visibilityEdges).values({
        orgId: org.id,
        subjectUserId: u.id,
        relation: "org_admin",
        objectType: "org",
        objectId: org.id,
      });

      // Stamp org_id (and org_root scope on loops) onto the user's existing rows.
      await tx
        .update(loops)
        .set({ orgId: org.id, scopeId: scope.id })
        .where(and(eq(loops.userId, u.id), isNull(loops.orgId)));
      await tx
        .update(entities)
        .set({ orgId: org.id })
        .where(and(eq(entities.userId, u.id), isNull(entities.orgId)));
      await tx
        .update(sourceEvidence)
        .set({ orgId: org.id })
        .where(and(eq(sourceEvidence.userId, u.id), isNull(sourceEvidence.orgId)));
    });
    processed += 1;
  }

  return { processed, skipped };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (only runs when invoked directly, not on import).
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const userIdx = args.indexOf("--user");
  const userId = userIdx >= 0 ? args[userIdx + 1] : undefined;

  const databaseUrl = getEnv().DATABASE_URL;
  if (!databaseUrl) throw new Error("[backfill-orgs] DATABASE_URL is required");
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const result = await backfillOrgs({ db, userId, dryRun });
    console.log(
      `[backfill-orgs] ${dryRun ? "DRY-RUN " : ""}processed=${result.processed} skipped=${result.skipped}`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[backfill-orgs] failed:", err);
    process.exit(1);
  });
}
