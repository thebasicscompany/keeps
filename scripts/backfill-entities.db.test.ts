/**
 * DB-gated integration tests for backfillEntities (Phase 7 A2).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run scripts/backfill-entities.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Fixture chain (all FK-safe):
 *   users → email_threads → inbound_emails (with normalizedPayload.from)
 *          → source_evidence → loops (with ownerText / requesterText / participants)
 *
 * Test assertions:
 *   (a) After backfill, loops have loop_entities rows + ownerEntityId/requesterEntityId set.
 *   (b) A second run processes 0 loops (idempotent skip) and creates no duplicate rows.
 *   (c) dryRun:true makes no writes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, count } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  emailThreads,
  inboundEmails,
  sourceEvidence,
  loops,
  loopEntities,
  entities,
} from "@/db/schema";
import { backfillEntities } from "./backfill-entities";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("backfillEntities (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN_ID = Date.now();
  let userId: string;
  let emailThreadId: string;
  let inboundEmailId: string;
  let sourceEvidenceId: string;

  // Ids of loops seeded for the main tests
  let loopIdA: string;
  let loopIdB: string;

  // ---------------------------------------------------------------------------
  // Helper: count loop_entities rows for a loop (optionally filtered by role)
  // ---------------------------------------------------------------------------
  async function countLoopEntities(loopId: string, role?: string): Promise<number> {
    const rows = await db
      .select({ c: count() })
      .from(loopEntities)
      .where(
        role
          ? eq(loopEntities.loopId, loopId) // additional role filter applied below
          : eq(loopEntities.loopId, loopId),
      );
    if (!role) return Number(rows[0]?.c ?? 0);

    // Re-query with role filter
    const { and: andOp } = await import("drizzle-orm");
    const filtered = await db
      .select({ c: count() })
      .from(loopEntities)
      .where(andOp(eq(loopEntities.loopId, loopId), eq(loopEntities.role, role as schema.LoopEntityRole)));
    return Number(filtered[0]?.c ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Helper: get a loop row
  // ---------------------------------------------------------------------------
  async function getLoop(loopId: string): Promise<schema.Loop | undefined> {
    const [row] = await db.select().from(loops).where(eq(loops.id, loopId)).limit(1);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    // Create user
    const [u] = await db
      .insert(users)
      .values({
        email: `test-backfill-${RUN_ID}@test.invalid`,
        timezone: "UTC",
      })
      .returning({ id: users.id });
    userId = u.id;

    // Create email thread
    const [thread] = await db
      .insert(emailThreads)
      .values({
        userId,
        threadKey: `backfill-test-thread-${RUN_ID}`,
        subject: "Backfill test thread",
      })
      .returning({ id: emailThreads.id });
    emailThreadId = thread.id;

    // Create inbound email WITH a normalizedPayload.from so the backfill can
    // extract the sender.
    const [inbound] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId,
        provider: "postmark",
        providerMessageId: `backfill-test-msg-${RUN_ID}`,
        senderEmail: `sender-${RUN_ID}@example.invalid`,
        subject: "Backfill test",
        textBody: "Test body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {
          from: {
            email: `sender-${RUN_ID}@example.invalid`,
            name: "Test Sender",
          },
        },
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundEmailId = inbound.id;

    // Create source evidence
    const [evidence] = await db
      .insert(sourceEvidence)
      .values({
        userId,
        inboundEmailId,
        emailMessageId: null,
        providerMessageId: `backfill-test-msg-${RUN_ID}`,
        quote: "Test quote",
        normalizedBody: "Test body",
        startOffset: 0,
        endOffset: 10,
        metadata: {},
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId = evidence.id;

    // Seed loop A: has ownerText, a participant with corporate email, no loop_entities
    const [loopA] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `Backfill test loop A ${RUN_ID}`,
        confidence: 0.9,
        ownerText: `Alice Backfill ${RUN_ID}`,
        requesterText: null,
        participants: [
          { name: `Alice Backfill ${RUN_ID}`, email: `alice-${RUN_ID}@acme-backfill.test` },
        ],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopIdA = loopA.id;

    // Seed loop B: has requesterText, a different participant
    const [loopB] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open" as const,
        kind: "ask" as const,
        basis: "explicit_commitment" as const,
        summary: `Backfill test loop B ${RUN_ID}`,
        confidence: 0.8,
        ownerText: null,
        requesterText: `Bob Backfill ${RUN_ID}`,
        participants: [
          { name: `Bob Backfill ${RUN_ID}`, email: `bob-${RUN_ID}@corp-backfill.test` },
        ],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopIdB = loopB.id;
  });

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  afterAll(async () => {
    // Delete the user — cascades to loops, loop_entities, source_evidence, inbound_emails, threads
    await db.delete(users).where(eq(users.id, userId));
    // Entities are scoped to userId but not cascade-deleted with the user
    await db.delete(entities).where(eq(entities.userId, userId));
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // (a) After backfill: loops have loop_entities rows + FK columns set
  // ---------------------------------------------------------------------------

  it("(a) backfill links loop_entities rows and sets ownerEntityId / requesterEntityId", async () => {
    const result = await backfillEntities({ db, userId, batchSize: 10 });

    // Both loops should have been processed (not skipped or failed)
    expect(result.processed).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);

    // Loop A: ownerText set → ownerEntityId should be populated
    const loopA = await getLoop(loopIdA);
    expect(loopA?.ownerEntityId).not.toBeNull();
    expect(loopA?.ownerEntityId).toBeTruthy();

    // Loop A should have at least one loop_entities row (owner + participant + company)
    const loopARows = await countLoopEntities(loopIdA);
    expect(loopARows).toBeGreaterThanOrEqual(1);

    // Loop A should have exactly one "owner" row
    const loopAOwnerRows = await countLoopEntities(loopIdA, "owner");
    expect(loopAOwnerRows).toBe(1);

    // Loop B: requesterText set → requesterEntityId should be populated
    const loopB = await getLoop(loopIdB);
    expect(loopB?.requesterEntityId).not.toBeNull();
    expect(loopB?.requesterEntityId).toBeTruthy();

    // Loop B should have at least one loop_entities row
    const loopBRows = await countLoopEntities(loopIdB);
    expect(loopBRows).toBeGreaterThanOrEqual(1);

    // Loop B should have exactly one "requester" row
    const loopBRequesterRows = await countLoopEntities(loopIdB, "requester");
    expect(loopBRequesterRows).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // (b) Second run: processes 0 loops (idempotent skip), no duplicate rows
  // ---------------------------------------------------------------------------

  it("(b) second run skips already-linked loops and creates no duplicate loop_entities rows", async () => {
    // Capture row counts before second run
    const loopARowsBefore = await countLoopEntities(loopIdA);
    const loopBRowsBefore = await countLoopEntities(loopIdB);

    // Run backfill again
    const result = await backfillEntities({ db, userId, batchSize: 10 });

    // All loops are already linked → should process 0 (skipped filter via notExists)
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    // Row counts must be unchanged
    const loopARowsAfter = await countLoopEntities(loopIdA);
    const loopBRowsAfter = await countLoopEntities(loopIdB);
    expect(loopARowsAfter).toBe(loopARowsBefore);
    expect(loopBRowsAfter).toBe(loopBRowsBefore);
  });

  // ---------------------------------------------------------------------------
  // (c) dryRun: no writes are made
  // ---------------------------------------------------------------------------

  it("(c) dryRun:true counts but makes no writes to a fresh loop", async () => {
    // Seed an extra loop with no loop_entities rows
    const [dryRunLoop] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `Backfill dry-run test loop ${RUN_ID}`,
        confidence: 0.7,
        ownerText: `Dry Owner ${RUN_ID}`,
        requesterText: null,
        participants: [{ name: `Dry Owner ${RUN_ID}`, email: `dry-${RUN_ID}@dryrun.test` }],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    const dryLoopId = dryRunLoop.id;

    // Dry run — must process >= 1 (the newly seeded loop) but write nothing
    const result = await backfillEntities({ db, userId, dryRun: true, batchSize: 10 });

    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    // No loop_entities rows should exist for the dry-run loop
    const rowCount = await countLoopEntities(dryLoopId);
    expect(rowCount).toBe(0);

    // The loop's FK columns must still be null
    const loop = await getLoop(dryLoopId);
    expect(loop?.ownerEntityId).toBeNull();
    expect(loop?.requesterEntityId).toBeNull();

    // Clean up the dry-run loop so it doesn't affect subsequent tests
    await db.delete(loops).where(eq(loops.id, dryLoopId));
  });
});
