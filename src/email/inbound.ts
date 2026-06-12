import { normalizeIdentityEmail } from "@/email/address";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";

const pendingRetentionDays = 7;

export type VerifiedEmailUser = {
  id: string;
  email: string;
};

export type StoredPendingInboundEmail = {
  id: string;
  providerMessageId: string;
  duplicate: boolean;
};

export type StoredInboundEmail = {
  id: string;
  userId: string;
  emailThreadId: string;
  emailMessageId: string | null;
  provider: NormalizedEmail["provider"];
  providerMessageId: string;
  subject: string;
  duplicate: boolean;
};

export type PersistInboundEmailInput = {
  normalized: NormalizedEmail;
  rawPayload: unknown;
  providerReceivedAt: Date | null;
};

export type PersistPendingInboundEmailInput = PersistInboundEmailInput & {
  expiresAt: Date;
};

export type InboundEmailRepository = {
  findVerifiedUserByEmail(email: string): Promise<VerifiedEmailUser | null>;
  createPendingInboundEmail(input: PersistPendingInboundEmailInput): Promise<StoredPendingInboundEmail>;
  createInboundEmailForUser(
    input: PersistInboundEmailInput & {
      userId: string;
      threadKey: string;
    },
  ): Promise<StoredInboundEmail>;
  claimPendingInboundEmailsForUser(user: VerifiedEmailUser): Promise<StoredInboundEmail[]>;
};

export type InboundWorkflowEvent =
  | {
      name: "email.sender_unknown";
      data: {
        pendingInboundEmailId: string;
        provider: NormalizedEmail["provider"];
        providerMessageId: string;
        senderEmail: string;
        subject: string;
      };
    }
  | {
      name: "email.sender_verified";
      data: {
        userId: string;
        email: string;
        claimedCount: number;
      };
    }
  | {
      name: "email.received";
      data: {
        inboundEmailId: string;
        emailThreadId: string;
        userId: string;
        provider: NormalizedEmail["provider"];
        providerMessageId: string;
        subject: string;
      };
    };

export type SendInboundWorkflowEvent = (event: InboundWorkflowEvent) => Promise<void>;

export type InboundReply = {
  to: string;
  subject: string;
  text: string;
};

export type InboundCaptureResult =
  | {
      status: "sender_unknown";
      normalized: NormalizedEmail;
      pendingInboundEmailId: string;
      reply: InboundReply;
    }
  | {
      status: "sender_verified";
      normalized: NormalizedEmail;
      inboundEmailId: string;
      emailThreadId: string;
      reply: InboundReply;
    }
  | {
      status: "duplicate";
      normalized: NormalizedEmail;
      providerMessageId: string;
      reply: InboundReply | null;
    };

export async function handlePostmarkInboundEmail(
  payload: unknown,
  options: {
    repository: InboundEmailRepository;
    appUrl: string;
    sendEvent?: SendInboundWorkflowEvent;
    now?: Date;
  },
): Promise<InboundCaptureResult> {
  const now = options.now ?? new Date();
  const normalized = normalizePostmarkInbound(payload);
  const providerReceivedAt = parseOptionalDate(normalized.receivedAt);
  const senderEmail = normalizeIdentityEmail(normalized.from.email);
  const verifiedUser = await options.repository.findVerifiedUserByEmail(senderEmail);

  if (!verifiedUser) {
    const pending = await options.repository.createPendingInboundEmail({
      normalized,
      rawPayload: payload,
      providerReceivedAt,
      expiresAt: addDays(now, pendingRetentionDays),
    });

    if (pending.duplicate) {
      return {
        status: "duplicate",
        normalized,
        providerMessageId: normalized.providerMessageId,
        reply: null,
      };
    }

    await options.sendEvent?.({
      name: "email.sender_unknown",
      data: {
        pendingInboundEmailId: pending.id,
        provider: normalized.provider,
        providerMessageId: normalized.providerMessageId,
        senderEmail,
        subject: normalized.subject,
      },
    });

    return {
      status: "sender_unknown",
      normalized,
      pendingInboundEmailId: pending.id,
      reply: buildUnknownSenderReply(senderEmail, options.appUrl),
    };
  }

  const inbound = await options.repository.createInboundEmailForUser({
    normalized,
    rawPayload: payload,
    providerReceivedAt,
    userId: verifiedUser.id,
    threadKey: buildThreadKey(normalized),
  });

  if (inbound.duplicate) {
    return {
      status: "duplicate",
      normalized,
      providerMessageId: normalized.providerMessageId,
      reply: null,
    };
  }

  await options.sendEvent?.({
    name: "email.received",
    data: {
      inboundEmailId: inbound.id,
      emailThreadId: inbound.emailThreadId,
      userId: inbound.userId,
      provider: normalized.provider,
      providerMessageId: normalized.providerMessageId,
      subject: normalized.subject,
    },
  });

  return {
    status: "sender_verified",
    normalized,
    inboundEmailId: inbound.id,
    emailThreadId: inbound.emailThreadId,
    reply: buildKnownSenderReply(verifiedUser.email),
  };
}

export async function claimHeldInboundEmailsForUser(options: {
  user: VerifiedEmailUser;
  repository: InboundEmailRepository;
  sendEvent?: SendInboundWorkflowEvent;
}): Promise<StoredInboundEmail[]> {
  const claimed = await options.repository.claimPendingInboundEmailsForUser({
    id: options.user.id,
    email: normalizeIdentityEmail(options.user.email),
  });

  if (claimed.length > 0) {
    await options.sendEvent?.({
      name: "email.sender_verified",
      data: {
        userId: options.user.id,
        email: normalizeIdentityEmail(options.user.email),
        claimedCount: claimed.length,
      },
    });
  }

  for (const email of claimed) {
    await options.sendEvent?.({
      name: "email.received",
      data: {
        inboundEmailId: email.id,
        emailThreadId: email.emailThreadId,
        userId: email.userId,
        provider: email.provider,
        providerMessageId: email.providerMessageId,
        subject: email.subject,
      },
    });
  }

  return claimed;
}

export function buildUnknownSenderReply(senderEmail: string, appUrl: string): InboundReply {
  const signupUrl = new URL("/", appUrl);
  signupUrl.searchParams.set("email", senderEmail);

  return {
    to: senderEmail,
    subject: "Activate Keeps for this email",
    text: `I can help track this, but I need to verify this email first.\n\nActivate Keeps for ${senderEmail}: ${signupUrl.toString()}`,
  };
}

export function buildKnownSenderReply(senderEmail: string): InboundReply {
  return {
    to: senderEmail,
    subject: "Keeps saved this thread",
    text: "Got it. I saved this thread privately.\n\nNext, I will look for loops and follow-up points.",
  };
}

export function buildThreadKey(email: NormalizedEmail): string {
  const references = email.headers.references?.split(/\s+/).filter(Boolean);
  const rootReference = references?.[0];
  const inReplyTo = email.headers["in-reply-to"];
  const messageId = email.headers["message-id"];

  return normalizeThreadToken(rootReference ?? inReplyTo ?? messageId ?? email.providerMessageId);
}

function normalizeThreadToken(value: string): string {
  return value.trim().replace(/^<|>$/g, "").toLowerCase();
}

function parseOptionalDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}
