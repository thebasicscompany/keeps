import { getDb } from "@/db/client";
import { auditLog, userIdentities, users } from "@/db/schema";
import { getOptionalEnv } from "@/config/env";
import { normalizeIdentityEmail } from "@/email/address";
import {
  claimHeldInboundEmailsForUser,
  type InboundEmailRepository,
  type SendInboundWorkflowEvent,
  type StoredInboundEmail,
  type VerifiedEmailUser,
} from "@/email/inbound";
import { DrizzleInboundEmailRepository } from "@/email/inbound-repository";
import { sendWorkflowEvent } from "@/workflows/events";

export type UpsertClerkUserInput = {
  clerkUserId: string;
  email: string;
  verified: boolean;
};

export type UpsertClerkUserResult = {
  user: VerifiedEmailUser;
  claimedEmails: StoredInboundEmail[];
};

/**
 * Dependency seams so the module can be exercised with the in-memory inbound
 * repository fake (and event recorder) without standing up Postgres. Production
 * callers pass nothing and get the Drizzle repository + Inngest dispatch.
 */
export type UpsertClerkUserDeps = {
  db?: ReturnType<typeof getDb>;
  repository?: InboundEmailRepository;
  sendEvent?: SendInboundWorkflowEvent;
  shouldDispatchWorkflow?: boolean;
};

/**
 * Upserts a Clerk-backed user + identity and claims any inbound emails that were
 * held while the sender was unverified. Mirrors the former dev signup flow but:
 *   - writes a `provider='clerk'` identity keyed on the Clerk user id, and
 *   - never processes loops inline — claims always flow through Inngest (AR-1).
 *
 * Signature contract: Wave C imports this exact name + shape.
 */
export async function upsertClerkUserAndClaimInbound(
  { clerkUserId, email, verified }: UpsertClerkUserInput,
  deps: UpsertClerkUserDeps = {},
): Promise<UpsertClerkUserResult> {
  const env = getOptionalEnv();
  const db = deps.db ?? getDb();
  const normalizedEmail = normalizeIdentityEmail(email);
  const now = new Date();
  const status = verified ? "verified" : "pending";

  const [user] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      status,
      verifiedAt: verified ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        status,
        verifiedAt: verified ? now : null,
        updatedAt: now,
      },
    })
    .returning({
      id: users.id,
      email: users.email,
    });

  await db
    .insert(userIdentities)
    .values({
      userId: user.id,
      provider: "clerk",
      providerAccountId: clerkUserId,
      email: normalizedEmail,
      isPrimary: true,
    })
    .onConflictDoUpdate({
      target: [userIdentities.provider, userIdentities.providerAccountId],
      set: {
        email: normalizedEmail,
        isPrimary: true,
      },
    });

  await db.insert(auditLog).values({
    userId: user.id,
    action: "auth.clerk_user_created",
    actorType: "user",
    metadata: {
      clerkUserId,
      email: normalizedEmail,
    },
  });

  if (verified) {
    await db.insert(auditLog).values({
      userId: user.id,
      action: "auth.clerk_email_verified",
      actorType: "user",
      metadata: {
        clerkUserId,
        email: normalizedEmail,
      },
    });
  }

  const repository = deps.repository ?? new DrizzleInboundEmailRepository();
  const shouldDispatchWorkflow =
    deps.shouldDispatchWorkflow ?? Boolean(env.INNGEST_EVENT_KEY || env.INNGEST_DEV);
  const sendEvent = deps.sendEvent ?? sendWorkflowEvent;

  // Only verified addresses can claim held inbound email — an unverified primary
  // address could be spoofed, and the inbound pipeline only matches verified users.
  const claimedEmails = verified
    ? await claimHeldInboundEmailsForUser({
        user,
        repository,
        sendEvent: shouldDispatchWorkflow ? sendEvent : undefined,
      })
    : [];

  return {
    user,
    claimedEmails,
  };
}
