import { getDb } from "@/db/client";
import { auditLog, userIdentities, users } from "@/db/schema";
import { getOptionalEnv } from "@/config/env";
import { normalizeIdentityEmail } from "@/email/address";
import { claimHeldInboundEmailsForUser, type StoredInboundEmail, type VerifiedEmailUser } from "@/email/inbound";
import { DrizzleInboundEmailRepository } from "@/email/inbound-repository";
import { DrizzleLoopProcessingRepository } from "@/loops/repository";
import { processInboundEmailForLoops } from "@/loops/service";
import { sendWorkflowEvent } from "@/workflows/events";

export type VerifiedDevUserResult = {
  user: VerifiedEmailUser;
  claimedEmails: StoredInboundEmail[];
};

export async function verifyDevUserAndClaimInbound(email: string): Promise<VerifiedDevUserResult> {
  const env = getOptionalEnv();
  const db = getDb();
  const normalizedEmail = normalizeIdentityEmail(email);
  const now = new Date();

  const [user] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      status: "verified",
      verifiedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        status: "verified",
        verifiedAt: now,
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
      provider: "dev_email",
      providerAccountId: normalizedEmail,
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
    action: "auth.dev_session_created",
    actorType: "user",
    metadata: {
      email: normalizedEmail,
    },
  });

  await db.insert(auditLog).values({
    userId: user.id,
    action: "user.email_verified",
    actorType: "user",
    metadata: {
      provider: "dev_email",
    },
  });

  const repository = new DrizzleInboundEmailRepository();
  const shouldDispatchWorkflow = Boolean(env.INNGEST_EVENT_KEY || env.INNGEST_DEV);
  const claimedEmails = await claimHeldInboundEmailsForUser({
    user,
    repository,
    sendEvent: shouldDispatchWorkflow ? sendWorkflowEvent : undefined,
  });

  if (!shouldDispatchWorkflow) {
    const loopRepository = new DrizzleLoopProcessingRepository();

    for (const email of claimedEmails) {
      await processInboundEmailForLoops({
        inboundEmailId: email.id,
        repository: loopRepository,
        useModel: false,
      });
    }
  }

  return {
    user,
    claimedEmails,
  };
}
