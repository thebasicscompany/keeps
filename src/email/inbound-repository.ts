import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  auditLog,
  emailMessages,
  emailThreads,
  inboundEmails,
  pendingInboundEmails,
  userIdentities,
  users,
} from "@/db/schema";
import { normalizeIdentityEmail } from "@/email/address";
import { buildThreadKey } from "@/email/inbound";
import type {
  InboundEmailRepository,
  PersistInboundEmailInput,
  PersistPendingInboundEmailInput,
  StoredInboundEmail,
  StoredPendingInboundEmail,
  VerifiedEmailUser,
} from "@/email/inbound";
import type { NormalizedEmail } from "@/email/normalize";

export class DrizzleInboundEmailRepository implements InboundEmailRepository {
  private readonly db = getDb();

  async findVerifiedUserByEmail(email: string): Promise<VerifiedEmailUser | null> {
    const normalizedEmail = normalizeIdentityEmail(email);

    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, normalizedEmail), eq(users.status, "verified")))
      .limit(1);

    if (user) {
      return user;
    }

    const [identity] = await this.db
      .select({ id: users.id, email: users.email })
      .from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .where(and(eq(userIdentities.email, normalizedEmail), eq(users.status, "verified")))
      .limit(1);

    return identity ?? null;
  }

  async createPendingInboundEmail(
    input: PersistPendingInboundEmailInput,
  ): Promise<StoredPendingInboundEmail> {
    const values = toEmailValues(input);

    const [inserted] = await this.db
      .insert(pendingInboundEmails)
      .values({
        ...values,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({
        target: [pendingInboundEmails.provider, pendingInboundEmails.providerMessageId],
      })
      .returning({
        id: pendingInboundEmails.id,
        providerMessageId: pendingInboundEmails.providerMessageId,
      });

    if (inserted) {
      await this.db.insert(auditLog).values({
        action: "email.inbound.pending_created",
        actorType: "system",
        metadata: {
          provider: input.normalized.provider,
          providerMessageId: input.normalized.providerMessageId,
          senderEmail: input.normalized.from.email,
        },
      });

      return {
        id: inserted.id,
        providerMessageId: inserted.providerMessageId,
        duplicate: false,
      };
    }

    const existing = await this.findPendingByProviderMessage(input.normalized);

    return {
      id: existing?.id ?? input.normalized.providerMessageId,
      providerMessageId: input.normalized.providerMessageId,
      duplicate: true,
    };
  }

  async createInboundEmailForUser(
    input: PersistInboundEmailInput & {
      userId: string;
      threadKey: string;
    },
  ): Promise<StoredInboundEmail> {
    return this.db.transaction(async (tx) => {
      const [thread] = await tx
        .insert(emailThreads)
        .values({
          userId: input.userId,
          threadKey: input.threadKey,
          subject: input.normalized.subject,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [emailThreads.userId, emailThreads.threadKey],
          set: {
            updatedAt: new Date(),
          },
        })
        .returning({ id: emailThreads.id });

      const emailThreadId = thread.id;
      const values = toEmailValues(input);

      const [inbound] = await tx
        .insert(inboundEmails)
        .values({
          ...values,
          userId: input.userId,
          emailThreadId,
        })
        .onConflictDoNothing({
          target: [inboundEmails.provider, inboundEmails.providerMessageId],
        })
        .returning({
          id: inboundEmails.id,
          userId: inboundEmails.userId,
          emailThreadId: inboundEmails.emailThreadId,
          provider: inboundEmails.provider,
          providerMessageId: inboundEmails.providerMessageId,
          subject: inboundEmails.subject,
        });

      if (!inbound) {
        const [existing] = await tx
          .select({
            id: inboundEmails.id,
            userId: inboundEmails.userId,
            emailThreadId: inboundEmails.emailThreadId,
            provider: inboundEmails.provider,
            providerMessageId: inboundEmails.providerMessageId,
            subject: inboundEmails.subject,
          })
          .from(inboundEmails)
          .where(
            and(
              eq(inboundEmails.provider, input.normalized.provider),
              eq(inboundEmails.providerMessageId, input.normalized.providerMessageId),
            ),
          )
          .limit(1);

        return {
          id: existing?.id ?? input.normalized.providerMessageId,
          userId: existing?.userId ?? input.userId,
          emailThreadId: existing?.emailThreadId ?? emailThreadId,
          emailMessageId: null,
          provider: (existing?.provider ?? input.normalized.provider) as NormalizedEmail["provider"],
          providerMessageId: input.normalized.providerMessageId,
          subject: existing?.subject ?? input.normalized.subject,
          duplicate: true,
        };
      }

      const [message] = await tx
        .insert(emailMessages)
        .values({
          userId: input.userId,
          emailThreadId: inbound.emailThreadId,
          inboundEmailId: inbound.id,
          providerMessageId: input.normalized.providerMessageId,
          fromEmail: input.normalized.from.email,
          fromName: input.normalized.from.name,
          toRecipients: input.normalized.to,
          ccRecipients: input.normalized.cc,
          subject: input.normalized.subject,
          textBody: input.normalized.textBody,
          htmlBody: input.normalized.htmlBody,
          strippedTextReply: input.normalized.strippedTextReply,
          sentAt: input.providerReceivedAt,
        })
        .onConflictDoNothing({
          target: emailMessages.inboundEmailId,
        })
        .returning({ id: emailMessages.id });

      await tx.insert(auditLog).values({
        userId: input.userId,
        action: "email.inbound.received",
        actorType: "system",
        metadata: {
          inboundEmailId: inbound.id,
          provider: input.normalized.provider,
          providerMessageId: input.normalized.providerMessageId,
        },
      });

      return {
        id: inbound.id,
        userId: inbound.userId,
        emailThreadId: inbound.emailThreadId,
        emailMessageId: message?.id ?? null,
        provider: inbound.provider as NormalizedEmail["provider"],
        providerMessageId: inbound.providerMessageId,
        subject: inbound.subject,
        duplicate: false,
      };
    });
  }

  async claimPendingInboundEmailsForUser(user: VerifiedEmailUser): Promise<StoredInboundEmail[]> {
    const normalizedEmail = normalizeIdentityEmail(user.email);
    const pendingRows = await this.db
      .select()
      .from(pendingInboundEmails)
      .where(
        and(
          eq(pendingInboundEmails.senderEmail, normalizedEmail),
          eq(pendingInboundEmails.status, "pending"),
          gt(pendingInboundEmails.expiresAt, new Date()),
        ),
      );

    const claimed: StoredInboundEmail[] = [];

    for (const pending of pendingRows) {
      const normalized = pending.normalizedPayload as NormalizedEmail;
      const stored = await this.createInboundEmailForUser({
        normalized,
        rawPayload: pending.rawPayload,
        providerReceivedAt: pending.providerReceivedAt,
        userId: user.id,
        threadKey: buildThreadKey(normalized),
      });

      await this.db
        .update(pendingInboundEmails)
        .set({
          status: "claimed",
          inboundEmailId: stored.id,
          updatedAt: new Date(),
        })
        .where(eq(pendingInboundEmails.id, pending.id));

      await this.db.insert(auditLog).values({
        userId: user.id,
        action: "email.inbound.claimed",
        actorType: "system",
        metadata: {
          pendingInboundEmailId: pending.id,
          inboundEmailId: stored.id,
          providerMessageId: stored.providerMessageId,
        },
      });

      if (!stored.duplicate) {
        claimed.push(stored);
      }
    }

    return claimed;
  }

  private async findPendingByProviderMessage(normalized: NormalizedEmail) {
    const [existing] = await this.db
      .select({ id: pendingInboundEmails.id })
      .from(pendingInboundEmails)
      .where(
        and(
          eq(pendingInboundEmails.provider, normalized.provider),
          eq(pendingInboundEmails.providerMessageId, normalized.providerMessageId),
        ),
      )
      .limit(1);

    return existing ?? null;
  }
}

function toEmailValues(input: PersistInboundEmailInput) {
  return {
    provider: input.normalized.provider,
    providerMessageId: input.normalized.providerMessageId,
    senderEmail: input.normalized.from.email,
    senderName: input.normalized.from.name,
    subject: input.normalized.subject,
    textBody: input.normalized.textBody,
    htmlBody: input.normalized.htmlBody,
    strippedTextReply: input.normalized.strippedTextReply,
    recipients: input.normalized.to,
    ccRecipients: input.normalized.cc,
    headers: input.normalized.headers,
    attachmentMetadata: input.normalized.attachments,
    normalizedPayload: input.normalized,
    rawPayload: input.rawPayload,
    providerReceivedAt: input.providerReceivedAt,
  };
}
