import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getOptionalEnv } from "@/config/env";
import { inboundEmails, nudges } from "@/db/schema";
import { buildNudgeReplyTo, type EmailSender, type OutboundEmail, type SendResult } from "@/email/outbound";

/**
 * Everything `sendNudge` needs about a nudge to turn it into an outbound email: the
 * nudge content, the owning user, the recipient (the original sender), and the source
 * inbound email's provider message id / thread root for Gmail threading.
 */
export type SendableNudge = {
  id: string;
  userId: string;
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

export type SendNudgeResult =
  | { status: "sent"; nudgeId: string; providerMessageId: string; outbound: OutboundEmail }
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
}): Promise<SendNudgeResult> {
  const nudge = await input.repository.findSendableNudge(input.nudgeId);

  if (!nudge) {
    return { status: "missing_nudge", nudgeId: input.nudgeId };
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
export class DrizzleSendNudgeRepository implements SendNudgeRepository {
  private readonly db = getDb();

  async findSendableNudge(nudgeId: string): Promise<SendableNudge | null> {
    const [row] = await this.db
      .select({
        id: nudges.id,
        userId: nudges.userId,
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

    return {
      id: row.id,
      userId: row.userId,
      subject: row.subject,
      body: row.body,
      toEmail: row.senderEmail ?? "",
      sourceProviderMessageId: row.sourceProviderMessageId ?? null,
      referencesHeader: readReferencesHeader(row.headers),
    };
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
