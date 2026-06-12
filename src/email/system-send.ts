import { randomUUID } from "node:crypto";
import {
  DrizzleOutboundEmailStore,
  type EmailSender,
  type OutboundEmail,
  type OutboundEmailStore,
  type SendResult,
} from "@/email/outbound";

/**
 * Sends a system (non-nudge) email — e.g. an activation email to an unknown sender who
 * has no user row and no nudge. Mirrors `sendNudge`'s structure and persistence contract.
 *
 * Key differences from nudge sends:
 * - `userId` and `nudgeId` are always `null` on the persisted outbound row.
 * - No `replyTo` is set: replies flow naturally to our From address, which is the inbound
 *   webhook — no plus-routing or mailbox hash needed.
 * - `Auto-Submitted: auto-replied` is set per RFC 3834 so that other mail systems never
 *   auto-respond to our auto-replies and we never enter a mail loop.
 * - `markNudgeSent` is never called — there is no nudge to flip.
 */
export async function sendSystemEmail(input: {
  email: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    inReplyTo?: string;
    references?: string;
  };
  sender: EmailSender;
  /** Persistence for the outbound row; Drizzle-backed by default. */
  store?: OutboundEmailStore;
  now?: () => Date;
}): Promise<{ providerMessageId: string }> {
  const outbound: OutboundEmail = {
    userId: null,
    nudgeId: null,
    to: input.email.to,
    subject: input.email.subject,
    textBody: input.email.textBody,
    htmlBody: input.email.htmlBody,
    inReplyTo: input.email.inReplyTo,
    references: input.email.references,
    // Reply-To is intentionally absent: replies route to our From address (the inbound
    // webhook), which is the correct destination for activation-email replies.
    // Auto-Submitted declares this as a machine-generated message (RFC 3834) so other
    // mail systems never auto-reply to us and we never create a mail loop.
    headers: { "Auto-Submitted": "auto-replied" },
  };

  const result: SendResult = await input.sender.send(outbound);

  // Persistence lives here (not inside the sender) for the same reason as sendNudge:
  // keeping it transport-agnostic ensures live sends are always recorded.
  const store = input.store ?? new DrizzleOutboundEmailStore();

  await store.recordSend({
    id: randomUUID(),
    userId: null,
    nudgeId: null,
    provider: input.sender.provider,
    providerMessageId: result.providerMessageId,
    toEmail: outbound.to,
    subject: outbound.subject,
    textBody: outbound.textBody,
    headers: outbound.headers ?? {},
    replyTo: null,
    inReplyTo: outbound.inReplyTo ?? null,
    referencesHeader: outbound.references ?? null,
    mailboxHash: null,
  });

  return { providerMessageId: result.providerMessageId };
}
