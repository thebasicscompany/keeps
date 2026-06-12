import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getOptionalEnv } from "@/config/env";
import { inboundEmails, nudges, userIdentities, users } from "@/db/schema";
import { normalizeIdentityEmail } from "@/email/address";
import { randomUUID } from "node:crypto";
import {
  buildNudgeReplyTo,
  parseNudgeMailboxHash,
  DrizzleOutboundEmailStore,
  type EmailSender,
  type OutboundEmail,
  type OutboundEmailStore,
  type SendResult,
} from "@/email/outbound";

/**
 * Everything `sendNudge` needs about a nudge to turn it into an outbound email: the
 * nudge content, the owning user, the recipient (the original sender), and the source
 * inbound email's provider message id / thread root for Gmail threading.
 */
export type SendableNudge = {
  id: string;
  userId: string;
  /** Lifecycle status — `sendNudge` refuses to double-send a nudge already `sent`. */
  status: string;
  subject: string | null;
  body: string;
  /** Address the reply is sent to — the user who originally wrote in. */
  toEmail: string;
  /** Provider message id of the source inbound email, used as `In-Reply-To`. */
  sourceProviderMessageId: string | null;
  /** Thread-root message id (from the source email headers), used as `References`. */
  referencesHeader: string | null;
};

export interface SendNudgeRepository {
  findSendableNudge(nudgeId: string): Promise<SendableNudge | null>;
}

export interface PendingNudgeFinder {
  /** Ids of nudges for this inbound email still awaiting send (status `pending`). */
  findPendingNudgeIds(inboundEmailId: string): Promise<string[]>;
}

export type SendNudgeResult =
  | { status: "sent"; nudgeId: string; providerMessageId: string; outbound: OutboundEmail }
  | { status: "already_sent"; nudgeId: string }
  | { status: "missing_nudge"; nudgeId: string };

const fallbackSubject = "Re: your Keeps loop";

/**
 * Loads a nudge, builds the `OutboundEmail` (subject, body, plus-routed Reply-To
 * carrying the nudge mailbox hash, `In-Reply-To` from the source inbound email), and
 * sends it through the provided `EmailSender`. The sender is responsible for persisting
 * the outbound row and flipping the nudge to `sent` (see `DevRecordingSender`).
 */
export async function sendNudge(input: {
  nudgeId: string;
  sender: EmailSender;
  repository: SendNudgeRepository;
  /**
   * Full reply-to base address (`local@domain`) the plus-routed nudge mailbox is built on.
   * Defaults to `POSTMARK_REPLY_TO_BASE` so the eventual brand domain is a pure env change.
   */
  replyToBase?: string;
  /** Persistence for the outbound row + nudge status flip; Drizzle-backed by default. */
  store?: OutboundEmailStore;
  now?: () => Date;
}): Promise<SendNudgeResult> {
  const nudge = await input.repository.findSendableNudge(input.nudgeId);

  if (!nudge) {
    return { status: "missing_nudge", nudgeId: input.nudgeId };
  }

  if (nudge.status === "sent") {
    return { status: "already_sent", nudgeId: nudge.id };
  }

  const replyToBase = input.replyToBase ?? getOptionalEnv().POSTMARK_REPLY_TO_BASE;
  const replyTo = buildNudgeReplyTo(nudge.id, replyToBase);
  const outbound: OutboundEmail = {
    userId: nudge.userId,
    nudgeId: nudge.id,
    to: nudge.toEmail,
    subject: nudge.subject ?? fallbackSubject,
    textBody: nudge.body,
    replyTo,
    mailboxHash: `n_${nudge.id}`,
    inReplyTo: nudge.sourceProviderMessageId ?? undefined,
    references: nudge.referencesHeader ?? undefined,
    // Reply-To / In-Reply-To / References travel via their typed fields above; senders
    // own the mapping (Postmark rejects Reply-To inside its Headers array, error 300).
    headers: {},
  };

  const result: SendResult = await input.sender.send(outbound);

  // Persistence is sender-agnostic and lives here: record the outbound row and flip the
  // nudge to `sent` whatever the transport. (When it lived inside DevRecordingSender,
  // live Postmark sends were delivered but never recorded — first real send, 2026-06-12.)
  const store = input.store ?? new DrizzleOutboundEmailStore();
  const sentAt = (input.now ?? (() => new Date()))();

  await store.recordSend({
    id: randomUUID(),
    userId: outbound.userId,
    nudgeId: outbound.nudgeId,
    provider: input.sender.provider,
    providerMessageId: result.providerMessageId,
    toEmail: outbound.to,
    subject: outbound.subject,
    textBody: outbound.textBody,
    headers: outbound.headers ?? {},
    replyTo: outbound.replyTo ?? null,
    inReplyTo: outbound.inReplyTo ?? null,
    referencesHeader: outbound.references ?? null,
    mailboxHash: outbound.mailboxHash ?? parseNudgeMailboxHash(outbound.replyTo),
  });
  await store.markNudgeSent({ nudgeId: nudge.id, sentAt });

  return {
    status: "sent",
    nudgeId: nudge.id,
    providerMessageId: result.providerMessageId,
    outbound,
  };
}

/**
 * Drizzle-backed repository: joins the nudge to its source inbound email to recover the
 * recipient address and the provider message id that seeds `In-Reply-To`.
 */
export class DrizzleSendNudgeRepository implements SendNudgeRepository, PendingNudgeFinder {
  private readonly db = getDb();

  async findPendingNudgeIds(inboundEmailId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: nudges.id })
      .from(nudges)
      .where(and(eq(nudges.inboundEmailId, inboundEmailId), eq(nudges.status, "pending")));

    return rows.map((row) => row.id);
  }

  async findSendableNudge(nudgeId: string): Promise<SendableNudge | null> {
    const [row] = await this.db
      .select({
        id: nudges.id,
        userId: nudges.userId,
        status: nudges.status,
        subject: nudges.subject,
        body: nudges.body,
        inboundEmailId: nudges.inboundEmailId,
        sourceProviderMessageId: inboundEmails.providerMessageId,
        senderEmail: inboundEmails.senderEmail,
        headers: inboundEmails.headers,
      })
      .from(nudges)
      .leftJoin(inboundEmails, eq(nudges.inboundEmailId, inboundEmails.id))
      .where(eq(nudges.id, nudgeId))
      .limit(1);

    if (!row) {
      return null;
    }

    // Privacy guard: the nudge body is the OWNER's private loop summary and must only ever
    // reach the owner. For a thread-followed inbound email the source `senderEmail` is the
    // COUNTERPARTY, not the owner — sending there would leak the owner's loops. So we only
    // reply to the source sender if that address provably belongs to the nudge's user
    // (users.email or a verified user_identities.email). Otherwise we fall back to the
    // owner's canonical users.email.
    const toEmail = await this.resolveOwnerSafeRecipient(row.userId, row.senderEmail);

    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      subject: row.subject,
      body: row.body,
      toEmail,
      sourceProviderMessageId: row.sourceProviderMessageId ?? null,
      referencesHeader: readReferencesHeader(row.headers),
    };
  }

  /**
   * Returns an address the nudge can safely be sent to. If `sourceSenderEmail` belongs to
   * `userId` (canonical email or a linked identity), it is used unchanged. Otherwise the
   * owner's canonical `users.email` is returned. A nudge is NEVER addressed to an address
   * that is not its owner's.
   */
  private async resolveOwnerSafeRecipient(
    userId: string,
    sourceSenderEmail: string | null,
  ): Promise<string> {
    const [owner] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const ownerEmail = owner?.email ?? "";

    if (!sourceSenderEmail) {
      return ownerEmail;
    }

    const normalizedSender = normalizeIdentityEmail(sourceSenderEmail);

    if (normalizeIdentityEmail(ownerEmail) === normalizedSender) {
      return sourceSenderEmail;
    }

    const [identity] = await this.db
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(
        and(eq(userIdentities.userId, userId), eq(userIdentities.email, normalizedSender)),
      )
      .limit(1);

    return identity ? sourceSenderEmail : ownerEmail;
  }
}

function readReferencesHeader(headers: unknown): string | null {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }

  const record = headers as Record<string, unknown>;
  const value = record.references ?? record.References ?? record["message-id"] ?? record["Message-ID"];
  return typeof value === "string" && value.length > 0 ? value : null;
}
