import { getOptionalEnv } from "@/config/env";
import { DevRecordingSender, type EmailSender } from "@/email/outbound";
import { PostmarkSender } from "@/email/postmark-sender";
import { SuppressionAwareSender } from "@/email/suppression";

/**
 * Selects the outbound email transport for the current environment. When
 * `POSTMARK_SERVER_TOKEN` is configured we send live via Postmark; otherwise we fall
 * back to the Phase 2.5 `DevRecordingSender`, which records into `outbound_emails`
 * without touching a live provider.
 *
 * Every returned sender is wrapped in `SuppressionAwareSender`, which guards against
 * sending to users whose `outboundEmailState` is not `'active'` (bounced / complained /
 * suppressed). This applies to both transports without duplicating the guard.
 *
 * This is the single entry point for constructing a sender. Workflow and handler code
 * must call `getEmailSender()` rather than importing `PostmarkSender` directly, so the
 * dev/prod selection stays in one place.
 */
export function getEmailSender(): EmailSender {
  const env = getOptionalEnv();

  let inner: EmailSender;

  if (env.POSTMARK_SERVER_TOKEN) {
    inner = new PostmarkSender({
      serverToken: env.POSTMARK_SERVER_TOKEN,
      fromAddress: env.POSTMARK_FROM_ADDRESS,
      replyToBase: env.POSTMARK_REPLY_TO_BASE,
      messageStream: env.POSTMARK_MESSAGE_STREAM,
    });
  } else {
    inner = new DevRecordingSender();
  }

  return new SuppressionAwareSender(inner);
}
