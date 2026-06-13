/**
 * DB-gated integration tests for scoreDraftFeedback.
 *
 * Requires a live Postgres at TEST_DATABASE_URL (postgres://postgres:postgres@localhost:55433/keeps).
 * Skipped automatically when that env var is absent.
 *
 * Test cases:
 *   (a) All approved → draft_approval_rate = 1.0, draft_edit_rate = 0.0
 *   (b) Mix of approved, rejected (final), and edited (rejected→then approved same draft) →
 *       assert exact rates.
 *   (c) All rejected (final) → draft_approval_rate = 0.0, draft_edit_rate = 0.0
 *   (d) Second run upserts cleanly (no duplicate-key error).
 *   (e) Requests outside 7-day window are excluded.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  drafts,
  approvalRequests,
  qualityMetricsDaily,
} from "@/db/schema";
import { scoreDraftFeedback } from "@/workflows/functions/score-draft-feedback";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Fixed reference clock
const NOW = new Date("2026-06-13T02:05:00Z");
const TODAY_ISO = NOW.toISOString().slice(0, 10);

// biome-ignore lint/suspicious/noExplicitAny: drizzle db handle
type AnyDb = any;

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function seedUser(db: AnyDb): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `draft-test-${randomUUID()}@test.invalid`, timezone: "UTC" })
    .returning({ id: users.id });
  return u.id;
}

async function seedDraft(db: AnyDb, userId: string): Promise<string> {
  const [d] = await db
    .insert(drafts)
    .values({
      id: randomUUID(),
      userId,
      actionKind: "slack_dm",
      payload: { message: "hello" },
    })
    .returning({ id: drafts.id });
  return d.id;
}

/**
 * Insert an approval_request with a specific status and decidedAt.
 */
async function seedApproval(
  db: AnyDb,
  userId: string,
  draftId: string,
  status: "approved" | "rejected",
  decidedAt: Date,
): Promise<string> {
  const id = randomUUID();
  await db.insert(approvalRequests).values({
    id,
    userId,
    draftId,
    actionKind: "slack_dm",
    status,
    tokenHash: `hash-${randomUUID()}`,
    expiresAt: new Date(decidedAt.getTime() + 24 * 60 * 60 * 1000),
    decidedAt,
  });
  return id;
}

async function teardownUser(db: AnyDb, userId: string) {
  await db.execute(sql`DELETE FROM approval_requests WHERE user_id = ${userId}::uuid`);
  await db.execute(sql`DELETE FROM drafts WHERE user_id = ${userId}::uuid`);
  await db.delete(users).where(eq(users.id, userId));
}

async function deleteQmdRows(db: AnyDb, date: string) {
  await db.execute(
    sql`DELETE FROM quality_metrics_daily WHERE date = ${date}::date AND metric IN ('draft_approval_rate', 'draft_edit_rate')`,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)(
  "scoreDraftFeedback (DB-gated)",
  () => {
    // biome-ignore lint: non-null assertion safe inside skipIf guard
    const pgClient = postgres(TEST_DATABASE_URL!, { prepare: false });
    const db = drizzle(pgClient, { schema });

    let userId: string;

    beforeAll(async () => {
      userId = await seedUser(db);
    });

    afterAll(async () => {
      await teardownUser(db, userId);
      await deleteQmdRows(db, TODAY_ISO);
      await pgClient.end();
    });

    // -----------------------------------------------------------------------
    // (a) All approved → rate = 1.0
    // -----------------------------------------------------------------------

    it("(a) all approved → draft_approval_rate=1.0, draft_edit_rate=0.0", async () => {
      await deleteQmdRows(db, TODAY_ISO);
      // Clear any existing approval_requests for this user
      await db.execute(sql`DELETE FROM approval_requests WHERE user_id = ${userId}::uuid`);
      await db.execute(sql`DELETE FROM drafts WHERE user_id = ${userId}::uuid`);

      const decidedAt = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

      const d1 = await seedDraft(db, userId);
      const d2 = await seedDraft(db, userId);
      await seedApproval(db, userId, d1, "approved", decidedAt);
      await seedApproval(db, userId, d2, "approved", decidedAt);

      const result = await scoreDraftFeedback({ now: NOW, db });

      expect(result.draftApprovalRate).toBeCloseTo(1.0, 5);
      // No edited → edit rate = 0 / (2 + 0) = 0
      expect(result.draftEditRate).toBeCloseTo(0.0, 5);
      expect(result.counts.approved).toBe(2);
      expect(result.counts.rejected).toBe(0);
      expect(result.counts.edited).toBe(0);

      // Check QMD rows
      const [approvalRow] = await db
        .select()
        .from(qualityMetricsDaily)
        .where(
          and(
            sql`date = ${TODAY_ISO}::date`,
            eq(qualityMetricsDaily.metric, "draft_approval_rate"),
          ),
        );
      expect(approvalRow.value).toBeCloseTo(1.0, 5);
      expect(approvalRow.denominator).toBe(2);

      const [editRow] = await db
        .select()
        .from(qualityMetricsDaily)
        .where(
          and(
            sql`date = ${TODAY_ISO}::date`,
            eq(qualityMetricsDaily.metric, "draft_edit_rate"),
          ),
        );
      expect(editRow.value).toBeCloseTo(0.0, 5);
      expect(editRow.denominator).toBe(2); // approved + edited = 2 + 0
    });

    // -----------------------------------------------------------------------
    // (b) Mix: approved=2, rejected_final=1, edited=1
    //     → approval_rate = 2/(2+1+1) = 0.5
    //     → edit_rate = 1/(2+1) = 0.333...
    // -----------------------------------------------------------------------

    it("(b) mixed: 2 approved, 1 rejected-final, 1 edited → correct rates", async () => {
      await deleteQmdRows(db, TODAY_ISO);
      await db.execute(sql`DELETE FROM approval_requests WHERE user_id = ${userId}::uuid`);
      await db.execute(sql`DELETE FROM drafts WHERE user_id = ${userId}::uuid`);

      const decidedAt = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);

      // 2 clean approvals
      const d1 = await seedDraft(db, userId);
      const d2 = await seedDraft(db, userId);
      await seedApproval(db, userId, d1, "approved", decidedAt);
      await seedApproval(db, userId, d2, "approved", decidedAt);

      // 1 final rejection (no later approval for this draft)
      const d3 = await seedDraft(db, userId);
      await seedApproval(db, userId, d3, "rejected", decidedAt);

      // 1 "edited" case: rejection followed by approval on same draft
      const d4 = await seedDraft(db, userId);
      await seedApproval(db, userId, d4, "rejected", decidedAt);
      await seedApproval(
        db,
        userId,
        d4,
        "approved",
        new Date(decidedAt.getTime() + 1 * 60 * 60 * 1000),
      );

      const result = await scoreDraftFeedback({ now: NOW, db });

      // approved=3 (d1, d2, d4's second approval), rejected=1 (d3), edited=1 (d4's rejection)
      // Actually: approved count includes ALL 'approved' rows: d1, d2, d4 = 3
      // rejected_final = d3 (d3 has no approved row for same draftId) = 1
      // edited = d4's rejected row (d4 has an approved row) = 1
      expect(result.counts.approved).toBe(3);
      expect(result.counts.rejected).toBe(1);
      expect(result.counts.edited).toBe(1);

      // draft_approval_rate = 3 / (3 + 1 + 1) = 3/5 = 0.6
      expect(result.draftApprovalRate).toBeCloseTo(3 / 5, 5);

      // draft_edit_rate = 1 / (3 + 1) = 1/4 = 0.25
      expect(result.draftEditRate).toBeCloseTo(1 / 4, 5);
    });

    // -----------------------------------------------------------------------
    // (c) All rejected (final) → both rates = 0
    // -----------------------------------------------------------------------

    it("(c) all rejected-final → draft_approval_rate=0, draft_edit_rate=0", async () => {
      await deleteQmdRows(db, TODAY_ISO);
      await db.execute(sql`DELETE FROM approval_requests WHERE user_id = ${userId}::uuid`);
      await db.execute(sql`DELETE FROM drafts WHERE user_id = ${userId}::uuid`);

      const decidedAt = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);

      const d1 = await seedDraft(db, userId);
      const d2 = await seedDraft(db, userId);
      await seedApproval(db, userId, d1, "rejected", decidedAt);
      await seedApproval(db, userId, d2, "rejected", decidedAt);

      const result = await scoreDraftFeedback({ now: NOW, db });

      expect(result.draftApprovalRate).toBeCloseTo(0.0, 5);
      expect(result.draftEditRate).toBeCloseTo(0.0, 5);
      expect(result.counts.approved).toBe(0);
      expect(result.counts.rejected).toBe(2);
      expect(result.counts.edited).toBe(0);
    });

    // -----------------------------------------------------------------------
    // (d) Second run upserts cleanly
    // -----------------------------------------------------------------------

    it("(d) second run upserts without duplicate-key error", async () => {
      await deleteQmdRows(db, TODAY_ISO);
      await db.execute(sql`DELETE FROM approval_requests WHERE user_id = ${userId}::uuid`);
      await db.execute(sql`DELETE FROM drafts WHERE user_id = ${userId}::uuid`);

      const d1 = await seedDraft(db, userId);
      await seedApproval(db, userId, d1, "approved", new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000));

      const result1 = await scoreDraftFeedback({ now: NOW, db });
      // Should not throw:
      const result2 = await scoreDraftFeedback({ now: NOW, db });

      expect(result2.draftApprovalRate).toBe(result1.draftApprovalRate);
      expect(result2.draftEditRate).toBe(result1.draftEditRate);

      // Only one row per metric
      const approvalRows = await db
        .select()
        .from(qualityMetricsDaily)
        .where(
          and(
            sql`date = ${TODAY_ISO}::date`,
            eq(qualityMetricsDaily.metric, "draft_approval_rate"),
          ),
        );
      expect(approvalRows).toHaveLength(1);

      const editRows = await db
        .select()
        .from(qualityMetricsDaily)
        .where(
          and(
            sql`date = ${TODAY_ISO}::date`,
            eq(qualityMetricsDaily.metric, "draft_edit_rate"),
          ),
        );
      expect(editRows).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // (e) Requests outside 7-day window are excluded
    // -----------------------------------------------------------------------

    it("(e) approval_requests older than 7 days are excluded", async () => {
      await deleteQmdRows(db, TODAY_ISO);
      await db.execute(sql`DELETE FROM approval_requests WHERE user_id = ${userId}::uuid`);
      await db.execute(sql`DELETE FROM drafts WHERE user_id = ${userId}::uuid`);

      // Seed one inside the window
      const d1 = await seedDraft(db, userId);
      await seedApproval(db, userId, d1, "approved", new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000));

      // Seed one outside the window (8 days ago)
      const d2 = await seedDraft(db, userId);
      await seedApproval(db, userId, d2, "rejected", new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000));

      const result = await scoreDraftFeedback({ now: NOW, db });

      // Only the in-window approval should count
      expect(result.counts.approved).toBe(1);
      expect(result.counts.rejected).toBe(0);
      expect(result.draftApprovalRate).toBeCloseTo(1.0, 5);
    });
  },
);
