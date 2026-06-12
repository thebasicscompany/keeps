import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getOptionalEnv } from "@/config/env";
import { DrizzleInboundEmailRepository } from "@/email/inbound-repository";
import { handlePostmarkInboundEmail } from "@/email/inbound";
import type { InboundCaptureResult } from "@/email/inbound";
import { sendWorkflowEvent } from "@/workflows/events";

export async function POST(request: Request) {
  const env = getOptionalEnv();

  if (env.KEEPS_INBOUND_WEBHOOK_SECRET) {
    const provided = request.headers.get("x-keeps-webhook-secret");

    if (provided !== env.KEEPS_INBOUND_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
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
