/**
 * DB-gated integration tests for listRecentReconciliations.
 *
 * SKIPPED unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 *
 * Seeds a user + loop + reconciliation loop_events, then asserts the helper
 * returns them newest-first with the correct metadata fields.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { users, loops, loopEvents, emailThreads, inboundEmails, sourceEvidence } from "@/db/schema";
import { listRecentReconciliations } from "@/admin/reconciliations";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("listRecentReconciliations (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });

  const RUN_ID = Date.now();
  let userId: string;
  let loopId: string;
  let threadId: string;
  let inboundEmailId: string;
  let sourceEvidenceId: string;
  let eventId1: string;
  let eventId2: string;
  let eventId3: string;

  beforeAll(async () => {
    // Create user
    const [user] = await db
      .insert(users)
      .values({ email: `reconcile-test-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = user.id;

    // Create email thread (threadKey is the unique provider thread ID)
    const [thread] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `thread-${RUN_ID}`, subject: "Test thread" })
      .returning({ id: emailThreads.id });
    threadId = thread.id;

    // Create inbound email (uses senderEmail, provider, normalizedPayload, rawPayload)
    const [inbound] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: threadId,
        provider: "postmark",
        providerMessageId: `msg-${RUN_ID}`,
        subject: "Test email",
        senderEmail: "sender@test.invalid",
        textBody: "Test body",
        normalizedPayload: {},
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
        providerMessageId: `msg-${RUN_ID}`,
        quote: "I will send the deck.",
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId = evidence.id;

    // Create loop
    const [loop] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: threadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open",
        summary: "Send the deck to Maya.",
        confidence: 0.9,
      })
      .returning({ id: loops.id });
    loopId = loop.id;

    // Insert reconciliation events with slightly different timestamps
    const t0 = new Date("2026-06-14T10:00:00.000Z");
    const t1 = new Date("2026-06-14T10:01:00.000Z");
    const t2 = new Date("2026-06-14T10:02:00.000Z");

    const [ev1] = await db
      .insert(loopEvents)
      .values({
        userId,
        loopId,
        eventType: "reconciled",
        metadata: {
          sourceInboundEmailId: inboundEmailId,
          action: "update",
          reason: "Reply confirmed deck was sent.",
          evidence: "Sending it now.",
        },
        createdAt: t0,
      })
      .returning({ id: loopEvents.id });
    eventId1 = ev1.id;

    const [ev2] = await db
      .insert(loopEvents)
      .values({
        userId,
        loopId,
        eventType: "reconcile_suggested",
        metadata: {
          sourceInboundEmailId: inboundEmailId,
          candidateLoopId: loopId,
          reason: "Possible duplicate — asked user to confirm.",
          evidence: "Looks like a follow-up on the same thread.",
        },
        createdAt: t1,
      })
      .returning({ id: loopEvents.id });
    eventId2 = ev2.id;

    const [ev3] = await db
      .insert(loopEvents)
      .values({
        userId,
        loopId,
        eventType: "superseded",
        metadata: {
          reason: "User confirmed it was a duplicate.",
          evidence: "Yes, same thing.",
        },
        createdAt: t2,
      })
      .returning({ id: loopEvents.id });
    eventId3 = ev3.id;
  });

  afterAll(async () => {
    // Clean up in FK-safe order
    const evIds = [eventId1, eventId2, eventId3].filter(Boolean);
    if (evIds.length > 0) {
      await db.delete(loopEvents).where(inArray(loopEvents.id, evIds));
    }
    if (loopId) {
      await db.delete(loops).where(eq(loops.id, loopId));
    }
    if (sourceEvidenceId) {
      await db.delete(sourceEvidence).where(eq(sourceEvidence.id, sourceEvidenceId));
    }
    if (inboundEmailId) {
      await db.delete(inboundEmails).where(eq(inboundEmails.id, inboundEmailId));
    }
    if (threadId) {
      await db.delete(emailThreads).where(eq(emailThreads.id, threadId));
    }
    if (userId) {
      await db.delete(users).where(eq(users.id, userId));
    }
    await sql.end();
  });

  it("returns all three reconciliation event types", async () => {
    const rows = await listRecentReconciliations({ db });
    const ourIds = [eventId1, eventId2, eventId3];
    const returned = rows.filter((r) => ourIds.includes(r.id));
    expect(returned).toHaveLength(3);
  });

  it("returns rows newest-first", async () => {
    const rows = await listRecentReconciliations({ db });
    const ourRows = rows.filter((r) => [eventId1, eventId2, eventId3].includes(r.id));
    // superseded (t2) should come before reconcile_suggested (t1) before reconciled (t0)
    const types = ourRows.map((r) => r.eventType);
    const supersededIdx = types.indexOf("superseded");
    const suggestedIdx = types.indexOf("reconcile_suggested");
    const reconciledIdx = types.indexOf("reconciled");
    expect(supersededIdx).toBeLessThan(suggestedIdx);
    expect(suggestedIdx).toBeLessThan(reconciledIdx);
  });

  it("includes loop summary from the joined loops row", async () => {
    const rows = await listRecentReconciliations({ db });
    const ourRows = rows.filter((r) => [eventId1, eventId2, eventId3].includes(r.id));
    for (const r of ourRows) {
      expect(r.loopSummary).toBe("Send the deck to Maya.");
    }
  });

  it("preserves metadata fields on a reconciled event", async () => {
    const rows = await listRecentReconciliations({ db });
    const ev = rows.find((r) => r.id === eventId1);
    expect(ev).toBeDefined();
    expect(ev!.eventType).toBe("reconciled");
    const meta = ev!.metadata as Record<string, unknown>;
    expect(meta.action).toBe("update");
    expect(meta.reason).toBe("Reply confirmed deck was sent.");
    expect(meta.evidence).toBe("Sending it now.");
  });

  it("preserves metadata fields on a reconcile_suggested event", async () => {
    const rows = await listRecentReconciliations({ db });
    const ev = rows.find((r) => r.id === eventId2);
    expect(ev).toBeDefined();
    expect(ev!.eventType).toBe("reconcile_suggested");
    const meta = ev!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("Possible duplicate — asked user to confirm.");
    expect(meta.candidateLoopId).toBe(loopId);
  });

  it("respects the limit parameter", async () => {
    const rows = await listRecentReconciliations({ db, limit: 1 });
    expect(rows.length).toBe(1);
    // newest first → superseded
    expect(rows[0]?.eventType).toBe("superseded");
  });

  it("returns createdAt as a Date", async () => {
    const rows = await listRecentReconciliations({ db });
    const ev = rows.find((r) => r.id === eventId1);
    expect(ev!.createdAt).toBeInstanceOf(Date);
  });
});
