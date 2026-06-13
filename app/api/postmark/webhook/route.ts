import { NextResponse } from "next/server";
import { getOptionalEnv } from "@/config/env";
import { classifyPostmarkEvent, applyDeliverabilityEvent } from "@/email/deliverability";

/**
 * Postmark bounce / spam-complaint / delivery webhook handler.
 *
 * Authentication mirrors the inbound email route (app/api/email/inbound/route.ts):
 *   - Check header `x-keeps-postmark-webhook-secret` OR Basic auth password.
 *   - Compare against `KEEPS_POSTMARK_WEBHOOK_SECRET`; fall back to
 *     `KEEPS_INBOUND_WEBHOOK_SECRET` if the postmark-specific secret is unset.
 *   - In production: reject with 503 when neither secret is configured.
 *   - On mismatch: reject with 401.
 *
 * On a verified, well-formed payload:
 *   - Bounce       → users.outboundEmailState = 'bounced'   + audit row
 *   - SpamComplaint → users.outboundEmailState = 'complained' + audit row
 *   - Delivery     → 200 no-op (Postmark requires a 200 so it doesn't retry)
 *   - Anything else → 200 no-op
 *
 * Always return 200 for a verified webhook so Postmark stops retrying, even
 * when no matching user is found.
 *
 * @see https://postmarkapp.com/developer/webhooks/bounce-webhook
 * @see https://postmarkapp.com/developer/webhooks/spam-complaint-webhook
 * @see https://postmarkapp.com/developer/webhooks/delivery-webhook
 */

// Mirrors basicAuthPassword from app/api/email/inbound/route.ts
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
  const env = getOptionalEnv();
  const isProd = process.env.NODE_ENV === "production";

  // Determine the active secret: prefer the postmark-specific one; fall back to the
  // inbound webhook secret so operators only need to configure one secret initially.
  const activeSecret = env.KEEPS_POSTMARK_WEBHOOK_SECRET ?? env.KEEPS_INBOUND_WEBHOOK_SECRET;

  if (isProd && !activeSecret) {
    return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 503 });
  }

  if (activeSecret) {
    const provided =
      request.headers.get("x-keeps-postmark-webhook-secret") ?? basicAuthPassword(request);

    if (provided !== activeSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = classifyPostmarkEvent(payload);

  if (event.kind === "delivery" || event.kind === "ignored") {
    // No state change needed. Return 200 so Postmark does not retry.
    return NextResponse.json({ accepted: true, kind: event.kind });
  }

  // bounce or complaint — update user state + write audit row
  if (!env.DATABASE_URL) {
    // Without a DB we cannot persist the suppression, but we must still return 200
    // to prevent Postmark infinite retries. Log and move on.
    console.error(
      "[postmark-webhook] DATABASE_URL not set — cannot persist deliverability event",
      { kind: event.kind, recipient: event.recipient },
    );
    return NextResponse.json({ accepted: true, kind: event.kind, persisted: false });
  }

  const applyResult = await applyDeliverabilityEvent(event);

  return NextResponse.json({
    accepted: true,
    kind: event.kind,
    recipient: event.recipient,
    updated: applyResult.updated,
    ...(applyResult.updated ? { userId: applyResult.userId } : {}),
  });
}
