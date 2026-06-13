/**
 * src/data/delete-email.test.ts
 *
 * DB-gated integration tests for deleteEmailForUser.
 *
 * Run only with TEST_DATABASE_URL set:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/data
 *
 * Skipped automatically otherwise.
 *
 * Scenario:
 *   - 2 users (target + bystander), each with a thread + inbound email +
 *     source_evidence + loop + loop_events + nudges.
 *   - Target email has 2 nudges:
 *       nudgeA: references both inboundEmailId AND loopId (of the target email's loop)
 *       nudgeB: references only inboundEmailId (loopId NULL)
 *   - Target email's loop also has:
 *       nudgeC: references ONLY loopId (inboundEmailId NULL) — orphaned by cascade
 *   - Additionally there is nudgeD on the target user that references a DIFFERENT
 *     surviving loop (bystander's loop doesn't apply — so we create a second loop
 *     under the target user but from a different email) — nudgeD must survive.
 *
 * After deleteEmailForUser on the target email:
 *   1. inbound_emails row gone.
 *   2. email_messages, source_evidence, loops, loop_events for target email gone.
 *   3. nudgeA, nudgeB, nudgeC are all orphaned (both cols NULL) → hard-deleted.
 *   4. nudgeD still references a surviving loop → NOT deleted.
 *   5. The bystander's entire tree is untouched.
 *   6. An audit_log row with action='email.deleted_by_user' exists with correct counts.
 *   7. Calling deleteEmailForUser again returns { found: false } (idempotent).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  emailThreads,
  inboundEmails,
  emailMessages,
  sourceEvidence,
  loops,
  loopEvents,
  nudges,
  auditLog,
} from "@/db/schema";
import { deleteEmailForUser } from "@/data/delete-email";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "deleteEmailForUser (DB integration)",
  () => {
    // biome-ignore lint: non-null assertion is safe inside skipIf guard
    const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sql, { schema }) as any;

    // IDs to track for teardown
    let targetUserId: string;
    let bystanderUserId: string;

    // Target email tree
    let targetThreadId: string;
    let targetEmailId: string;
    let targetLoopId: string;
    let targetSeId: string;
    let targetLoopEventId: string;
    let targetEmailMsgId: string;

    // Nudges on the target user
    let nudgeAId: string; // refs inboundEmailId + loopId → orphaned
    let nudgeBId: string; // refs inboundEmailId only → orphaned
    let nudgeCId: string; // refs loopId only → orphaned
    let nudgeDId: string; // refs a SURVIVING loop → must survive

    // A second (surviving) loop for the target user (different email)
    let survivingEmailId: string;
    let survivingLoopId: string;
    let survivingSeId: string;

    // Bystander tree
    let bystanderThreadId: string;
    let bystanderEmailId: string;
    let bystanderLoopId: string;
    let bystanderNudgeId: string;

    beforeAll(async () => {
      // ---------------------------------------------------------------
      // 1. Create users
      // ---------------------------------------------------------------
      const [targetUser] = await db
        .insert(users)
        .values({
          email: `del-test-target-${Date.now()}@test.invalid`,
          timezone: "UTC",
        })
        .returning({ id: users.id });
      targetUserId = targetUser.id;

      const [bystanderUser] = await db
        .insert(users)
        .values({
          email: `del-test-bystander-${Date.now()}@test.invalid`,
          timezone: "UTC",
        })
        .returning({ id: users.id });
      bystanderUserId = bystanderUser.id;

      // ---------------------------------------------------------------
      // 2. Build target user's tree (the email we will delete)
      // ---------------------------------------------------------------
      const [targetThread] = await db
        .insert(emailThreads)
        .values({
          userId: targetUserId,
          threadKey: `target-thread-${Date.now()}`,
          subject: "Target thread",
        })
        .returning({ id: emailThreads.id });
      targetThreadId = targetThread.id;

      const [targetEmail] = await db
        .insert(inboundEmails)
        .values({
          userId: targetUserId,
          emailThreadId: targetThreadId,
          provider: "postmark",
          providerMessageId: `target-msg-${Date.now()}`,
          senderEmail: "sender@example.com",
          subject: "Target email",
          textBody: "Hello",
          normalizedPayload: {},
          rawPayload: {},
        })
        .returning({ id: inboundEmails.id });
      targetEmailId = targetEmail.id;

      const [targetMsg] = await db
        .insert(emailMessages)
        .values({
          userId: targetUserId,
          emailThreadId: targetThreadId,
          inboundEmailId: targetEmailId,
          providerMessageId: `target-msg-em-${Date.now()}`,
          fromEmail: "sender@example.com",
          subject: "Target email",
          textBody: "Hello",
        })
        .returning({ id: emailMessages.id });
      targetEmailMsgId = targetMsg.id;

      const [targetSe] = await db
        .insert(sourceEvidence)
        .values({
          userId: targetUserId,
          inboundEmailId: targetEmailId,
          providerMessageId: `target-msg-${Date.now()}`,
          quote: "I will send the report",
          normalizedBody: "I will send the report",
        })
        .returning({ id: sourceEvidence.id });
      targetSeId = targetSe.id;

      const [targetLoop] = await db
        .insert(loops)
        .values({
          userId: targetUserId,
          emailThreadId: targetThreadId,
          inboundEmailId: targetEmailId,
          sourceEvidenceId: targetSeId,
          summary: "Send the report",
          confidence: 0.9,
        })
        .returning({ id: loops.id });
      targetLoopId = targetLoop.id;

      const [targetLoopEvent] = await db
        .insert(loopEvents)
        .values({
          userId: targetUserId,
          loopId: targetLoopId,
          eventType: "created",
        })
        .returning({ id: loopEvents.id });
      targetLoopEventId = targetLoopEvent.id;

      // ---------------------------------------------------------------
      // 3. Build nudges on the target user
      // ---------------------------------------------------------------
      // nudgeA: references both inboundEmailId AND loopId → becomes fully orphaned
      const [nudgeA] = await db
        .insert(nudges)
        .values({
          userId: targetUserId,
          inboundEmailId: targetEmailId,
          loopId: targetLoopId,
          body: "Nudge A",
        })
        .returning({ id: nudges.id });
      nudgeAId = nudgeA.id;

      // nudgeB: references only inboundEmailId (loopId NULL) → becomes fully orphaned
      const [nudgeB] = await db
        .insert(nudges)
        .values({
          userId: targetUserId,
          inboundEmailId: targetEmailId,
          loopId: null,
          body: "Nudge B",
        })
        .returning({ id: nudges.id });
      nudgeBId = nudgeB.id;

      // nudgeC: references only loopId (inboundEmailId NULL) → becomes fully orphaned
      const [nudgeC] = await db
        .insert(nudges)
        .values({
          userId: targetUserId,
          inboundEmailId: null,
          loopId: targetLoopId,
          body: "Nudge C",
        })
        .returning({ id: nudges.id });
      nudgeCId = nudgeC.id;

      // ---------------------------------------------------------------
      // 4. Build surviving email + loop + nudge for the target user
      // ---------------------------------------------------------------
      const [survivingEmail] = await db
        .insert(inboundEmails)
        .values({
          userId: targetUserId,
          emailThreadId: targetThreadId,
          provider: "postmark",
          providerMessageId: `surviving-msg-${Date.now()}`,
          senderEmail: "other@example.com",
          subject: "Surviving email",
          textBody: "Other",
          normalizedPayload: {},
          rawPayload: {},
        })
        .returning({ id: inboundEmails.id });
      survivingEmailId = survivingEmail.id;

      const [survivingSe] = await db
        .insert(sourceEvidence)
        .values({
          userId: targetUserId,
          inboundEmailId: survivingEmailId,
          providerMessageId: `surviving-msg-${Date.now()}`,
          quote: "Other commitment",
          normalizedBody: "Other commitment",
        })
        .returning({ id: sourceEvidence.id });
      survivingSeId = survivingSe.id;

      const [survivingLoop] = await db
        .insert(loops)
        .values({
          userId: targetUserId,
          emailThreadId: targetThreadId,
          inboundEmailId: survivingEmailId,
          sourceEvidenceId: survivingSeId,
          summary: "Other loop",
          confidence: 0.8,
        })
        .returning({ id: loops.id });
      survivingLoopId = survivingLoop.id;

      // nudgeD: references only survivingLoopId → must NOT be deleted
      const [nudgeD] = await db
        .insert(nudges)
        .values({
          userId: targetUserId,
          inboundEmailId: null,
          loopId: survivingLoopId,
          body: "Nudge D",
        })
        .returning({ id: nudges.id });
      nudgeDId = nudgeD.id;

      // ---------------------------------------------------------------
      // 5. Build bystander's tree
      // ---------------------------------------------------------------
      const [bystanderThread] = await db
        .insert(emailThreads)
        .values({
          userId: bystanderUserId,
          threadKey: `bystander-thread-${Date.now()}`,
          subject: "Bystander thread",
        })
        .returning({ id: emailThreads.id });
      bystanderThreadId = bystanderThread.id;

      const [bystanderEmail] = await db
        .insert(inboundEmails)
        .values({
          userId: bystanderUserId,
          emailThreadId: bystanderThreadId,
          provider: "postmark",
          providerMessageId: `bystander-msg-${Date.now()}`,
          senderEmail: "bystander@example.com",
          subject: "Bystander email",
          textBody: "Bystander",
          normalizedPayload: {},
          rawPayload: {},
        })
        .returning({ id: inboundEmails.id });
      bystanderEmailId = bystanderEmail.id;

      const [bystanderSe] = await db
        .insert(sourceEvidence)
        .values({
          userId: bystanderUserId,
          inboundEmailId: bystanderEmailId,
          providerMessageId: `bystander-msg-${Date.now()}`,
          quote: "Bystander quote",
          normalizedBody: "Bystander quote",
        })
        .returning({ id: sourceEvidence.id });

      const [bystanderLoop] = await db
        .insert(loops)
        .values({
          userId: bystanderUserId,
          emailThreadId: bystanderThreadId,
          inboundEmailId: bystanderEmailId,
          sourceEvidenceId: bystanderSe.id,
          summary: "Bystander loop",
          confidence: 0.7,
        })
        .returning({ id: loops.id });
      bystanderLoopId = bystanderLoop.id;

      const [bystanderNudge] = await db
        .insert(nudges)
        .values({
          userId: bystanderUserId,
          inboundEmailId: bystanderEmailId,
          loopId: bystanderLoopId,
          body: "Bystander nudge",
        })
        .returning({ id: nudges.id });
      bystanderNudgeId = bystanderNudge.id;
    });

    afterAll(async () => {
      // Clean up in FK-safe order (nudges first, then loops, etc.)
      // Cascade from users handles most; we delete users at the end.
      const allUserIds = [targetUserId, bystanderUserId].filter(Boolean);
      if (allUserIds.length > 0) {
        await db.delete(users).where(inArray(users.id, allUserIds));
      }
      await sql.end();
    });

    // ---------------------------------------------------------------
    // Ownership guard: wrong user cannot delete another user's email
    // ---------------------------------------------------------------
    it("returns { found: false } when userId does not own the email", async () => {
      const result = await deleteEmailForUser(
        { userId: bystanderUserId, inboundEmailId: targetEmailId },
        db,
      );
      expect(result).toEqual({ found: false });

      // Target email must still exist.
      const [still] = await db
        .select({ id: inboundEmails.id })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, targetEmailId));
      expect(still).toBeDefined();
    });

    // ---------------------------------------------------------------
    // Core deletion
    // ---------------------------------------------------------------
    it("deletes the target email and cascades, returns correct counts", async () => {
      const result = await deleteEmailForUser(
        { userId: targetUserId, inboundEmailId: targetEmailId },
        db,
      );

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");

      expect(result.deletedLoops).toBe(1);
      expect(result.deletedSourceEvidence).toBe(1);
      expect(result.deletedNudges).toBe(3); // nudgeA + nudgeB + nudgeC
    });

    it("target inbound_email row is gone", async () => {
      const rows = await db
        .select({ id: inboundEmails.id })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, targetEmailId));
      expect(rows).toHaveLength(0);
    });

    it("email_messages cascaded away", async () => {
      const rows = await db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(eq(emailMessages.id, targetEmailMsgId));
      expect(rows).toHaveLength(0);
    });

    it("source_evidence cascaded away", async () => {
      const rows = await db
        .select({ id: sourceEvidence.id })
        .from(sourceEvidence)
        .where(eq(sourceEvidence.id, targetSeId));
      expect(rows).toHaveLength(0);
    });

    it("loop cascaded away", async () => {
      const rows = await db
        .select({ id: loops.id })
        .from(loops)
        .where(eq(loops.id, targetLoopId));
      expect(rows).toHaveLength(0);
    });

    it("loop_event cascaded away", async () => {
      const rows = await db
        .select({ id: loopEvents.id })
        .from(loopEvents)
        .where(eq(loopEvents.id, targetLoopEventId));
      expect(rows).toHaveLength(0);
    });

    it("nudgeA (refs both email + loop) is hard-deleted", async () => {
      const rows = await db
        .select({ id: nudges.id })
        .from(nudges)
        .where(eq(nudges.id, nudgeAId));
      expect(rows).toHaveLength(0);
    });

    it("nudgeB (refs email only) is hard-deleted", async () => {
      const rows = await db
        .select({ id: nudges.id })
        .from(nudges)
        .where(eq(nudges.id, nudgeBId));
      expect(rows).toHaveLength(0);
    });

    it("nudgeC (refs loop only) is hard-deleted", async () => {
      const rows = await db
        .select({ id: nudges.id })
        .from(nudges)
        .where(eq(nudges.id, nudgeCId));
      expect(rows).toHaveLength(0);
    });

    it("nudgeD (refs a surviving loop) is NOT deleted", async () => {
      const rows = await db
        .select({ id: nudges.id, loopId: nudges.loopId })
        .from(nudges)
        .where(eq(nudges.id, nudgeDId));
      expect(rows).toHaveLength(1);
      expect(rows[0].loopId).toBe(survivingLoopId);
    });

    it("surviving email + loop + source_evidence are intact", async () => {
      const emailRows = await db
        .select({ id: inboundEmails.id })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, survivingEmailId));
      expect(emailRows).toHaveLength(1);

      const loopRows = await db
        .select({ id: loops.id })
        .from(loops)
        .where(eq(loops.id, survivingLoopId));
      expect(loopRows).toHaveLength(1);

      const seRows = await db
        .select({ id: sourceEvidence.id })
        .from(sourceEvidence)
        .where(eq(sourceEvidence.id, survivingSeId));
      expect(seRows).toHaveLength(1);
    });

    // ---------------------------------------------------------------
    // Bystander isolation
    // ---------------------------------------------------------------
    it("bystander inbound_email is untouched", async () => {
      const rows = await db
        .select({ id: inboundEmails.id })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, bystanderEmailId));
      expect(rows).toHaveLength(1);
    });

    it("bystander loop is untouched", async () => {
      const rows = await db
        .select({ id: loops.id })
        .from(loops)
        .where(eq(loops.id, bystanderLoopId));
      expect(rows).toHaveLength(1);
    });

    it("bystander nudge is untouched", async () => {
      const rows = await db
        .select({ id: nudges.id })
        .from(nudges)
        .where(eq(nudges.id, bystanderNudgeId));
      expect(rows).toHaveLength(1);
    });

    // ---------------------------------------------------------------
    // Audit log
    // ---------------------------------------------------------------
    it("audit_log row exists with correct action and counts", async () => {
      const rows = await db
        .select({
          action: auditLog.action,
          metadata: auditLog.metadata,
          userId: auditLog.userId,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, targetUserId),
            eq(auditLog.action, "email.deleted_by_user"),
          ),
        );

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows[rows.length - 1]; // latest
      expect(row.action).toBe("email.deleted_by_user");

      const meta = row.metadata as {
        deletedLoops: number;
        deletedSourceEvidence: number;
        deletedNudges: number;
      };
      expect(meta.deletedLoops).toBe(1);
      expect(meta.deletedSourceEvidence).toBe(1);
      expect(meta.deletedNudges).toBe(3);
    });

    // ---------------------------------------------------------------
    // Idempotency
    // ---------------------------------------------------------------
    it("deleting the same email again returns { found: false } (idempotent)", async () => {
      const result = await deleteEmailForUser(
        { userId: targetUserId, inboundEmailId: targetEmailId },
        db,
      );
      expect(result).toEqual({ found: false });
    });
  },
);
