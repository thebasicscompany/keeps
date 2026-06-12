/**
 * DB-gated integration tests for DrizzleNudgeRepository.
 *
 * These tests require a live Postgres instance. They are SKIPPED unless the
 * TEST_DATABASE_URL environment variable is set. To run:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 *
 * Each test constructs its own fixture rows (users → email_threads →
 * inbound_emails → source_evidence → loops) and cleans up in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  auditLog,
  emailThreads,
  inboundEmails,
  loopEvents,
  loops,
  nudges,
  sourceEvidence,
  users,
} from "@/db/schema";
import { DrizzleNudgeRepository } from "@/nudges/repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("DrizzleNudgeRepository (DB integration)", () => {
  // ---------------------------------------------------------------------------
  // Shared fixtures
  // ---------------------------------------------------------------------------

  // We keep IDs in module scope so afterAll can clean up.
  let userId: string;
  let emailThreadId: string;
  let inboundEmailId: string;
  let sourceEvidenceId: string;
  let loopId: string;
  let nudgeRowId: string;

  // Separate user for cap-counting tests
  let userId2: string;
  let emailThreadId2: string;
  let inboundEmailId2: string;
  let sourceEvidenceId2: string;
  let loopId2: string;

  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrizzleNudgeRepository(db as any);

  const NOW = new Date("2026-06-12T12:00:00.000Z");
  // A next_check_at in the past — should be returned by findNudgeCandidates
  const PAST_CHECK = new Date("2026-06-11T12:00:00.000Z");
  // A next_check_at in the future — should NOT be returned
  const FUTURE_CHECK = new Date("2026-06-13T12:00:00.000Z");

  beforeAll(async () => {
    // ----- User 1: LA timezone -----
    const [u] = await db
      .insert(users)
      .values({
        email: `test-nudge-repo-${Date.now()}@test.invalid`,
        timezone: "America/Los_Angeles",
        digestEnabled: true,
        digestSendHour: 8,
      })
      .returning({ id: users.id });
    userId = u.id;

    const [t] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `thread-nudge-repo-${userId}` })
      .returning({ id: emailThreads.id });
    emailThreadId = t.id;

    const [ie] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId,
        provider: "test",
        providerMessageId: `msg-nudge-repo-${userId}`,
        senderEmail: "sender@test.invalid",
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundEmailId = ie.id;

    const [se] = await db
      .insert(sourceEvidence)
      .values({
        userId,
        inboundEmailId,
        providerMessageId: `msg-nudge-repo-${userId}`,
        quote: "Follow up on the proposal",
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId = se.id;

    const [l] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open",
        summary: "Follow up on the proposal",
        confidence: 0.9,
        nextCheckAt: PAST_CHECK,
        createdAt: new Date("2026-06-10T12:00:00.000Z"),
        lastNudgedAt: null,
        nudgeCount: 0,
      })
      .returning({ id: loops.id });
    loopId = l.id;

    // ----- User 2: for daily cap counting -----
    const [u2] = await db
      .insert(users)
      .values({
        email: `test-nudge-repo2-${Date.now()}@test.invalid`,
        timezone: "Europe/London",
        digestEnabled: true,
        digestSendHour: 8,
      })
      .returning({ id: users.id });
    userId2 = u2.id;

    const [t2] = await db
      .insert(emailThreads)
      .values({ userId: userId2, threadKey: `thread-nudge-repo-${userId2}` })
      .returning({ id: emailThreads.id });
    emailThreadId2 = t2.id;

    const [ie2] = await db
      .insert(inboundEmails)
      .values({
        userId: userId2,
        emailThreadId: emailThreadId2,
        provider: "test",
        providerMessageId: `msg-nudge-repo-${userId2}`,
        senderEmail: "sender2@test.invalid",
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundEmailId2 = ie2.id;

    const [se2] = await db
      .insert(sourceEvidence)
      .values({
        userId: userId2,
        inboundEmailId: inboundEmailId2,
        providerMessageId: `msg-nudge-repo-${userId2}`,
        quote: "Send the invoice",
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId2 = se2.id;

    const [l2] = await db
      .insert(loops)
      .values({
        userId: userId2,
        emailThreadId: emailThreadId2,
        inboundEmailId: inboundEmailId2,
        sourceEvidenceId: sourceEvidenceId2,
        status: "waiting_on_me",
        summary: "Send the invoice",
        confidence: 0.8,
        nextCheckAt: FUTURE_CHECK, // future — should NOT appear in findNudgeCandidates
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
        lastNudgedAt: null,
        nudgeCount: 0,
      })
      .returning({ id: loops.id });
    loopId2 = l2.id;
  });

  afterAll(async () => {
    // Clean up in reverse FK order.
    // loopEvents + auditLog that reference our loops/users
    await db.delete(loopEvents).where(eq(loopEvents.loopId, loopId));
    await db.delete(auditLog).where(eq(auditLog.userId, userId));
    await db.delete(auditLog).where(eq(auditLog.userId, userId2));
    if (nudgeRowId) {
      await db.delete(nudges).where(eq(nudges.id, nudgeRowId));
    }
    // Also clean up any other nudges we created
    await db.delete(nudges).where(eq(nudges.userId, userId));
    await db.delete(nudges).where(eq(nudges.userId, userId2));
    await db.delete(loops).where(eq(loops.id, loopId));
    await db.delete(loops).where(eq(loops.id, loopId2));
    await db.delete(sourceEvidence).where(eq(sourceEvidence.id, sourceEvidenceId));
    await db.delete(sourceEvidence).where(eq(sourceEvidence.id, sourceEvidenceId2));
    await db.delete(inboundEmails).where(eq(inboundEmails.id, inboundEmailId));
    await db.delete(inboundEmails).where(eq(inboundEmails.id, inboundEmailId2));
    await db.delete(emailThreads).where(eq(emailThreads.id, emailThreadId));
    await db.delete(emailThreads).where(eq(emailThreads.id, emailThreadId2));
    await db.delete(users).where(inArray(users.id, [userId, userId2]));
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // findNudgeCandidates — eligibility pre-filter
  // ---------------------------------------------------------------------------

  it("findNudgeCandidates returns loop with next_check_at in the past", async () => {
    const candidates = await repo.findNudgeCandidates(NOW);
    const found = candidates.find((c) => c.id === loopId);
    expect(found).toBeDefined();
    expect(found?.userId).toBe(userId);
    expect(found?.status).toBe("open");
    expect(found?.userTimezone).toBe("America/Los_Angeles");
    expect(found?.summary).toBe("Follow up on the proposal");
    expect(found?.nudgeCount).toBe(0);
    expect(found?.lastNudgedAt).toBeNull();
  });

  it("findNudgeCandidates does NOT return loop with next_check_at in the future", async () => {
    const candidates = await repo.findNudgeCandidates(NOW);
    const found = candidates.find((c) => c.id === loopId2);
    expect(found).toBeUndefined();
  });

  it("findNudgeCandidates excludes done/dismissed/blocked/snoozed loops", async () => {
    // Temporarily set our loop to 'done' and verify it disappears.
    await db.update(loops).set({ status: "done" }).where(eq(loops.id, loopId));
    const candidates = await repo.findNudgeCandidates(NOW);
    const found = candidates.find((c) => c.id === loopId);
    expect(found).toBeUndefined();

    // Restore for subsequent tests.
    await db.update(loops).set({ status: "open" }).where(eq(loops.id, loopId));
  });

  // ---------------------------------------------------------------------------
  // countNudgesSentSince — daily cap window
  // ---------------------------------------------------------------------------

  it("countNudgesSentSince returns 0 when no nudges exist", async () => {
    const since = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const count = await repo.countNudgesSentSince(userId, since);
    expect(count).toBe(0);
  });

  it("countNudgesSentSince counts only 'nudge' type rows within the window", async () => {
    const since = new Date("2026-06-12T00:00:00.000Z"); // start of the day

    // Insert a 'nudge' type sent within the window.
    await db.insert(nudges).values({
      userId,
      loopId,
      nudgeType: "nudge",
      status: "sent",
      channel: "email",
      body: "Check in on the proposal",
      sentAt: new Date("2026-06-12T09:00:00.000Z"),
    });

    // Insert a 'digest' type — should NOT count toward cap.
    await db.insert(nudges).values({
      userId,
      nudgeType: "digest",
      status: "sent",
      channel: "email",
      body: "Daily digest",
      sentAt: new Date("2026-06-12T08:00:00.000Z"),
    });

    // Insert a 'nudge' type but BEFORE the window — should NOT count.
    await db.insert(nudges).values({
      userId,
      loopId,
      nudgeType: "nudge",
      status: "sent",
      channel: "email",
      body: "Yesterday nudge",
      sentAt: new Date("2026-06-11T10:00:00.000Z"),
    });

    const count = await repo.countNudgesSentSince(userId, since);
    expect(count).toBe(1); // only the in-window 'nudge' row
  });

  // ---------------------------------------------------------------------------
  // markLoopNudged — bookkeeping writes
  // ---------------------------------------------------------------------------

  it("markLoopNudged sets last_nudged_at, increments nudge_count, advances next_check_at", async () => {
    const nextCheckAt = new Date("2026-06-15T12:00:00.000Z");
    await repo.markLoopNudged({ loopId, nextCheckAt, now: NOW });

    const [row] = await db
      .select({ lastNudgedAt: loops.lastNudgedAt, nudgeCount: loops.nudgeCount, nextCheckAt: loops.nextCheckAt })
      .from(loops)
      .where(eq(loops.id, loopId));

    expect(row.lastNudgedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.nudgeCount).toBe(1);
    expect(row.nextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
  });

  // ---------------------------------------------------------------------------
  // deferLoopNextCheck — cap deferral
  // ---------------------------------------------------------------------------

  it("deferLoopNextCheck advances next_check_at without touching nudge_count", async () => {
    const beforeCount = (
      await db.select({ nudgeCount: loops.nudgeCount }).from(loops).where(eq(loops.id, loopId))
    )[0].nudgeCount;

    const deferredTo = new Date("2026-06-16T12:00:00.000Z");
    await repo.deferLoopNextCheck({ loopId, nextCheckAt: deferredTo, now: NOW });

    const [row] = await db
      .select({ nudgeCount: loops.nudgeCount, nextCheckAt: loops.nextCheckAt })
      .from(loops)
      .where(eq(loops.id, loopId));

    expect(row.nextCheckAt?.toISOString()).toBe(deferredTo.toISOString());
    expect(row.nudgeCount).toBe(beforeCount); // unchanged
  });

  // ---------------------------------------------------------------------------
  // createNudgeRow
  // ---------------------------------------------------------------------------

  it("createNudgeRow inserts a pending nudge row and returns its id", async () => {
    const result = await repo.createNudgeRow({
      userId,
      loopId,
      inboundEmailId: null,
      subject: "Check in on the proposal",
      body: "Hi, just checking in on the proposal.",
      type: "nudge",
      metadata: { ordinalToLoopId: { 1: loopId } },
    });

    nudgeRowId = result.id;
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);

    const [row] = await db
      .select({ status: nudges.status, nudgeType: nudges.nudgeType })
      .from(nudges)
      .where(eq(nudges.id, result.id));

    expect(row.status).toBe("pending");
    expect(row.nudgeType).toBe("nudge");
  });

  // ---------------------------------------------------------------------------
  // writeLoopEvent
  // ---------------------------------------------------------------------------

  it("writeLoopEvent inserts a loop_events row of type 'nudged'", async () => {
    await repo.writeLoopEvent({ userId, loopId, eventType: "nudged", metadata: { nudgeCount: 1 } });

    const [row] = await db
      .select({ eventType: loopEvents.eventType })
      .from(loopEvents)
      .where(eq(loopEvents.loopId, loopId));

    expect(row.eventType).toBe("nudged");
  });

  // ---------------------------------------------------------------------------
  // writeAudit
  // ---------------------------------------------------------------------------

  it("writeAudit inserts an audit_log row with action 'nudge.sent'", async () => {
    await repo.writeAudit({ userId, action: "nudge.sent", metadata: { loopId } });

    const [row] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.userId, userId));

    expect(row.action).toBe("nudge.sent");
  });
});
