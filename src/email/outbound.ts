import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { nudges, outboundEmails } from "@/db/schema";

/**
 * Provider-agnostic outbound email shape. Phase 2.5 only ships the dev recording
 * transport; the live Postmark transport lands in Phase 2.6 behind this same type.
 *
 * `userId` and `nudgeId` are nullable to support system emails (e.g. activation) that
 * have no owning user row and no nudge. Nudge sends always supply both; system sends pass
 * `null` for both.
 */
export type OutboundEmail = {
  /** Owning user; recorded on the persisted outbound row. Null for system emails. */
  userId: string | null;
  /** Nudge this send fulfils; flipped to `sent` by recording transports. Null for system emails. */
  nudgeId: string | null;
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

/**
 * `skipped` is set by the suppression guard (Phase 6) when a non-active outbound
 * user causes the send to be refused without a network call. Callers must treat a
 * skipped result as "not sent" — do not record an outbound row or flip the nudge to
 * `sent` (the guard already marked the nudge `skipped`).
 */
export type SendResult = { providerMessageId: string; skipped?: boolean };

export interface EmailSender {
  /** Recorded on the persisted outbound row (e.g. "dev", "postmark"). */
  readonly provider: string;
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
    /** Null for system emails (no owning user row). */
    userId: string | null;
    /** Null for system emails (no associated nudge). */
    nudgeId: string | null;
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
    userId: string | null;
    nudgeId: string | null;
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
 * Dev transport: a pure no-network sender that returns a synthetic provider message id.
 * Persistence (outbound row + nudge `pending` → `sent`) is OWNED BY `sendNudge` for every
 * transport — it lived here originally, which meant live Postmark sends were delivered
 * but never recorded (found in the first real send, 2026-06-12).
 */
export class DevRecordingSender implements EmailSender {
  static readonly provider = "dev";
  readonly provider = DevRecordingSender.provider;

  async send(_email: OutboundEmail): Promise<SendResult> {
    return { providerMessageId: `dev-${randomUUID()}@keeps.local` };
  }
}
