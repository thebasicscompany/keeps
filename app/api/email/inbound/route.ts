import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getOptionalEnv } from "@/config/env";
import { DrizzleInboundEmailRepository } from "@/email/inbound-repository";
import { handlePostmarkInboundEmail } from "@/email/inbound";
import type { InboundCaptureResult } from "@/email/inbound";
import { sendWorkflowEvent } from "@/workflows/events";

// Sentry scope tagging — guard so it is harmless without a DSN.
function tagSentryWebhookScope(provider: string): void {
  if (!process.env.SENTRY_DSN) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/nextjs") as typeof import("@sentry/nextjs");
    Sentry.getCurrentScope().setTag("webhook.provider", provider);
    Sentry.getCurrentScope().setTag("webhook.type", "inbound_email");
  } catch {
    // Never let observability tagging break the request path.
  }
}

const MAX_INBOUND_BODY_BYTES = 10 * 1024 * 1024;

// Postmark inbound cannot send custom headers from every plan/UI, but it does support
// credentials embedded in the webhook URL (https://user:pass@host). The password is
// treated as the shared secret; the username is ignored.
function basicAuthPassword(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return null;

  try {
    const decoded = atob(authorization.slice("Basic ".length));
    const colonIndex = decoded.indexOf(":");
    return colonIndex === -1 ? null : decoded.slice(colonIndex + 1);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  tagSentryWebhookScope("postmark");
  const env = getOptionalEnv();
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && !env.KEEPS_INBOUND_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 503 });
  }

  if (env.KEEPS_INBOUND_WEBHOOK_SECRET) {
    const provided = request.headers.get("x-keeps-webhook-secret") ?? basicAuthPassword(request);

    if (provided !== env.KEEPS_INBOUND_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_INBOUND_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const payload = await request.json();
  if (!env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL is required for inbound email persistence." }, { status: 503 });
  }

  let result: InboundCaptureResult;

  try {
    result = await handlePostmarkInboundEmail(payload, {
      repository: new DrizzleInboundEmailRepository(),
      appUrl: env.NEXT_PUBLIC_APP_URL,
      sendEvent: sendWorkflowEvent,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "invalid_postmark_payload", issues: error.issues }, { status: 400 });
    }

    throw error;
  }

  return NextResponse.json(
    {
      accepted: true,
      status: result.status,
      email: {
        providerMessageId: result.normalized.providerMessageId,
        from: result.normalized.from.email,
        subject: result.normalized.subject,
        attachmentCount: result.normalized.attachmentCount,
      },
      reply: result.reply,
    },
    { status: 202 },
  );
}
