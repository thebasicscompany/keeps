/**
 * DB-gated integration tests for runRetentionPurge.
 *
 * Requires a live Postgres at TEST_DATABASE_URL (postgres://postgres:postgres@localhost:55433/keeps).
 * Skipped automatically when that env var is absent.
 *
 * Test cases:
 *   (a) Email aged 29 days, retention 30 → NOT scrubbed.
 *   (b) Email aged 31 days, retention 30 → scrubbed inbound + message; loops and
 *       source_evidence rows still present with source_evidence.quote non-empty.
 *   (c) User with rawEmailRetentionDays = NULL → never scrubbed (keep forever).
 *   (d) Already-scrubbed row (scrubbed_at set) → second pass is a no-op (idempotent).
 *   (e) Mixed batch across two users → only the eligible one is scrubbed.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  emailThreads,
  inboundEmails,
  emailMessages,
  sourceEvidence,
  loops,
} from "@/db/schema";
import { runRetentionPurge } from "@/workflows/functions/raw-email-retention-purge";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Reference now for all tests — fixed clock so assertions are deterministic.
const NOW = new Date("2026-06-13T03:00:00Z");

// ---------------------------------------------------------------------------
// Helper: create the minimal row graph for one inbound email
// Returns { userId, threadId, inboundEmailId, emailMessageId, loopId, evidenceId }
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: drizzle db handle from postgres-js
type AnyDb = any;

async function seedInboundEmail(
  db: AnyDb,
  opts: {
    userId: string;
    /** How many days before NOW the email was created */
    ageDays: number;
    /** Quote to store in source_evidence */
    quote?: string;
    /** Override scrubbed_at to simulate an already-scrubbed row */
    scrubbedAt?: Date | null;
  },
) {
  const { userId, ageDays, quote = "I will deliver the report by Friday.", scrubbedAt = null } =
    opts;

  const createdAt = new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000);

  // Thread
  const [thread] = await db
    .insert(emailThreads)
    .values({ id: randomUUID(), userId, threadKey: `thread_${randomUUID()}`, createdAt, updatedAt: createdAt })
    .returning();

  // inbound_emails — set created_at via overrideCreatedAt workaround (insert then update)
  const [inbound] = await db
    .insert(inboundEmails)
    .values({
      id: randomUUID(),
      userId,
      emailThreadId: thread.id,
      provider: "postmark",
      providerMessageId: `pm_${randomUUID()}`,
      senderEmail: `sender_${randomUUID()}@test.invalid`,
      textBody: "Original body text",
      htmlBody: "<p>Original body</p>",
      strippedTextReply: "Original stripped",
      normalizedPayload: { from: "sender@test.invalid" },
      rawPayload: { raw: "original raw payload" },
      headers: { "Message-Id": "<test@postmark>" },
      attachmentMetadata: [],
      scrubbedAt: scrubbedAt ?? null,
    })
    .returning();

  // Update created_at (defaultNow doesn't accept override in drizzle values directly)
  await db.execute(
    sql`UPDATE inbound_emails SET created_at = ${createdAt.toISOString()}::timestamptz WHERE id = ${inbound.id}`,
  );

  // email_messages
  const [message] = await db
    .insert(emailMessages)
    .values({
      id: randomUUID(),
      userId,
      emailThreadId: thread.id,
      inboundEmailId: inbound.id,
      providerMessageId: inbound.providerMessageId,
      fromEmail: `sender_${randomUUID()}@test.invalid`,
      textBody: "Original message text",
      htmlBody: "<p>Original message</p>",
      strippedTextReply: "Original message stripped",
      scrubbedAt: scrubbedAt ?? null,
    })
    .returning();

  // source_evidence — the quote must survive scrubbing
  const [evidence] = await db
    .insert(sourceEvidence)
    .values({
      id: randomUUID(),
      userId,
      inboundEmailId: inbound.id,
      providerMessageId: inbound.providerMessageId,
      quote,
      normalizedBody: "Original body text",
    })
    .returning();

  // loops — must also survive
  const [loop] = await db
    .insert(loops)
    .values({
      id: randomUUID(),
      userId,
      emailThreadId: thread.id,
      inboundEmailId: inbound.id,
      sourceEvidenceId: evidence.id,
      status: "open",
      kind: "commitment",
      basis: "explicit_commitment",
      summary: "Deliver the report by Friday",
      confidence: 0.9,
    })
    .returning();

  return {
    userId,
    threadId: thread.id,
    inboundEmailId: inbound.id,
    emailMessageId: message.id,
    evidenceId: evidence.id,
    loopId: loop.id,
  };
}

async function teardownUser(db: AnyDb, userId: string) {
  // Delete in FK-safe order (children before parents)
  await db.execute(
    sql`DELETE FROM loop_events WHERE user_id = ${userId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM loops WHERE user_id = ${userId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM source_evidence WHERE user_id = ${userId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM email_messages WHERE user_id = ${userId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM inbound_emails WHERE user_id = ${userId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM email_threads WHERE user_id = ${userId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM audit_log WHERE user_id = ${userId}::uuid`,
  );
  await db.delete(users).where(inArray(users.id, [userId]));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)(
  "runRetentionPurge (DB-gated)",
  () => {
    // biome-ignore lint: non-null assertion safe inside skipIf guard
    const pgClient = postgres(TEST_DATABASE_URL!, { prepare: false });
    const db = drizzle(pgClient, { schema });

    // Seed users once; individual test cases seed their own email rows.
    let userWith30DayRetention: string;
    let userWithNullRetention: string;

    beforeAll(async () => {
      const [u1] = await db
        .insert(users)
        .values({
          email: `test-retention-30d-${randomUUID()}@test.invalid`,
          rawEmailRetentionDays: 30,
          timezone: "UTC",
        })
        .returning({ id: users.id });
      userWith30DayRetention = u1.id;

      const [u2] = await db
        .insert(users)
        .values({
          email: `test-retention-null-${randomUUID()}@test.invalid`,
          rawEmailRetentionDays: null,
          timezone: "UTC",
        })
        .returning({ id: users.id });
      userWithNullRetention = u2.id;
    });

    afterAll(async () => {
      await teardownUser(db, userWith30DayRetention);
      await teardownUser(db, userWithNullRetention);
      await pgClient.end();
    });

    // -------------------------------------------------------------------------
    // (a) Email aged 29 days, retention 30 → NOT scrubbed
    // -------------------------------------------------------------------------

    it("(a) email aged 29 days with 30-day retention is NOT scrubbed", async () => {
      const { inboundEmailId, emailMessageId } = await seedInboundEmail(db, {
        userId: userWith30DayRetention,
        ageDays: 29,
      });

      await runRetentionPurge({ now: NOW, db });

      const [inbound] = await db
        .select({ scrubbedAt: inboundEmails.scrubbedAt, textBody: inboundEmails.textBody })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, inboundEmailId));

      expect(inbound.scrubbedAt).toBeNull();
      expect(inbound.textBody).toBe("Original body text");

      const [msg] = await db
        .select({ scrubbedAt: emailMessages.scrubbedAt, textBody: emailMessages.textBody })
        .from(emailMessages)
        .where(eq(emailMessages.id, emailMessageId));

      expect(msg.scrubbedAt).toBeNull();
      expect(msg.textBody).toBe("Original message text");
    });

    // -------------------------------------------------------------------------
    // (b) Email aged 31 days → scrubbed; loops + source_evidence survive with
    //     source_evidence.quote non-empty
    // -------------------------------------------------------------------------

    it("(b) email aged 31 days with 30-day retention is scrubbed, loops + quote survive", async () => {
      const QUOTE = "I will close the deal by end of month.";
      const { inboundEmailId, emailMessageId, evidenceId, loopId } =
        await seedInboundEmail(db, {
          userId: userWith30DayRetention,
          ageDays: 31,
          quote: QUOTE,
        });

      const result = await runRetentionPurge({ now: NOW, db });

      // At least 1 inbound row scrubbed (may be more from case (d) etc.)
      expect(result.scrubbedInboundCount).toBeGreaterThanOrEqual(1);

      // inbound_emails row scrubbed
      const [inbound] = await db
        .select({
          scrubbedAt: inboundEmails.scrubbedAt,
          textBody: inboundEmails.textBody,
          htmlBody: inboundEmails.htmlBody,
          strippedTextReply: inboundEmails.strippedTextReply,
          rawPayload: inboundEmails.rawPayload,
          headers: inboundEmails.headers,
          attachmentMetadata: inboundEmails.attachmentMetadata,
          normalizedPayload: inboundEmails.normalizedPayload,
        })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, inboundEmailId));

      expect(inbound.scrubbedAt).not.toBeNull();
      expect(inbound.textBody).toBe("");
      expect(inbound.htmlBody).toBeNull();
      expect(inbound.strippedTextReply).toBeNull();
      expect(inbound.rawPayload).toEqual({});
      expect(inbound.headers).toEqual({});
      expect(inbound.attachmentMetadata).toEqual([]);
      expect((inbound.normalizedPayload as { scrubbed?: boolean }).scrubbed).toBe(true);

      // email_messages row scrubbed
      const [msg] = await db
        .select({
          scrubbedAt: emailMessages.scrubbedAt,
          textBody: emailMessages.textBody,
          htmlBody: emailMessages.htmlBody,
          strippedTextReply: emailMessages.strippedTextReply,
        })
        .from(emailMessages)
        .where(eq(emailMessages.id, emailMessageId));

      expect(msg.scrubbedAt).not.toBeNull();
      expect(msg.textBody).toBe("");
      expect(msg.htmlBody).toBeNull();
      expect(msg.strippedTextReply).toBeNull();

      // source_evidence row must still exist with quote intact
      const [evidence] = await db
        .select({ quote: sourceEvidence.quote, id: sourceEvidence.id })
        .from(sourceEvidence)
        .where(eq(sourceEvidence.id, evidenceId));

      expect(evidence).toBeDefined();
      expect(evidence.quote).toBe(QUOTE);
      expect(evidence.quote.length).toBeGreaterThan(0);

      // loops row must still exist
      const [loop] = await db
        .select({ id: loops.id, status: loops.status })
        .from(loops)
        .where(eq(loops.id, loopId));

      expect(loop).toBeDefined();
      expect(loop.id).toBe(loopId);
    });

    // -------------------------------------------------------------------------
    // (c) User with rawEmailRetentionDays = NULL → never scrubbed
    // -------------------------------------------------------------------------

    it("(c) user with null retention policy is never scrubbed regardless of age", async () => {
      const { inboundEmailId, emailMessageId } = await seedInboundEmail(db, {
        userId: userWithNullRetention,
        ageDays: 365,
      });

      await runRetentionPurge({ now: NOW, db });

      const [inbound] = await db
        .select({ scrubbedAt: inboundEmails.scrubbedAt, textBody: inboundEmails.textBody })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, inboundEmailId));

      expect(inbound.scrubbedAt).toBeNull();
      expect(inbound.textBody).toBe("Original body text");

      const [msg] = await db
        .select({ scrubbedAt: emailMessages.scrubbedAt })
        .from(emailMessages)
        .where(eq(emailMessages.id, emailMessageId));

      expect(msg.scrubbedAt).toBeNull();
    });

    // -------------------------------------------------------------------------
    // (d) Already-scrubbed row → second pass is a no-op (idempotent)
    // -------------------------------------------------------------------------

    it("(d) already-scrubbed row is not re-scrubbed (idempotent)", async () => {
      const alreadyScrubbed = new Date("2026-06-01T03:00:00Z");

      const { inboundEmailId, emailMessageId } = await seedInboundEmail(db, {
        userId: userWith30DayRetention,
        ageDays: 35,
        scrubbedAt: alreadyScrubbed,
      });

      // Update email_messages to match the already-scrubbed state
      await db.execute(
        sql`UPDATE email_messages SET scrubbed_at = ${alreadyScrubbed.toISOString()}::timestamptz, text_body = '', html_body = NULL WHERE id = ${emailMessageId}::uuid`,
      );

      const result = await runRetentionPurge({ now: NOW, db });

      // The already-scrubbed inbound email should not be re-processed.
      // scrubbed_at must remain the ORIGINAL timestamp, not NOW.
      const [inbound] = await db
        .select({ scrubbedAt: inboundEmails.scrubbedAt })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, inboundEmailId));

      // scrubbed_at should still be the original time (not overwritten to NOW)
      expect(inbound.scrubbedAt?.toISOString()).toBe(alreadyScrubbed.toISOString());
    });

    // -------------------------------------------------------------------------
    // (e) Mixed batch across multiple users → correct subset scrubbed
    // -------------------------------------------------------------------------

    it("(e) mixed batch: only the eligible user's emails are scrubbed", async () => {
      // User A: 30-day retention, email 31 days old → should be scrubbed
      const { inboundEmailId: idA, emailMessageId: msgA } = await seedInboundEmail(db, {
        userId: userWith30DayRetention,
        ageDays: 31,
      });

      // User B: null retention, email 365 days old → should NOT be scrubbed
      const { inboundEmailId: idB, emailMessageId: msgB } = await seedInboundEmail(db, {
        userId: userWithNullRetention,
        ageDays: 365,
      });

      await runRetentionPurge({ now: NOW, db });

      // User A's email was scrubbed
      const [inboundA] = await db
        .select({ scrubbedAt: inboundEmails.scrubbedAt })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, idA));

      expect(inboundA.scrubbedAt).not.toBeNull();

      // User B's email was NOT scrubbed
      const [inboundB] = await db
        .select({ scrubbedAt: inboundEmails.scrubbedAt, textBody: inboundEmails.textBody })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, idB));

      expect(inboundB.scrubbedAt).toBeNull();
      expect(inboundB.textBody).toBe("Original body text");
    });
  },
);
