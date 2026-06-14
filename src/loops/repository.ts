import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  auditLog,
  entities,
  inboundEmails,
  loopEvents,
  loops,
  nudges,
  sourceEvidence,
  users,
} from "@/db/schema";
import type { LoopStatus } from "@/agent/schemas";
import type { NormalizedEmail, NormalizedEmailAddress, NormalizedAttachment } from "@/email/normalize";
import { linkLoopEntities } from "@/entities/link";
import { loadExtractionContext } from "@/agent/extraction-context";
import { normalizeEmail } from "@/entities/resolve";
import type {
  LoopProcessingRepository,
  LoopToPersist,
  OpenLoopContext,
  PersistedLoop,
  PersistedNudge,
  PrivateReplyNudgeMetadata,
  ProcessableInboundEmail,
} from "@/loops/service";

const commandableStatuses: LoopStatus[] = ["candidate", "open", "snoozed", "waiting_on_me", "waiting_on_other"];

export class DrizzleLoopProcessingRepository implements LoopProcessingRepository {
  private readonly db = getDb();

  async findInboundEmailById(inboundEmailId: string): Promise<ProcessableInboundEmail | null> {
    const [email] = await this.db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.id, inboundEmailId))
      .limit(1);

    if (!email) {
      return null;
    }

    const normalizedPayload = email.normalizedPayload as Partial<NormalizedEmail>;

    return {
      id: email.id,
      userId: email.userId,
      emailThreadId: email.emailThreadId,
      emailMessageId: null,
      normalized: {
        provider: normalizedPayload.provider ?? "postmark",
        providerMessageId: email.providerMessageId,
        mailboxHash: email.mailboxHash ?? normalizedPayload.mailboxHash ?? null,
        from: {
          email: email.senderEmail,
          name: email.senderName,
        },
        to: asAddressList(email.recipients),
        cc: asAddressList(email.ccRecipients),
        subject: email.subject,
        textBody: email.textBody,
        htmlBody: email.htmlBody,
        strippedTextReply: email.strippedTextReply,
        headers: asStringRecord(email.headers),
        attachmentCount: asAttachmentList(email.attachmentMetadata).length,
        attachments: asAttachmentList(email.attachmentMetadata),
        receivedAt: email.providerReceivedAt?.toISOString() ?? null,
      },
    };
  }

  async findLoopsByInboundEmailId(inboundEmailId: string): Promise<PersistedLoop[]> {
    const rows = await this.db
      .select({
        id: loops.id,
        userId: loops.userId,
        emailThreadId: loops.emailThreadId,
        inboundEmailId: loops.inboundEmailId,
        sourceEvidenceId: loops.sourceEvidenceId,
        status: loops.status,
        summary: loops.summary,
        confidence: loops.confidence,
        nextCheckAt: loops.nextCheckAt,
        sourceQuote: sourceEvidence.quote,
      })
      .from(loops)
      .innerJoin(sourceEvidence, eq(loops.sourceEvidenceId, sourceEvidence.id))
      .where(eq(loops.inboundEmailId, inboundEmailId))
      .orderBy(asc(loops.createdAt));

    return rows.map((row) => toPersistedLoop(row, row.sourceQuote));
  }

  async persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    if (input.loops.length === 0) {
      return [];
    }

    // Entity linking (Phase 7 A3) is ENRICHMENT, not part of the commitment itself.
    // It runs AFTER the loop-creation transaction commits, best-effort: a linking error
    // must never roll back (or, via dead-letter replay, halt) capture of the loop. Linking
    // is idempotent (onConflictDoNothing), so the A2 backfill re-links anything skipped here.
    const linkJobs: Array<{ loopId: string; candidate: LoopToPersist }> = [];

    const persisted = await this.db.transaction(async (tx) => {
      const result: PersistedLoop[] = [];

      for (const candidate of input.loops) {
        const [evidence] = await tx
          .insert(sourceEvidence)
          .values({
            userId: input.email.userId,
            inboundEmailId: input.email.id,
            emailMessageId: input.email.emailMessageId,
            providerMessageId: input.email.normalized.providerMessageId,
            quote: candidate.source.quote,
            normalizedBody: input.normalizedBody,
            startOffset: candidate.source.startOffset,
            endOffset: candidate.source.endOffset,
            metadata: {
              ambiguityFlags: candidate.ambiguityFlags,
              participants: candidate.participants,
            },
          })
          .returning({
            id: sourceEvidence.id,
            quote: sourceEvidence.quote,
          });

        const [loop] = await tx
          .insert(loops)
          .values({
            userId: input.email.userId,
            emailThreadId: input.email.emailThreadId,
            inboundEmailId: input.email.id,
            sourceEvidenceId: evidence.id,
            status: candidate.status,
            kind: candidate.kind,
            basis: candidate.basis,
            summary: candidate.summary,
            ownerText: candidate.ownerText,
            requesterText: candidate.requesterText,
            dueDateText: candidate.dueDateText,
            dueAt: parseOptionalDate(candidate.dueAt),
            nextCheckAt: parseOptionalDate(candidate.nextCheckAt),
            confidence: candidate.confidence,
            participants: candidate.participants,
            ambiguityFlags: candidate.ambiguityFlags,
          })
          .returning({
            id: loops.id,
            userId: loops.userId,
            emailThreadId: loops.emailThreadId,
            inboundEmailId: loops.inboundEmailId,
            sourceEvidenceId: loops.sourceEvidenceId,
            status: loops.status,
            summary: loops.summary,
            confidence: loops.confidence,
            nextCheckAt: loops.nextCheckAt,
          });

        await tx.insert(loopEvents).values({
          userId: input.email.userId,
          loopId: loop.id,
          eventType: "created",
          metadata: {
            confidence: candidate.confidence,
            basis: candidate.basis,
          },
        });

        await tx.insert(auditLog).values({
          userId: input.email.userId,
          action: "loop.created",
          actorType: "system",
          metadata: {
            loopId: loop.id,
            inboundEmailId: input.email.id,
            sourceEvidenceId: evidence.id,
          },
        });

        // Defer entity linking until after the tx commits (see linkJobs note above).
        linkJobs.push({ loopId: loop.id, candidate });

        result.push(toPersistedLoop(loop, evidence.quote));
      }

      return result;
    });

    // Post-commit best-effort entity linking. The loops are already durably persisted; any
    // failure here degrades to an unlinked loop (recoverable via the A2 backfill), never a
    // lost commitment. Resolve the user's own email once to skip self-linking.
    if (linkJobs.length > 0) {
      let selfEmail: string | null = null;
      try {
        const [userRow] = await this.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, input.email.userId))
          .limit(1);
        selfEmail = userRow?.email ?? null;
      } catch (err) {
        console.error("[entity-link] selfEmail lookup failed; proceeding without it", err);
      }

      for (const job of linkJobs) {
        try {
          await linkLoopEntities({
            userId: input.email.userId,
            loopId: job.loopId,
            ownerText: job.candidate.ownerText,
            requesterText: job.candidate.requesterText,
            participants: job.candidate.participants,
            sender: input.email.normalized.from,
            selfEmail,
          });
        } catch (err) {
          console.error(`[entity-link] failed for loop ${job.loopId}; left unlinked`, err);
        }
      }
    }

    return persisted;
  }

  async createPrivateReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge> {
    const [nudge] = await this.db
      .insert(nudges)
      .values({
        userId: input.userId,
        inboundEmailId: input.inboundEmailId,
        nudgeType: "private_reply",
        status: "pending",
        channel: "email",
        subject: input.subject,
        body: input.body,
        metadata: input.metadata,
      })
      .returning({
        id: nudges.id,
        userId: nudges.userId,
        inboundEmailId: nudges.inboundEmailId,
        body: nudges.body,
      });

    return {
      id: nudge.id,
      userId: nudge.userId,
      inboundEmailId: nudge.inboundEmailId,
      body: nudge.body,
    };
  }

  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    const [nudge] = await this.db
      .insert(nudges)
      .values({
        userId: input.userId,
        inboundEmailId: input.inboundEmailId,
        nudgeType: "private_reply",
        status: "pending",
        channel: "email",
        subject: input.subject,
        body: input.body,
        metadata: {
          kind: "private_reply",
          intent: input.intent,
          loopCount: 0,
          lowConfidence: false,
          ordinalMap: {},
        } satisfies PrivateReplyNudgeMetadata,
      })
      .returning({
        id: nudges.id,
        userId: nudges.userId,
        inboundEmailId: nudges.inboundEmailId,
        body: nudges.body,
      });

    return {
      id: nudge.id,
      userId: nudge.userId,
      inboundEmailId: nudge.inboundEmailId,
      body: nudge.body,
    };
  }

  async listCommandableLoops(input: { userId: string; emailThreadId?: string | null }): Promise<PersistedLoop[]> {
    const where = input.emailThreadId
      ? and(eq(loops.userId, input.userId), eq(loops.emailThreadId, input.emailThreadId), inArray(loops.status, commandableStatuses))
      : and(eq(loops.userId, input.userId), inArray(loops.status, commandableStatuses));

    const rows = await this.db
      .select({
        id: loops.id,
        userId: loops.userId,
        emailThreadId: loops.emailThreadId,
        inboundEmailId: loops.inboundEmailId,
        sourceEvidenceId: loops.sourceEvidenceId,
        status: loops.status,
        summary: loops.summary,
        confidence: loops.confidence,
        nextCheckAt: loops.nextCheckAt,
        sourceQuote: sourceEvidence.quote,
      })
      .from(loops)
      .innerJoin(sourceEvidence, eq(loops.sourceEvidenceId, sourceEvidence.id))
      .where(where)
      .orderBy(asc(loops.createdAt));

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      emailThreadId: row.emailThreadId,
      inboundEmailId: row.inboundEmailId,
      sourceEvidenceId: row.sourceEvidenceId,
      status: row.status,
      summary: row.summary,
      sourceQuote: row.sourceQuote,
      confidence: row.confidence,
      nextCheckAt: row.nextCheckAt,
    }));
  }

  async updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
    source?: "email_command" | "report_row_action" | "auto_reconcile";
  }): Promise<PersistedLoop> {
    return this.db.transaction(async (tx) => {
      const [loop] = await tx
        .update(loops)
        .set({
          status: input.status,
          nextCheckAt: input.nextCheckAt,
          updatedAt: new Date(),
        })
        .where(and(eq(loops.id, input.loopId), eq(loops.userId, input.userId)))
        .returning({
          id: loops.id,
          userId: loops.userId,
          emailThreadId: loops.emailThreadId,
          inboundEmailId: loops.inboundEmailId,
          sourceEvidenceId: loops.sourceEvidenceId,
          status: loops.status,
          summary: loops.summary,
          confidence: loops.confidence,
          nextCheckAt: loops.nextCheckAt,
        });

      if (!loop) {
        throw new Error(`Loop ${input.loopId} was not found for user ${input.userId}.`);
      }

      const [evidence] = await tx
        .select({ quote: sourceEvidence.quote })
        .from(sourceEvidence)
        .where(eq(sourceEvidence.id, loop.sourceEvidenceId))
        .limit(1);

      await tx.insert(loopEvents).values({
        userId: input.userId,
        loopId: input.loopId,
        eventType: input.eventType,
        commandText: input.commandText,
        metadata: { source: input.source ?? "email_command" },
      });

      await tx.insert(auditLog).values({
        userId: input.userId,
        action: "loop.updated",
        actorType: "user",
        metadata: {
          loopId: input.loopId,
          status: input.status,
          eventType: input.eventType,
        },
      });

      return toPersistedLoop(loop, evidence?.quote ?? "");
    });
  }

  async recordLoopCorrection(input: { userId: string; loopId: string; commandText: string }): Promise<void> {
    await this.db.insert(loopEvents).values({
      userId: input.userId,
      loopId: input.loopId,
      eventType: "corrected",
      commandText: input.commandText,
    });
  }

  async loadOpenLoopContext(input: {
    userId: string;
    threadId: string | null;
    participants: { name: string | null; email: string | null }[];
    queryText: string | null;
  }): Promise<OpenLoopContext> {
    // Reuse B3's retrieval (DB-injected). It already resolves participant
    // entities internally, but does not expose their ids — so we resolve the
    // participant entity ids here (READ-ONLY, same normalization as B3) to feed
    // the structural `sameEntity` check in the decider.
    const context = await loadExtractionContext(
      {
        userId: input.userId,
        threadId: input.threadId,
        participants: input.participants,
        queryText: input.queryText,
      },
      this.db,
    );

    const normalizedEmails = input.participants
      .map((participant) => normalizeEmail(participant.email))
      .filter((email): email is string => email !== null);

    let participantEntityIds: string[] = [];
    if (normalizedEmails.length > 0) {
      const rows = await this.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.userId, input.userId),
            inArray(entities.canonicalEmail, normalizedEmails),
            isNotNull(entities.canonicalEmail),
          ),
        );
      participantEntityIds = rows.map((row) => row.id);
    }

    return { ...context, participantEntityIds };
  }

  async recordReconciliationEvent(input: {
    userId: string;
    loopId: string;
    eventType: "reconciled" | "reconcile_suggested";
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(loopEvents).values({
      userId: input.userId,
      loopId: input.loopId,
      eventType: input.eventType,
      metadata: input.metadata,
    });
  }

  async findUserTimezone(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row?.timezone ?? null;
  }
}

function toPersistedLoop(
  loop: {
    id: string;
    userId: string;
    emailThreadId: string;
    inboundEmailId: string;
    sourceEvidenceId: string;
    status: LoopStatus;
    summary: string;
    confidence: number;
    nextCheckAt: Date | null;
  },
  sourceQuote: string,
): PersistedLoop {
  return {
    id: loop.id,
    userId: loop.userId,
    emailThreadId: loop.emailThreadId,
    inboundEmailId: loop.inboundEmailId,
    sourceEvidenceId: loop.sourceEvidenceId,
    status: loop.status,
    summary: loop.summary,
    sourceQuote,
    confidence: loop.confidence,
    nextCheckAt: loop.nextCheckAt,
  };
}

function parseOptionalDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asAddressList(value: unknown): NormalizedEmailAddress[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const email = typeof record.email === "string" ? record.email : null;

    if (!email) {
      return [];
    }

    return [
      {
        email,
        name: typeof record.name === "string" ? record.name : null,
      },
    ];
  });
}

function asAttachmentList(value: unknown): NormalizedAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    const contentType = typeof record.contentType === "string" ? record.contentType : null;
    const contentLength = typeof record.contentLength === "number" ? record.contentLength : null;

    if (!name || !contentType || contentLength === null) {
      return [];
    }

    return [
      {
        name,
        contentType,
        contentLength,
        contentId: typeof record.contentId === "string" ? record.contentId : null,
      },
    ];
  });
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, recordValue]) =>
      typeof recordValue === "string" ? [[key, recordValue]] : [],
    ),
  );
}
