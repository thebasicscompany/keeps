import type { EmailSender, OutboundEmail, SendResult } from "@/email/outbound";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

export type PostmarkSenderConfig = {
  serverToken: string;
  fromAddress: string;
  /**
   * Full reply-to base address (`local@domain`) the plus-routed `local+n_<nudgeId>@domain`
   * Reply-To is built on (AR-3). The caller plus-routes this via `buildNudgeReplyTo` and
   * passes the result as `email.replyTo`; the sender forwards it as-is.
   */
  replyToBase: string;
  messageStream: string;
};

type PostmarkHeader = { Name: string; Value: string };

type PostmarkRequestBody = {
  From: string;
  To: string;
  Subject: string;
  TextBody: string;
  HtmlBody?: string;
  Headers?: PostmarkHeader[];
  ReplyTo?: string;
  MessageStream: string;
};

type PostmarkResponse = {
  ErrorCode?: number;
  Message?: string;
  MessageID?: string;
};

/**
 * Typed failure for non-2xx Postmark responses. Carries Postmark's `ErrorCode` so the
 * caller can classify retryable vs terminal failures (e.g. 406 inactive recipient).
 * @see https://postmarkapp.com/developer/api/overview#error-codes
 */
export class PostmarkSendError extends Error {
  readonly statusCode: number;
  readonly errorCode: number | undefined;

  constructor(message: string, options: { statusCode: number; errorCode?: number }) {
    super(message);
    this.name = "PostmarkSendError";
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
  }
}

/**
 * Live Postmark transport. Implements the Phase 2.5 `EmailSender` interface so workflow
 * code can swap it in behind `getEmailSender()` without changes. Threading headers
 * (`In-Reply-To` / `References`) ride through as Postmark `Headers` entries; the mailbox
 * hash is never a separate field — it lives inside `ReplyTo` (`agent+n_<nudgeId>@<domain>`).
 *
 * Config is injected via the constructor only; this module never reads `process.env`.
 */
export class PostmarkSender implements EmailSender {
  static readonly provider = "postmark";

  private readonly config: PostmarkSenderConfig;

  constructor(config: PostmarkSenderConfig) {
    this.config = config;
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const body = this.buildRequestBody(email);

    const response = await fetch(POSTMARK_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.config.serverToken,
      },
      body: JSON.stringify(body),
    });

    const parsed = (await response.json().catch(() => ({}))) as PostmarkResponse;

    if (!response.ok || (typeof parsed.ErrorCode === "number" && parsed.ErrorCode !== 0)) {
      throw new PostmarkSendError(
        parsed.Message ?? `Postmark send failed with status ${response.status}`,
        { statusCode: response.status, errorCode: parsed.ErrorCode },
      );
    }

    return { providerMessageId: parsed.MessageID ?? "" };
  }

  private buildRequestBody(email: OutboundEmail): PostmarkRequestBody {
    const headers: PostmarkHeader[] = [];

    // Caller-supplied custom headers first (e.g. X-Keeps-Kind), preserving insertion order.
    // Reply-To is forbidden inside Postmark's Headers array (ErrorCode 300) — it only
    // travels via the top-level ReplyTo field. Threading headers are skipped here when
    // their typed fields are set, so callers passing both don't produce duplicates.
    for (const [Name, Value] of Object.entries(email.headers ?? {})) {
      const lower = Name.toLowerCase();
      if (lower === "reply-to") continue;
      if (lower === "in-reply-to" && email.inReplyTo) continue;
      if (lower === "references" && email.references) continue;
      headers.push({ Name, Value });
    }

    // Threading headers are forwarded as Postmark Headers entries (AR-3).
    if (email.inReplyTo) {
      headers.push({ Name: "In-Reply-To", Value: email.inReplyTo });
    }
    if (email.references) {
      headers.push({ Name: "References", Value: email.references });
    }

    const body: PostmarkRequestBody = {
      From: this.config.fromAddress,
      To: email.to,
      Subject: email.subject,
      TextBody: email.textBody,
      MessageStream: this.config.messageStream,
    };

    if (email.htmlBody !== undefined) {
      body.HtmlBody = email.htmlBody;
    }

    // ReplyTo carries the plus-routed nudge mailbox (`agent+n_<nudgeId>@<domain>`) when the
    // caller set it; absent for plain replies with no nudge thread.
    if (email.replyTo) {
      body.ReplyTo = email.replyTo;
    }

    if (headers.length > 0) {
      body.Headers = headers;
    }

    return body;
  }
}
