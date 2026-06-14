/**
 * DB-gated round-trip for the Drizzle reconciliation wiring (Phase 7 B2b):
 *   - loadOpenLoopContext: resolves open-loop candidates + participant entity ids
 *   - recordReconciliationEvent: inserts a loop_events provenance row
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/loops/reconcile-apply.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  emailThreads,
  inboundEmails,
  sourceEvidence,
  loops,
  loopEntities,
  loopEvents,
  entities,
} from "@/db/schema";
import { DrizzleLoopProcessingRepository } from "@/loops/repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("Drizzle reconciliation wiring (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  // Build the repository WITHOUT the getDb() field initializer (which requires a
  // production DATABASE_URL) by instantiating off the prototype and injecting the
  // test db. The two methods under test only touch `this.db`.
  const repo = Object.create(
    DrizzleLoopProcessingRepository.prototype,
  ) as DrizzleLoopProcessingRepository;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).db = db;

  const RUN_ID = Date.now();
  let userId: string;
  let threadId: string;
  let inboundId: string;
  let evidenceId: string;
  let loopId: string;
  let participantEntityId: string;
  const participantEmail = `recon-${RUN_ID}@corp.example`;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `recon-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    const [t] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `recon-thread-${RUN_ID}`, subject: "Recon thread" })
      .returning({ id: emailThreads.id });
    threadId = t.id;

    const [ie] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: threadId,
        provider: "postmark",
        providerMessageId: `recon-msg-${RUN_ID}`,
        senderEmail: participantEmail,
        subject: "Recon email",
        textBody: "body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundId = ie.id;

    const [ev] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inboundId, providerMessageId: `recon-msg-${RUN_ID}`, quote: "q", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });
    evidenceId = ev.id;

    const [pe] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person" as const,
        displayName: `ReconPerson-${RUN_ID}`,
        canonicalEmail: participantEmail,
        aliases: [],
        metadata: {},
      })
      .returning({ id: entities.id });
    participantEntityId = pe.id;

    const [l] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: threadId,
        inboundEmailId: inboundId,
        sourceEvidenceId: evidenceId,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `Send the renewal packet to Acme ${RUN_ID}`,
        confidence: 0.9,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopId = l.id;

    await db
      .insert(loopEntities)
      .values({ loopId, entityId: participantEntityId, role: "participant" as const })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(loopEvents).where(eq(loopEvents.userId, userId));
    await db.delete(loopEntities).where(eq(loopEntities.loopId, loopId));
    await db.delete(loops).where(eq(loops.userId, userId));
    await db.delete(sourceEvidence).where(eq(sourceEvidence.userId, userId));
    await db.delete(inboundEmails).where(eq(inboundEmails.userId, userId));
    await db.delete(emailThreads).where(eq(emailThreads.userId, userId));
    await db.delete(entities).where(eq(entities.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await sql.end({ timeout: 5 });
  });

  it("loadOpenLoopContext returns the open loop + the participant entity id", async () => {
    const context = await repo.loadOpenLoopContext({
      userId,
      threadId,
      participants: [{ name: "Recon Person", email: participantEmail }],
      queryText: `Send the renewal packet to Acme ${RUN_ID}`,
    });

    expect(context.openLoops.some((loop) => loop.id === loopId)).toBe(true);
    expect(context.participantEntityIds).toContain(participantEntityId);
    // The candidate loop should carry the participant entity id (structural sameEntity check).
    const candidate = context.openLoops.find((loop) => loop.id === loopId);
    expect(candidate?.entityIds).toContain(participantEntityId);
  });

  it("recordReconciliationEvent inserts a 'reconciled' loop_event with the metadata", async () => {
    await repo.recordReconciliationEvent({
      userId,
      loopId,
      eventType: "reconciled",
      metadata: { sourceInboundEmailId: inboundId, action: "update", reason: "test" },
    });

    const rows = await db
      .select({ eventType: loopEvents.eventType, metadata: loopEvents.metadata })
      .from(loopEvents)
      .where(and(eq(loopEvents.loopId, loopId), eq(loopEvents.eventType, "reconciled")));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ action: "update", reason: "test" });
  });
});
