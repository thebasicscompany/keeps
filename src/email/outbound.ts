import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { nudges, outboundEmails } from "@/db/schema";

/**
 * Provider-agnostic outbound email shape. Phase 2.5 only ships the dev recording
 * transport; the live Postmark transport lands in Phase 2.6 behind this same type.
 */
export type OutboundEmail = {
  /** Owning user; recorded on the persisted outbound row. */
  userId: string;
  /** Nudge this send fulfils; flipped to `sent` by recording transports. */
  nudgeId: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  /** Mailbox hash extracted from `replyTo` (e.g. `n_<nudgeId>`), recorded for reply lookup. */
  mailboxHash?: string;
  headers?: Record<string, string>;
};

export type SendResult = { providerMessageId: string };

export interface EmailSender {
  send(email: OutboundEmail): Promise<SendResult>;
}

/**
 * Builds the plus-routed Reply-To mailbox a user reply will be addressed to. Postmark
 * strips the `+...` suffix into `MailboxHash`, which the inbound reply resolver matches
 * against `^n_<uuid>$` to find the exact nudge that listed the loops.
 *
 * `base` is a full email address (`local@domain`); the nudge hash is plus-routed onto its
 * local part, so base `abc123@inbound.postmarkapp.com` yields
 * `abc123+n_<id>@inbound.postmarkapp.com`. This keeps the eventual brand domain a pure env
 * change (`POSTMARK_REPLY_TO_BASE`) — see the generated-inbound pilot decision (2026-06-12).
 */
export function buildNudgeReplyTo(nudgeId: string, base: string): string {
  const atIndex = base.lastIndexOf("@");
  if (atIndex === -1) {
    // Defensive: a base without an "@" is misconfigured; treat the whole thing as the local
    // part so we still produce a syntactically plus-routed address rather than throwing.
    return `${base}+n_${nudgeId}`;
  }
  const local = base.slice(0, atIndex);
  const domain = base.slice(atIndex + 1);
  return `${local}+n_${nudgeId}@${domain}`;
}

/**
 * Parses the `n_<uuid>` mailbox hash out of a plus-routed Reply-To address, if present.
 */
export function parseNudgeMailboxHash(replyTo: string | undefined): string | null {
  if (!replyTo) {
    return null;
  }

  const match = replyTo.match(/\+(n_[0-9a-f-]+)@/i);
  return match ? match[1] : null;
}

/**
 * Persistence port for recording transports. The default implementation is
 * Drizzle-backed (`getDb()`); tests inject an in-memory fake to avoid touching a
 * live Postgres, mirroring the `LoopProcessingRepository` pattern.
 */
export interface OutboundEmailStore {
  recordSend(input: {
    id: string;
    userId: string;
    nudgeId: string;
    provider: string;
    providerMessageId: string;
    toEmail: string;
    subject: string;
    textBody: string;
    headers: Record<string, string>;
    replyTo: string | null;
    inReplyTo: string | null;
    referencesHeader: string | null;
    mailboxHash: string | null;
  }): Promise<void>;
  markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void>;
}

export class DrizzleOutboundEmailStore implements OutboundEmailStore {
  private readonly db = getDb();

  async recordSend(input: {
    id: string;
    userId: string;
    nudgeId: string;
    provider: string;
    providerMessageId: string;
    toEmail: string;
    subject: string;
    textBody: string;
    headers: Record<string, string>;
    replyTo: string | null;
    inReplyTo: string | null;
    referencesHeader: string | null;
    mailboxHash: string | null;
  }): Promise<void> {
    await this.db.insert(outboundEmails).values({
      id: input.id,
      userId: input.userId,
      nudgeId: input.nudgeId,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      toEmail: input.toEmail,
      subject: input.subject,
      textBody: input.textBody,
      headers: input.headers,
      replyTo: input.replyTo,
      inReplyTo: input.inReplyTo,
      referencesHeader: input.referencesHeader,
      mailboxHash: input.mailboxHash,
    });
  }

  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    await this.db
      .update(nudges)
      .set({ status: "sent", sentAt: input.sentAt })
      .where(eq(nudges.id, input.nudgeId));
  }
}

/**
 * Dev transport: persists the full outbound message into `outbound_emails`, transitions
 * the referenced nudge `pending` → `sent`, and returns a synthetic provider message id.
 * No live Postmark traffic. The live transport (Phase 2.6) implements the same
 * `EmailSender` interface.
 */
export class DevRecordingSender implements EmailSender {
  static readonly provider = "dev";

  private readonly store: OutboundEmailStore;
  private readonly now: () => Date;

  constructor(options: { store?: OutboundEmailStore; now?: () => Date } = {}) {
    this.store = options.store ?? new DrizzleOutboundEmailStore();
    this.now = options.now ?? (() => new Date());
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const providerMessageId = `dev-${randomUUID()}@keeps.local`;
    const sentAt = this.now();

    await this.store.recordSend({
      id: randomUUID(),
      userId: email.userId,
      nudgeId: email.nudgeId,
      provider: DevRecordingSender.provider,
      providerMessageId,
      toEmail: email.to,
      subject: email.subject,
      textBody: email.textBody,
      headers: email.headers ?? {},
      replyTo: email.replyTo ?? null,
      inReplyTo: email.inReplyTo ?? null,
      referencesHeader: email.references ?? null,
      mailboxHash: email.mailboxHash ?? parseNudgeMailboxHash(email.replyTo),
    });

    await this.store.markNudgeSent({ nudgeId: email.nudgeId, sentAt });

    return { providerMessageId };
  }
}
