/**
 * scripts/backfill-entities.ts
 *
 * One-time idempotent backfill: links EXISTING loops to entities by calling
 * the same `linkLoopEntities` helper used in the live capture path (Phase 7 A2).
 *
 * Usage:
 *   DATABASE_URL=<...> pnpm tsx scripts/backfill-entities.ts [--user <userId>] [--dry-run]
 *
 * For local dev:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm tsx scripts/backfill-entities.ts [--user <userId>] [--dry-run]
 *
 * Idempotency: loops that already have ANY loop_entities row are SKIPPED.
 * Re-running is safe and cheap — only still-unlinked loops are processed.
 *
 * Env: requires DATABASE_URL.  Loads .env.local (via @next/env) for local runs;
 * in Doppler / CI the var is already in process.env.
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, notExists, asc, and } from "drizzle-orm";
import * as schema from "@/db/schema";
import { loops, loopEntities, inboundEmails, users } from "@/db/schema";
import { linkLoopEntities, type LinkParticipant } from "@/entities/link";
import { getEnv } from "@/config/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Use a generic drizzle type compatible with the schema so tests can inject a db
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type BackfillOptions = {
  /** Drizzle DB handle — the caller creates it so tests can inject one. */
  db: AnyDb;
  /** When provided, only backfill loops belonging to this userId. */
  userId?: string;
  /** When true, count what WOULD be processed but make no writes. */
  dryRun?: boolean;
  /** Number of loops to fetch per batch. Default 200. */
  batchSize?: number;
};

export type BackfillResult = {
  /** Loops that were (or would have been in dry-run) linked to entities. */
  processed: number;
  /** Loops already having loop_entities rows — skipped. */
  skipped: number;
  /** Loops where linkLoopEntities threw. Backfill continues past failures. */
  failed: number;
};

// ---------------------------------------------------------------------------
// Core exported function (testable, no side-effects at import time)
// ---------------------------------------------------------------------------

/**
 * Idempotent entity backfill for existing loops.
 *
 * Selects loops with NO existing loop_entities rows (idempotency filter) in
 * batches ordered by createdAt, then calls linkLoopEntities for each.
 *
 * Returns { processed, skipped, failed } tallies.
 */
export async function backfillEntities(opts: BackfillOptions): Promise<BackfillResult> {
  const { db, userId, dryRun = false, batchSize = 200 } = opts;

  // Per-user selfEmail cache: userId → email or null
  const selfEmailCache = new Map<string, string | null>();

  const result: BackfillResult = { processed: 0, skipped: 0, failed: 0 };

  // Cursor-based pagination on (createdAt ASC, id ASC).
  // We track the last row's createdAt; for the next fetch we pull rows with
  // createdAt > lastCreatedAt.  Within the same createdAt bucket we track seen
  // ids and exclude them, avoiding double-processing on the boundary.
  let cursorCreatedAt: Date | null = null;
  let seenIds = new Set<string>();

  while (true) {
    // -----------------------------------------------------------------------
    // Build WHERE conditions
    // -----------------------------------------------------------------------
    const conditions: ReturnType<typeof eq>[] = [
      // Core idempotency: only loops with NO loop_entities rows yet
      notExists(
        db
          .select({ id: loopEntities.id })
          .from(loopEntities)
          .where(eq(loopEntities.loopId, loops.id)),
      ),
    ];

    if (userId) {
      conditions.push(eq(loops.userId, userId));
    }

    if (cursorCreatedAt !== null) {
      const { gt } = await import("drizzle-orm");
      conditions.push(gt(loops.createdAt, cursorCreatedAt));
    }

    // -----------------------------------------------------------------------
    // Fetch batch
    // -----------------------------------------------------------------------
    type LoopRow = {
      id: string;
      userId: string;
      inboundEmailId: string;
      ownerText: string | null;
      requesterText: string | null;
      participants: unknown;
      createdAt: Date;
    };

    const batch: LoopRow[] = await db
      .select({
        id: loops.id,
        userId: loops.userId,
        inboundEmailId: loops.inboundEmailId,
        ownerText: loops.ownerText,
        requesterText: loops.requesterText,
        participants: loops.participants,
        createdAt: loops.createdAt,
      })
      .from(loops)
      .where(and(...conditions))
      .orderBy(asc(loops.createdAt), asc(loops.id))
      .limit(batchSize);

    if (batch.length === 0) break;

    // Advance cursor past the last row's createdAt
    const lastRow = batch[batch.length - 1];
    cursorCreatedAt = lastRow.createdAt;
    seenIds = new Set(batch.map((r) => r.id));

    // -----------------------------------------------------------------------
    // Process each loop
    // -----------------------------------------------------------------------
    for (const loop of batch) {
      if (dryRun) {
        result.processed++;
        continue;
      }

      try {
        // Resolve selfEmail (cached per userId)
        let selfEmail: string | null = null;
        if (selfEmailCache.has(loop.userId)) {
          selfEmail = selfEmailCache.get(loop.userId) ?? null;
        } else {
          const [userRow] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, loop.userId))
            .limit(1);
          selfEmail = userRow?.email ?? null;
          selfEmailCache.set(loop.userId, selfEmail);
        }

        // Resolve sender from normalizedPayload.from on the originating email
        let sender: LinkParticipant | null = null;
        if (loop.inboundEmailId) {
          const [inbound] = await db
            .select({ normalizedPayload: inboundEmails.normalizedPayload })
            .from(inboundEmails)
            .where(eq(inboundEmails.id, loop.inboundEmailId))
            .limit(1);

          if (inbound?.normalizedPayload) {
            const payload = inbound.normalizedPayload as Record<string, unknown>;
            const from = payload.from as
              | { email?: string | null; name?: string | null }
              | null
              | undefined;
            if (from && (from.email || from.name)) {
              sender = { email: from.email ?? null, name: from.name ?? null };
            }
          }
        }

        // Parse participants stored as jsonb
        const participants: LinkParticipant[] = Array.isArray(loop.participants)
          ? (loop.participants as LinkParticipant[])
          : [];

        await linkLoopEntities(
          {
            userId: loop.userId,
            loopId: loop.id,
            ownerText: loop.ownerText,
            requesterText: loop.requesterText,
            participants,
            sender,
            selfEmail,
          },
          db,
        );

        result.processed++;
      } catch (err) {
        console.error(
          `[backfill-entities] FAILED loopId=${loop.id} userId=${loop.userId}:`,
          err,
        );
        result.failed++;
      }
    }

    // Stop when the batch was smaller than batchSize (no more rows)
    if (batch.length < batchSize) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface CliArgs {
  userId: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let userId: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user") {
      userId = argv[++i] ?? undefined;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { userId, dryRun };
}

async function main(): Promise<void> {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(2);
  }

  const { userId, dryRun } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    console.log("[backfill-entities] DRY RUN — no writes will be made.");
  }
  if (userId) {
    console.log(`[backfill-entities] Scoped to userId=${userId}`);
  }

  const sql = postgres(env.DATABASE_URL, { prepare: false });
  const db = drizzle(sql, { schema });

  try {
    const result = await backfillEntities({ db, userId, dryRun });

    console.log(
      `[backfill-entities] Done. processed=${result.processed} skipped=${result.skipped} failed=${result.failed}`,
    );

    if (result.failed > 0) {
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

// Guard: only execute main() when invoked directly via tsx/node, not when imported in tests.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[backfill-entities] Fatal error:", err);
    process.exit(1);
  });
}
