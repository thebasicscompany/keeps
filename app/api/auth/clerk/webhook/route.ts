import { NextResponse } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { WebhookEvent } from "@clerk/nextjs/webhooks";
import { upsertClerkUserAndClaimInbound } from "@/auth/clerk-users";
import { syncClerkOrgMembership, removeClerkOrgMembership } from "@/auth/clerk-orgs";
import { isOrgVisibilityEnabled } from "@/config/env";

// Sentry scope tagging — guard so it is harmless without a DSN.
function tagSentryWebhookScope(eventType: string): void {
  if (!process.env.SENTRY_DSN) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/nextjs") as typeof import("@sentry/nextjs");
    Sentry.getCurrentScope().setTag("webhook.provider", "clerk");
    Sentry.getCurrentScope().setTag("webhook.type", eventType);
  } catch {
    // Never let observability tagging break the request path.
  }
}

// The Clerk JSON resource types (UserJSON / EmailAddressJSON) aren't re-exported from the
// webhooks entrypoint, so derive the `user.*` payload + its email shape off the verified
// `WebhookEvent` union instead of importing them.
type UserEvent = Extract<WebhookEvent, { type: "user.created" | "user.updated" }>;
type UserEventData = UserEvent["data"];
type ClerkEmailAddress = UserEventData["email_addresses"][number];

/**
 * Clerk webhook sync (Phase 2.6 B1). Svix-verified via `verifyWebhook()` against
 * `CLERK_WEBHOOK_SIGNING_SECRET`. Runs inline (verify → upsert → claim → 200) so Clerk's
 * at-least-once delivery retries are the durability mechanism — replays must be idempotent,
 * which they are because `upsertClerkUserAndClaimInbound` upserts users/identities and the
 * claim path dedupes on `(provider, providerMessageId)`.
 *
 * Handles:
 *   - `user.created`  → upsert the primary email address (verified per its verification.status).
 *   - `user.updated`  → upsert + claim every email address that is now `verified`.
 *   - everything else → 200 acknowledged, no work.
 */
export async function POST(request: Request) {
  let event: WebhookEvent;

  try {
    // `verifyWebhook` is typed for Next's `RequestLike`; the standard `Request` carries the
    // Svix headers + raw body it actually reads, so the cast is safe.
    event = await verifyWebhook(request as Parameters<typeof verifyWebhook>[0]);
  } catch {
    // Signature mismatch / missing Svix headers — reject. Clerk will not retry a 401 in a
    // loop the way it would a 5xx, which is what we want for a genuinely bad signature.
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  tagSentryWebhookScope(event.type);

  switch (event.type) {
    case "user.created": {
      await handleUserCreated(event.data);
      return NextResponse.json({ handled: "user.created" }, { status: 200 });
    }
    case "user.updated": {
      await handleUserUpdated(event.data);
      return NextResponse.json({ handled: "user.updated" }, { status: 200 });
    }
    case "organizationMembership.created":
    case "organizationMembership.updated": {
      if (isOrgVisibilityEnabled()) await handleOrgMembershipUpserted(event.data as OrgMembershipData);
      return NextResponse.json({ handled: event.type }, { status: 200 });
    }
    case "organizationMembership.deleted": {
      if (isOrgVisibilityEnabled()) await handleOrgMembershipDeleted(event.data as OrgMembershipData);
      return NextResponse.json({ handled: event.type }, { status: 200 });
    }
    default: {
      // Acknowledge but ignore — Clerk only retries on non-2xx, so a 200 stops redelivery.
      return NextResponse.json({ ignored: event.type }, { status: 200 });
    }
  }
}

// Clerk's organization-membership payload (not re-exported from the webhooks entrypoint).
type OrgMembershipData = {
  organization?: { id?: string; name?: string };
  public_user_data?: { user_id?: string };
  role?: string;
};

async function handleOrgMembershipUpserted(data: OrgMembershipData): Promise<void> {
  const clerkOrgId = data.organization?.id;
  const clerkUserId = data.public_user_data?.user_id;
  if (!clerkOrgId || !clerkUserId) return;
  await syncClerkOrgMembership({
    clerkOrgId,
    orgName: data.organization?.name ?? "",
    clerkUserId,
    clerkRole: data.role,
  });
}

async function handleOrgMembershipDeleted(data: OrgMembershipData): Promise<void> {
  const clerkOrgId = data.organization?.id;
  const clerkUserId = data.public_user_data?.user_id;
  if (!clerkOrgId || !clerkUserId) return;
  await removeClerkOrgMembership({ clerkOrgId, clerkUserId });
}

async function handleUserCreated(data: UserEventData): Promise<void> {
  const primary = findPrimaryEmail(data);
  if (!primary) {
    // No primary email on a created user is anomalous but not retryable; ack and move on.
    return;
  }

  await upsertClerkUserAndClaimInbound({
    clerkUserId: data.id,
    email: primary.email_address,
    verified: isVerified(primary),
  });
}

async function handleUserUpdated(data: UserEventData): Promise<void> {
  const verifiedAddresses = data.email_addresses.filter(isVerified);

  // Process sequentially: each verified address upserts its own identity + claims its held
  // inbound email through the helper (which also writes the `auth.clerk_email_verified` audit).
  for (const address of verifiedAddresses) {
    await upsertClerkUserAndClaimInbound({
      clerkUserId: data.id,
      email: address.email_address,
      verified: true,
    });
  }
}

function findPrimaryEmail(data: UserEventData): ClerkEmailAddress | undefined {
  const primaryId = data.primary_email_address_id;
  if (primaryId) {
    const match = data.email_addresses.find((address) => address.id === primaryId);
    if (match) {
      return match;
    }
  }
  // Fallback: if Clerk omits primary_email_address_id, take the first address so a user with a
  // single email still syncs rather than silently dropping.
  return data.email_addresses[0];
}

function isVerified(address: ClerkEmailAddress): boolean {
  return address.verification?.status === "verified";
}
