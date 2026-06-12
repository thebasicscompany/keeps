import { getOptionalEnv } from "@/config/env";
import { DevRecordingSender, type EmailSender } from "@/email/outbound";
import { PostmarkSender } from "@/email/postmark-sender";

/**
 * Selects the outbound email transport for the current environment. When
 * `POSTMARK_SERVER_TOKEN` is configured we send live via Postmark; otherwise we fall
 * back to the Phase 2.5 `DevRecordingSender`, which records into `outbound_emails`
 * without touching a live provider.
 *
 * This is the single entry point for constructing a sender. Workflow and handler code
 * must call `getEmailSender()` rather than importing `PostmarkSender` directly, so the
 * dev/prod selection stays in one place.
 */
export function getEmailSender(): EmailSender {
  const env = getOptionalEnv();

  if (env.POSTMARK_SERVER_TOKEN) {
    return new PostmarkSender({
      serverToken: env.POSTMARK_SERVER_TOKEN,
      fromAddress: env.POSTMARK_FROM_ADDRESS,
      replyToDomain: env.POSTMARK_REPLY_TO_DOMAIN,
      messageStream: env.POSTMARK_MESSAGE_STREAM,
    });
  }

  return new DevRecordingSender();
}
