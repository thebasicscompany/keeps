/**
 * DB-gated integration tests for DrizzleDigestRepository.
 *
 * These tests require a live Postgres instance. They are SKIPPED unless the
 * TEST_DATABASE_URL environment variable is set. To run:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 *
 * Asserts:
 *   - findDigestEnabledUsers returns only digest-enabled users.
 *   - findLoopsForDigest returns active-status loops + recently-done loops.
 *   - findLoopsForDigest excludes done loops older than 24h and non-active statuses.
 *   - hasRecentDigest: the 23h recency guard.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  emailThreads,
  inboundEmails,
  loops,
  nudges,
  sourceEvidence,
  users,
} from "@/db/schema";
import { DrizzleDigestRepository } from "@/digests/repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("DrizzleDigestRepository (DB integration)", () => {
  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  let userId: string;       // LA user, digest enabled, send_hour=8
  let userId2: string;      // UTC user, digest DISABLED
  let emailThreadId: string;
  let inboundEmailId: string;
  let sourceEvidenceId: string;

  // Loop IDs for various status/age combinations
  let loopOpenId: string;          // open, active
  let loopWaitingMeId: string;     // waiting_on_me, active
  let loopWaitingOtherId: string;  // waiting_on_other, active
  let loopDoneRecentId: string;    // done, updated < 24h ago
  let loopDoneOldId: string;       // done, updated > 24h ago — EXCLUDED from digest
  let loopSnoozedId: string;       // snoozed — EXCLUDED

  // biome-ignore lint: non-null assertion safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrizzleDigestRepository(db as any);

  const NOW = new Date("2026-06-12T16:00:00.000Z");
  const RECENT = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);  // 12h ago (within 24h)
  const OLD    = new Date(NOW.getTime() - 30 * 60 * 60 * 1000);  // 30h ago (outside 24h)

  beforeAll(async () => {
    const ts = Date.now();

    // User 1: LA, digest enabled, hour 8
    const [u] = await db
      .insert(users)
      .values({
        email: `test-digest-repo-${ts}@test.invalid`,
        timezone: "America/Los_Angeles",
        digestEnabled: true,
        digestSendHour: 8,
      })
      .returning({ id: users.id });
    userId = u.id;

    // User 2: UTC, digest DISABLED
    const [u2] = await db
      .insert(users)
      .values({
        email: `test-digest-repo2-${ts}@test.invalid`,
        timezone: "UTC",
        digestEnabled: false,
        digestSendHour: 9,
      })
      .returning({ id: users.id });
    userId2 = u2.id;

    // Shared email chain for user 1
    const [t] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `thread-digest-repo-${ts}` })
      .returning({ id: emailThreads.id });
    emailThreadId = t.id;

    const [ie] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId,
        provider: "test",
        providerMessageId: `msg-digest-repo-${ts}`,
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
        providerMessageId: `msg-digest-repo-${ts}`,
        quote: "Fixture quote",
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId = se.id;

    // Helper to insert a loop with a given status and updatedAt
    async function insertLoop(status: string, updatedAt: Date): Promise<string> {
      const [l] = await db
        .insert(loops)
        .values({
          userId,
          emailThreadId,
          inboundEmailId,
          sourceEvidenceId,
          status: status as schema.Loop["status"],
          summary: `Loop ${status}`,
          confidence: 0.8,
          nextCheckAt: null,
          updatedAt,
        })
        .returning({ id: loops.id });
      return l.id;
    }

    loopOpenId         = await insertLoop("open",            RECENT);
    loopWaitingMeId    = await insertLoop("waiting_on_me",   RECENT);
    loopWaitingOtherId = await insertLoop("waiting_on_other", OLD);  // stale but included (active status)
    loopDoneRecentId   = await insertLoop("done",            RECENT); // done within 24h
    loopDoneOldId      = await insertLoop("done",            OLD);    // done > 24h ago — excluded
    loopSnoozedId      = await insertLoop("snoozed",         RECENT); // snoozed — excluded
  });

  afterAll(async () => {
    const loopIds = [
      loopOpenId,
      loopWaitingMeId,
      loopWaitingOtherId,
      loopDoneRecentId,
      loopDoneOldId,
      loopSnoozedId,
    ].filter(Boolean);

    await db.delete(nudges).where(eq(nudges.userId, userId));
    if (loopIds.length > 0) {
      await db.delete(loops).where(inArray(loops.id, loopIds));
    }
    await db.delete(sourceEvidence).where(eq(sourceEvidence.id, sourceEvidenceId));
    await db.delete(inboundEmails).where(eq(inboundEmails.id, inboundEmailId));
    await db.delete(emailThreads).where(eq(emailThreads.id, emailThreadId));
    await db.delete(users).where(inArray(users.id, [userId, userId2]));
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // findDigestEnabledUsers — only digest-enabled users
  // ---------------------------------------------------------------------------

  it("findDigestEnabledUsers includes user1 (digest_enabled=true)", async () => {
    const all = await repo.findDigestEnabledUsers();
    const found = all.find((u) => u.id === userId);
    expect(found).toBeDefined();
    expect(found?.digestEnabled).toBe(true);
    expect(found?.timezone).toBe("America/Los_Angeles");
    expect(found?.digestSendHour).toBe(8);
  });

  it("findDigestEnabledUsers excludes user2 (digest_enabled=false)", async () => {
    const all = await repo.findDigestEnabledUsers();
    const found = all.find((u) => u.id === userId2);
    expect(found).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // findLoopsForDigest — active-status and recently-done loops
  // ---------------------------------------------------------------------------

  it("findLoopsForDigest returns open, waiting_on_me, waiting_on_other loops", async () => {
    const digest = await repo.findLoopsForDigest(userId, NOW);
    const ids = digest.map((l) => l.id);

    expect(ids).toContain(loopOpenId);
    expect(ids).toContain(loopWaitingMeId);
    expect(ids).toContain(loopWaitingOtherId);
  });

  it("findLoopsForDigest includes done loop updated within 24h", async () => {
    const digest = await repo.findLoopsForDigest(userId, NOW);
    const ids = digest.map((l) => l.id);
    expect(ids).toContain(loopDoneRecentId);
  });

  it("findLoopsForDigest excludes done loop updated more than 24h ago", async () => {
    const digest = await repo.findLoopsForDigest(userId, NOW);
    const ids = digest.map((l) => l.id);
    expect(ids).not.toContain(loopDoneOldId);
  });

  it("findLoopsForDigest excludes snoozed loops", async () => {
    const digest = await repo.findLoopsForDigest(userId, NOW);
    const ids = digest.map((l) => l.id);
    expect(ids).not.toContain(loopSnoozedId);
  });

  it("findLoopsForDigest returns full DigestLoopInput shape", async () => {
    const digest = await repo.findLoopsForDigest(userId, NOW);
    const open = digest.find((l) => l.id === loopOpenId);
    expect(open).toBeDefined();
    expect(typeof open?.id).toBe("string");
    expect(typeof open?.emailThreadId).toBe("string");
    expect(typeof open?.summary).toBe("string");
    expect(open?.updatedAt).toBeInstanceOf(Date);
    // optional fields — just check they exist on the shape
    expect("dueAt" in (open ?? {})).toBe(true);
    expect("nextCheckAt" in (open ?? {})).toBe(true);
    expect("lastNudgedAt" in (open ?? {})).toBe(true);
  });

  it("findLoopsForDigest returns no rows for a user with no matching loops", async () => {
    // userId2 has no loops at all
    const digest = await repo.findLoopsForDigest(userId2, NOW);
    expect(digest).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // hasRecentDigest — 23h recency guard
  // ---------------------------------------------------------------------------

  it("hasRecentDigest returns false when no digest has been sent", async () => {
    const recent = await repo.hasRecentDigest(userId, NOW);
    expect(recent).toBe(false);
  });

  it("hasRecentDigest returns true after a digest sent_at within 23h", async () => {
    // Insert a digest nudge sent 1 hour ago (well within 23h).
    const sentAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
    await db.insert(nudges).values({
      userId,
      nudgeType: "digest",
      status: "sent",
      channel: "email",
      body: "Daily digest",
      sentAt,
    });

    const recent = await repo.hasRecentDigest(userId, NOW);
    expect(recent).toBe(true);
  });

  it("hasRecentDigest returns false for a digest sent more than 23h ago", async () => {
    // Clean prior nudge first
    await db.delete(nudges).where(eq(nudges.userId, userId));

    // Insert a digest sent 24h ago (outside the 23h window).
    const sentAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await db.insert(nudges).values({
      userId,
      nudgeType: "digest",
      status: "sent",
      channel: "email",
      body: "Old digest",
      sentAt,
    });

    const recent = await repo.hasRecentDigest(userId, NOW);
    expect(recent).toBe(false);
  });

  it("hasRecentDigest ignores nudge rows of other types (e.g. 'nudge')", async () => {
    // Clean first
    await db.delete(nudges).where(eq(nudges.userId, userId));

    // Insert a 'nudge' type sent 1 hour ago — should NOT make hasRecentDigest true.
    await db.insert(nudges).values({
      userId,
      nudgeType: "nudge",
      status: "sent",
      channel: "email",
      body: "Regular nudge",
      sentAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000),
    });

    const recent = await repo.hasRecentDigest(userId, NOW);
    expect(recent).toBe(false);
  });
});
