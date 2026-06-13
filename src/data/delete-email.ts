/**
 * src/data/delete-email.ts
 *
 * deleteEmailForUser — per-email deletion with cascade + orphan-nudge cleanup.
 *
 * Transaction flow:
 *   1. Verify row ownership (userId must match; missing row → not-found).
 *   2. Capture loop IDs + nudge candidate IDs BEFORE the cascade fires.
 *   3. DELETE the inbound_emails row — DB cascades to:
 *      email_messages, source_evidence, loops (inboundEmailId cascade),
 *      loop_events (via loops cascade).
 *      nudges: inboundEmailId SET NULL, loopId SET NULL.
 *   4. Hard-delete nudges that are NOW fully orphaned
 *      (inbound_email_id IS NULL AND loop_id IS NULL).
 *      Re-check null condition after cascade so we never delete a nudge that
 *      still points at a surviving loop from a different email.
 *   5. Write audit_log row 'email.deleted_by_user'.
 *
 * Idempotent: deleting an already-deleted email returns { found: false } (not an error).
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  auditLog,
  inboundEmails,
  loops,
  nudges,
  sourceEvidence,
} from "@/db/schema";
import { getDb } from "@/db/client";

type AnyDb = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type DeleteEmailResult =
  | { found: false }
  | {
      found: true;
      deletedLoops: number;
      deletedSourceEvidence: number;
      deletedNudges: number;
    };

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function deleteEmailForUser(
  {
    userId,
    inboundEmailId,
  }: {
    userId: string;
    inboundEmailId: string;
  },
  db: AnyDb = getDb(),
): Promise<DeleteEmailResult> {
  return db.transaction(async (tx) => {
    // -----------------------------------------------------------------------
    // Step 1: Verify ownership
    // -----------------------------------------------------------------------
    const [emailRow] = await tx
      .select({
        id: inboundEmails.id,
        userId: inboundEmails.userId,
        providerMessageId: inboundEmails.providerMessageId,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, inboundEmailId))
      .limit(1);

    if (!emailRow) {
      // Already deleted or never existed — idempotent not-found.
      return { found: false };
    }

    if (emailRow.userId !== userId) {
      // Wrong user — treat as not-found to avoid leaking existence.
      return { found: false };
    }

    // -----------------------------------------------------------------------
    // Step 2: Capture loops + source_evidence + nudge candidates BEFORE cascade.
    // -----------------------------------------------------------------------
    const loopRows = await tx
      .select({ id: loops.id })
      .from(loops)
      .where(eq(loops.inboundEmailId, inboundEmailId));

    const loopIds = loopRows.map((r) => r.id);

    const seRows = await tx
      .select({ id: sourceEvidence.id })
      .from(sourceEvidence)
      .where(eq(sourceEvidence.inboundEmailId, inboundEmailId));

    const deletedSourceEvidenceCount = seRows.length;
    const deletedLoopsCount = loopIds.length;

    // Find nudges that reference this inbound email OR any of its loops.
    // These are the candidates that may become orphaned.
    const nudgesFromEmail = await tx
      .select({ id: nudges.id })
      .from(nudges)
      .where(
        and(
          eq(nudges.userId, userId),
          eq(nudges.inboundEmailId, inboundEmailId),
        ),
      );

    const nudgesFromLoops =
      loopIds.length > 0
        ? await tx
            .select({ id: nudges.id })
            .from(nudges)
            .where(
              and(eq(nudges.userId, userId), inArray(nudges.loopId, loopIds)),
            )
        : [];

    const candidateNudgeIds = Array.from(
      new Set([
        ...nudgesFromEmail.map((r) => r.id),
        ...nudgesFromLoops.map((r) => r.id),
      ]),
    );

    // -----------------------------------------------------------------------
    // Step 3: DELETE the inbound_emails row.
    //   DB cascades to: email_messages, source_evidence, loops, loop_events.
    //   nudges.inboundEmailId → SET NULL; nudges.loopId → SET NULL.
    // -----------------------------------------------------------------------
    await tx.delete(inboundEmails).where(eq(inboundEmails.id, inboundEmailId));

    // -----------------------------------------------------------------------
    // Step 4: Hard-delete nudges that are NOW fully orphaned
    //   (inbound_email_id IS NULL AND loop_id IS NULL).
    //   Re-check post-cascade: a nudge that also pointed at a SURVIVING loop
    //   (from a different email) will have loop_id still set, so it is skipped.
    // -----------------------------------------------------------------------
    let deletedNudgesCount = 0;

    if (candidateNudgeIds.length > 0) {
      const orphanedRows = await tx
        .select({ id: nudges.id })
        .from(nudges)
        .where(
          and(
            inArray(nudges.id, candidateNudgeIds),
            isNull(nudges.inboundEmailId),
            isNull(nudges.loopId),
          ),
        );

      const orphanedIds = orphanedRows.map((r) => r.id);
      deletedNudgesCount = orphanedIds.length;

      if (orphanedIds.length > 0) {
        await tx.delete(nudges).where(inArray(nudges.id, orphanedIds));
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: Audit log
    // -----------------------------------------------------------------------
    await tx.insert(auditLog).values({
      userId,
      action: "email.deleted_by_user",
      actorType: "user",
      metadata: {
        providerMessageId: emailRow.providerMessageId,
        deletedLoops: deletedLoopsCount,
        deletedSourceEvidence: deletedSourceEvidenceCount,
        deletedNudges: deletedNudgesCount,
      },
    });

    return {
      found: true,
      deletedLoops: deletedLoopsCount,
      deletedSourceEvidence: deletedSourceEvidenceCount,
      deletedNudges: deletedNudgesCount,
    };
  });
}
