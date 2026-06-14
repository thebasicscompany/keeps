/**
 * DB-gated integration tests for the extraction-context loader (Phase 7 B3).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/agent/extraction-context.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
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
import { loadExtractionContext, OPEN_STATUSES } from "@/agent/extraction-context";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("loadExtractionContext (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN_ID = Date.now();
  let userId: string;

  // Thread / email IDs
  let thread1Id: string; // "current" thread
  let thread2Id: string; // different thread
  let inbound1Id: string;
  let inbound2Id: string;
  let inbound3Id: string;
  let evidence1Id: string;
  let evidence2Id: string;
  let evidence3Id: string;

  // Loop IDs
  let loopSameThread: string;    // open loop on thread1
  let loopEntityOnly: string;    // open loop on thread2, linked to participantEntity
  let loopTrigramOnly: string;   // open loop on thread2, topically similar, no entity/thread match
  let loopDone: string;          // done loop — must NOT appear
  let loopDismissed: string;     // dismissed loop — must NOT appear
  let loopSuppressed: string;    // suppressed loop — must NOT appear
  let loopRecent: string;        // recent loop with no other signals

  // Entity IDs
  let participantEntityId: string; // entity for a participant email

  beforeAll(async () => {
    // ---- user ----
    const [u] = await db
      .insert(users)
      .values({ email: `test-ctx-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    // ---- email threads ----
    const [t1] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `ctx-thread1-${RUN_ID}`, subject: "Thread 1" })
      .returning({ id: emailThreads.id });
    thread1Id = t1.id;

    const [t2] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `ctx-thread2-${RUN_ID}`, subject: "Thread 2" })
      .returning({ id: emailThreads.id });
    thread2Id = t2.id;

    // ---- inbound emails (one per thread, plus one more for thread2) ----
    const [ie1] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: thread1Id,
        provider: "postmark",
        providerMessageId: `ctx-msg1-${RUN_ID}`,
        senderEmail: `sender1-${RUN_ID}@example.com`,
        subject: "Thread 1 email",
        textBody: "body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inbound1Id = ie1.id;

    const [ie2] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: thread2Id,
        provider: "postmark",
        providerMessageId: `ctx-msg2-${RUN_ID}`,
        senderEmail: `sender2-${RUN_ID}@example.com`,
        subject: "Thread 2 email",
        textBody: "body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inbound2Id = ie2.id;

    const [ie3] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: thread2Id,
        provider: "postmark",
        providerMessageId: `ctx-msg3-${RUN_ID}`,
        senderEmail: `sender3-${RUN_ID}@example.com`,
        subject: "Thread 2 email 2",
        textBody: "body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inbound3Id = ie3.id;

    // ---- source evidence rows (required FK for loops) ----
    const [ev1] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inbound1Id, providerMessageId: `ctx-msg1-${RUN_ID}`, quote: "quote1", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });
    evidence1Id = ev1.id;

    const [ev2] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inbound2Id, providerMessageId: `ctx-msg2-${RUN_ID}`, quote: "quote2", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });
    evidence2Id = ev2.id;

    const [ev3] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inbound3Id, providerMessageId: `ctx-msg3-${RUN_ID}`, quote: "quote3", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });
    evidence3Id = ev3.id;

    // ---- participant entity ----
    const [pe] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person" as const,
        displayName: `Participant-${RUN_ID}`,
        canonicalEmail: `participant-${RUN_ID}@corp.example`,
        aliases: [],
        metadata: {},
      })
      .returning({ id: entities.id });
    participantEntityId = pe.id;

    // ---- loops ----

    // Loop A: open, on thread1 (same-thread signal)
    const [la] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread1Id,
        inboundEmailId: inbound1Id,
        sourceEvidenceId: evidence1Id,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `Deliver project alpha proposal by Friday ${RUN_ID}`,
        confidence: 0.9,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopSameThread = la.id;

    // Loop B: open, on thread2, linked to participantEntity (entity signal, different thread)
    const [lb] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread2Id,
        inboundEmailId: inbound2Id,
        sourceEvidenceId: evidence2Id,
        status: "waiting_on_other" as const,
        kind: "ask" as const,
        basis: "inferred_next_step" as const,
        summary: `Follow up on beta integration review ${RUN_ID}`,
        confidence: 0.75,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopEntityOnly = lb.id;

    // Link loop B to participantEntity as participant
    await db
      .insert(loopEntities)
      .values({ loopId: loopEntityOnly, entityId: participantEntityId, role: "participant" as const })
      .onConflictDoNothing();

    // Loop C: open, on thread2, topically similar summary but NO thread/entity link to thread1 or participant
    const [lc] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread2Id,
        inboundEmailId: inbound3Id,
        sourceEvidenceId: evidence3Id,
        status: "candidate" as const,
        kind: "reminder" as const,
        basis: "inferred_next_step" as const,
        // Summary deliberately contains words that will trigram-match a query about "project proposal"
        summary: `Send project proposal documents to client ${RUN_ID}`,
        confidence: 0.6,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopTrigramOnly = lc.id;

    // Loop D: done — must NOT be returned
    const [ld] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread1Id,
        inboundEmailId: inbound1Id,
        sourceEvidenceId: evidence1Id,
        status: "done" as const,
        kind: "other" as const,
        basis: "inferred_next_step" as const,
        summary: `Completed task on thread1 ${RUN_ID}`,
        confidence: 0.8,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopDone = ld.id;

    // Loop E: dismissed — must NOT be returned
    const [le] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread1Id,
        inboundEmailId: inbound1Id,
        sourceEvidenceId: evidence1Id,
        status: "dismissed" as const,
        kind: "other" as const,
        basis: "inferred_next_step" as const,
        summary: `Dismissed task ${RUN_ID}`,
        confidence: 0.5,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopDismissed = le.id;

    // Loop F: suppressed — must NOT be returned
    const [lf] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread2Id,
        inboundEmailId: inbound2Id,
        sourceEvidenceId: evidence2Id,
        status: "suppressed" as const,
        kind: "other" as const,
        basis: "inferred_next_step" as const,
        summary: `Suppressed loop ${RUN_ID}`,
        confidence: 0.4,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopSuppressed = lf.id;

    // Loop G: open, recent, no other signals
    const [lg] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread2Id,
        inboundEmailId: inbound2Id,
        sourceEvidenceId: evidence2Id,
        status: "open" as const,
        kind: "other" as const,
        basis: "inferred_next_step" as const,
        summary: `Recent unrelated loop ${RUN_ID}`,
        confidence: 0.5,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopRecent = lg.id;
  });

  afterAll(async () => {
    // Clean up in FK-safe order: loop_entities → loops → source_evidence → inbound_emails
    //   → email_threads → entities → users.
    // Cascade on userId will handle most, but explicit cleanup prevents FK violations.
    const allLoopIds = [
      loopSameThread, loopEntityOnly, loopTrigramOnly,
      loopDone, loopDismissed, loopSuppressed, loopRecent,
    ].filter(Boolean);

    if (allLoopIds.length > 0) {
      await db.delete(loopEntities).where(inArray(loopEntities.loopId, allLoopIds));
      await db.delete(loops).where(inArray(loops.id, allLoopIds));
    }

    const allEvidenceIds = [evidence1Id, evidence2Id, evidence3Id].filter(Boolean);
    if (allEvidenceIds.length > 0) {
      await db.delete(sourceEvidence).where(inArray(sourceEvidence.id, allEvidenceIds));
    }

    const allInboundIds = [inbound1Id, inbound2Id, inbound3Id].filter(Boolean);
    if (allInboundIds.length > 0) {
      await db.delete(inboundEmails).where(inArray(inboundEmails.id, allInboundIds));
    }

    const allThreadIds = [thread1Id, thread2Id].filter(Boolean);
    if (allThreadIds.length > 0) {
      await db.delete(emailThreads).where(inArray(emailThreads.id, allThreadIds));
    }

    if (participantEntityId) {
      await db.delete(entities).where(eq(entities.id, participantEntityId));
    }

    await db.delete(users).where(eq(users.id, userId));

    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // (a) Thread generator: same-thread open loops are returned
  // ---------------------------------------------------------------------------

  it("(a) thread generator: returns open loops on the same threadId", async () => {
    const ctx = await loadExtractionContext(
      { userId, threadId: thread1Id, participants: [] },
      db,
    );

    const ids = ctx.openLoops.map((l) => l.id);
    expect(ids).toContain(loopSameThread);

    const found = ctx.openLoops.find((l) => l.id === loopSameThread)!;
    expect(found.generators).toContain("thread");
  });

  // ---------------------------------------------------------------------------
  // (b) Entity generator: cross-thread loop linked to participant entity is returned
  // ---------------------------------------------------------------------------

  it("(b) entity generator: returns loop on different thread linked to participant entity", async () => {
    const ctx = await loadExtractionContext(
      {
        userId,
        threadId: thread1Id, // current thread — loopEntityOnly is on thread2
        participants: [
          { name: `Participant-${RUN_ID}`, email: `participant-${RUN_ID}@corp.example` },
        ],
      },
      db,
    );

    const ids = ctx.openLoops.map((l) => l.id);
    expect(ids).toContain(loopEntityOnly);

    const found = ctx.openLoops.find((l) => l.id === loopEntityOnly)!;
    expect(found.generators).toContain("entity");
    // loopEntityOnly is on thread2, NOT thread1
    expect(found.emailThreadId).toBe(thread2Id);
  });

  // ---------------------------------------------------------------------------
  // (c) Trigram generator: topically-similar loop surfaces even with no thread/entity overlap
  // ---------------------------------------------------------------------------

  it("(c) trigram generator: surfaces topically-similar loop with no thread or entity overlap", async () => {
    const ctx = await loadExtractionContext(
      {
        userId,
        threadId: null,   // no thread — ensures loopTrigramOnly can only surface via trigram
        participants: [],  // no participant entity — ensures no entity path
        // queryText matches "project proposal" in loopTrigramOnly's summary
        queryText: "project proposal client",
        limit: 20,
      },
      db,
    );

    const ids = ctx.openLoops.map((l) => l.id);
    expect(ids).toContain(loopTrigramOnly);

    const found = ctx.openLoops.find((l) => l.id === loopTrigramOnly)!;
    expect(found.generators).toContain("trigram");
  });

  // ---------------------------------------------------------------------------
  // (d) done/dismissed/suppressed loops are NEVER returned
  // ---------------------------------------------------------------------------

  it("(d) done, dismissed, suppressed loops are never returned", async () => {
    const ctx = await loadExtractionContext(
      { userId, threadId: thread1Id, participants: [], limit: 50 },
      db,
    );

    const ids = ctx.openLoops.map((l) => l.id);
    expect(ids).not.toContain(loopDone);
    expect(ids).not.toContain(loopDismissed);
    expect(ids).not.toContain(loopSuppressed);

    // Sanity: all returned loops have an OPEN_STATUSES status
    for (const l of ctx.openLoops) {
      expect(OPEN_STATUSES).toContain(l.status);
    }
  });

  // ---------------------------------------------------------------------------
  // (e) Capped at `limit`; thread-matched loop outranks a recent-only loop
  // ---------------------------------------------------------------------------

  it("(e) result is capped at limit; thread-matched loop outranks recent-only loop", async () => {
    const ctx = await loadExtractionContext(
      {
        userId,
        threadId: thread1Id,
        participants: [],
        limit: 2,
      },
      db,
    );

    // Capped
    expect(ctx.openLoops.length).toBeLessThanOrEqual(2);

    // The thread-matched loop must be #1 (highest score)
    expect(ctx.openLoops[0].id).toBe(loopSameThread);

    // refIds are sequential from L1
    ctx.openLoops.forEach((l, i) => {
      expect(l.refId).toBe(`L${i + 1}`);
    });
  });

  // ---------------------------------------------------------------------------
  // (f) Output is serialization-safe (dueAt/updatedAt are strings)
  // ---------------------------------------------------------------------------

  it("(f) output is serialization-safe: dueAt and updatedAt are strings", async () => {
    const ctx = await loadExtractionContext(
      { userId, threadId: thread1Id, participants: [] },
      db,
    );

    for (const l of ctx.openLoops) {
      expect(typeof l.updatedAt).toBe("string");
      // updatedAt should parse as a valid ISO date
      expect(Number.isNaN(new Date(l.updatedAt).getTime())).toBe(false);

      if (l.dueAt !== null) {
        expect(typeof l.dueAt).toBe("string");
        expect(Number.isNaN(new Date(l.dueAt).getTime())).toBe(false);
      }
    }

    // Verify round-trip JSON safety
    expect(() => JSON.stringify(ctx)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(ctx));
    expect(parsed.openLoops.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // (g) entityIds on a candidate include its loop_entities participant links
  // ---------------------------------------------------------------------------

  it("(g) entityIds on a surviving candidate include owner/requester/participant entity links", async () => {
    const ctx = await loadExtractionContext(
      {
        userId,
        threadId: thread1Id,
        participants: [
          { name: `Participant-${RUN_ID}`, email: `participant-${RUN_ID}@corp.example` },
        ],
        limit: 20,
      },
      db,
    );

    // loopEntityOnly is linked to participantEntityId as participant
    const found = ctx.openLoops.find((l) => l.id === loopEntityOnly);
    expect(found).toBeDefined();
    if (found) {
      expect(found.entityIds).toContain(participantEntityId);
    }
  });

  // ---------------------------------------------------------------------------
  // (h) knownEntities includes participant entities with their openLoopCount
  // ---------------------------------------------------------------------------

  it("(h) knownEntities contains the participant entity with correct openLoopCount", async () => {
    const ctx = await loadExtractionContext(
      {
        userId,
        threadId: thread1Id,
        participants: [
          { name: `Participant-${RUN_ID}`, email: `participant-${RUN_ID}@corp.example` },
        ],
        limit: 20,
      },
      db,
    );

    const participantEntityRow = ctx.knownEntities.find((e) => e.id === participantEntityId);
    expect(participantEntityRow).toBeDefined();

    if (participantEntityRow) {
      // participantEntity is linked to loopEntityOnly (which is open)
      expect(participantEntityRow.openLoopCount).toBeGreaterThanOrEqual(1);
      expect(participantEntityRow.canonicalEmail).toBe(`participant-${RUN_ID}@corp.example`);
      expect(participantEntityRow.kind).toBe("person");
    }
  });

  // ---------------------------------------------------------------------------
  // (i) Default limit of 10 is respected
  // ---------------------------------------------------------------------------

  it("(i) default limit of 10 is respected when limit is not specified", async () => {
    const ctx = await loadExtractionContext(
      { userId, threadId: null, participants: [] },
      db,
    );

    expect(ctx.openLoops.length).toBeLessThanOrEqual(10);
  });

  // ---------------------------------------------------------------------------
  // (j) Multi-generator: a loop gets all generator labels when found by multiple paths
  // ---------------------------------------------------------------------------

  it("(j) multi-generator: loop surfaced by both thread and entity has both labels", async () => {
    // Create a loop on thread1 AND linked to participantEntity
    const [ev] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inbound1Id, providerMessageId: `ctx-multi-${RUN_ID}`, quote: "q", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });

    const [multiLoop] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: thread1Id,
        inboundEmailId: inbound1Id,
        sourceEvidenceId: ev.id,
        status: "open" as const,
        kind: "ask" as const,
        basis: "inferred_next_step" as const,
        summary: `Multi-generator loop ${RUN_ID}`,
        confidence: 0.85,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });

    await db
      .insert(loopEntities)
      .values({ loopId: multiLoop.id, entityId: participantEntityId, role: "participant" as const })
      .onConflictDoNothing();

    try {
      const ctx = await loadExtractionContext(
        {
          userId,
          threadId: thread1Id,
          participants: [
            { name: `Participant-${RUN_ID}`, email: `participant-${RUN_ID}@corp.example` },
          ],
          limit: 20,
        },
        db,
      );

      const found = ctx.openLoops.find((l) => l.id === multiLoop.id);
      expect(found).toBeDefined();
      if (found) {
        expect(found.generators).toContain("thread");
        expect(found.generators).toContain("entity");
        // Score should reflect both thread and entity contributions
        expect(found.score).toBeGreaterThanOrEqual(1.0 + 0.7); // SCORE_THREAD + SCORE_ENTITY
      }
    } finally {
      // Clean up extra loop
      await db.delete(loopEntities).where(eq(loopEntities.loopId, multiLoop.id));
      await db.delete(loops).where(eq(loops.id, multiLoop.id));
      await db.delete(sourceEvidence).where(eq(sourceEvidence.id, ev.id));
    }
  });
});
