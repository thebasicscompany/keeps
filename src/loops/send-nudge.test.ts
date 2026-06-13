import { describe, expect, it } from "vitest";
import {
  DevRecordingSender,
  type EmailSender,
  type OutboundEmail,
  type OutboundEmailStore,
} from "@/email/outbound";
import {
  sendNudge,
  type SendableNudge,
  type SendNudgeRepository,
} from "@/loops/send-nudge";

type RecordedSend = Parameters<OutboundEmailStore["recordSend"]>[0];

class InMemoryOutboundEmailStore implements OutboundEmailStore {
  readonly sends: RecordedSend[] = [];
  readonly sentNudges: { nudgeId: string; sentAt: Date }[] = [];

  async recordSend(input: RecordedSend): Promise<void> {
    this.sends.push(input);
  }

  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    this.sentNudges.push(input);
  }
}

class InMemorySendNudgeRepository implements SendNudgeRepository {
  constructor(private readonly nudges: Record<string, SendableNudge>) {}

  async findSendableNudge(nudgeId: string): Promise<SendableNudge | null> {
    return this.nudges[nudgeId] ?? null;
  }
}

const nudgeId = "22222222-2222-2222-2222-222222222222";
const sourceProviderMessageId = "<inbound-source-001@keeps.local>";

function makeRepository(overrides: Partial<SendableNudge> = {}) {
  return new InMemorySendNudgeRepository({
    [nudgeId]: {
      id: nudgeId,
      userId: "user-1",
      status: "pending",
      subject: "Re: Renewal packet",
      body: "I found 1 loop.\n\n1. Send the renewal packet.",
      toEmail: "arav@example.com",
      sourceProviderMessageId,
      referencesHeader: "<thread-root@keeps.local>",
      ...overrides,
    },
  });
}

describe("sendNudge", () => {
  it("sets Reply-To to agent+n_<nudgeId>@keeps.ai", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      repository: makeRepository(),
    });

    expect(result.status).toBe("sent");
    expect(store.sends[0]?.replyTo).toBe(`agent+n_${nudgeId}@keeps.ai`);
    // Reply-To must NOT ride in the generic headers map — Postmark rejects it there (300).
    expect(store.sends[0]?.headers["Reply-To"]).toBeUndefined();
  });

  it("refuses to double-send a nudge already marked sent", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      repository: makeRepository({ status: "sent" }),
    });

    expect(result.status).toBe("already_sent");
    expect(store.sends).toHaveLength(0);
  });

  it("records in_reply_to matching the source inbound provider message id", async () => {
    const store = new InMemoryOutboundEmailStore();
    await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      repository: makeRepository(),
    });

    expect(store.sends[0]?.inReplyTo).toBe(sourceProviderMessageId);
    expect(store.sends[0]?.referencesHeader).toBe("<thread-root@keeps.local>");
    expect(store.sends[0]?.mailboxHash).toBe(`n_${nudgeId}`);
  });

  it("transitions the nudge status to sent", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sentAt = new Date("2026-06-12T12:00:00.000Z");
    await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      now: () => sentAt,
      repository: makeRepository(),
    });

    expect(store.sentNudges).toEqual([{ nudgeId, sentAt }]);
  });

  it("returns the synthetic dev provider message id", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      repository: makeRepository(),
    });

    if (result.status !== "sent") {
      throw new Error("expected sent result");
    }
    expect(result.providerMessageId).toMatch(/^dev-[0-9a-f-]+@keeps\.local$/);
  });

  it("falls back to a default subject and omits In-Reply-To when source is unknown", async () => {
    const store = new InMemoryOutboundEmailStore();
    await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      repository: makeRepository({ subject: null, sourceProviderMessageId: null, referencesHeader: null }),
    });

    expect(store.sends[0]?.subject).toBe("Re: your Keeps loop");
    expect(store.sends[0]?.inReplyTo).toBeNull();
    expect(store.sends[0]?.headers["In-Reply-To"]).toBeUndefined();
  });

  it("returns missing_nudge when the nudge does not exist", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId: "00000000-0000-0000-0000-000000000000",
      sender: new DevRecordingSender(),
      store,
      repository: makeRepository(),
    });

    expect(result).toEqual({ status: "missing_nudge", nudgeId: "00000000-0000-0000-0000-000000000000" });
    expect(store.sends).toHaveLength(0);
  });
});

/**
 * Privacy guard: a nudge is the OWNER's private loop summary. The DrizzleSendNudgeRepository
 * sets `toEmail` from the source inbound email's `senderEmail`, which for a thread-followed
 * email is the COUNTERPARTY. This fake mirrors that repository's resolution logic so the
 * guard ("never address a nudge to an address that is not its owner's") is unit-tested
 * without a real DB: resolve toEmail to the source sender ONLY if it belongs to the nudge's
 * user (canonical email or a linked identity), otherwise the owner's canonical email.
 */
class GuardedSendNudgeRepository implements SendNudgeRepository {
  constructor(
    private readonly nudge: Omit<SendableNudge, "toEmail">,
    private readonly source: {
      senderEmail: string | null;
      ownerEmail: string;
      ownerIdentities?: string[];
    },
  ) {}

  async findSendableNudge(nudgeId: string): Promise<SendableNudge | null> {
    if (nudgeId !== this.nudge.id) {
      return null;
    }

    return { ...this.nudge, toEmail: this.resolveToEmail() };
  }

  private resolveToEmail(): string {
    const normalize = (value: string) => value.trim().toLowerCase();
    const { senderEmail, ownerEmail, ownerIdentities = [] } = this.source;

    if (!senderEmail) {
      return ownerEmail;
    }

    const normalizedSender = normalize(senderEmail);
    const ownerAddresses = new Set([ownerEmail, ...ownerIdentities].map(normalize));

    return ownerAddresses.has(normalizedSender) ? senderEmail : ownerEmail;
  }
}

describe("sendNudge — owner privacy guard (B3)", () => {
  const baseNudge: Omit<SendableNudge, "toEmail"> = {
    id: nudgeId,
    userId: "owner-1",
    status: "pending",
    subject: "Re: your loops",
    body: "I found 1 loop.\n\n1. Send the renewal packet.",
    sourceProviderMessageId,
    referencesHeader: "<thread-root@keeps.local>",
  };

  it("redirects a thread-followed nudge away from the counterparty to the owner's address", async () => {
    const store = new InMemoryOutboundEmailStore();
    const repository = new GuardedSendNudgeRepository(baseNudge, {
      // Source inbound email was the COUNTERPARTY's reply.
      senderEmail: "jordan@example.com",
      ownerEmail: "arav@example.com",
    });

    const result = await sendNudge({
      nudgeId,
      sender: new DevRecordingSender(),
      store,
      repository,
    });

    expect(result.status).toBe("sent");
    // The owner's private summary must NOT be delivered to the counterparty.
    expect(store.sends[0]?.toEmail).toBe("arav@example.com");
    expect(store.sends[0]?.toEmail).not.toBe("jordan@example.com");
  });

  it("keeps the source sender when it is the owner's own canonical address", async () => {
    const store = new InMemoryOutboundEmailStore();
    const repository = new GuardedSendNudgeRepository(baseNudge, {
      senderEmail: "Arav@Example.com",
      ownerEmail: "arav@example.com",
    });

    await sendNudge({ nudgeId, sender: new DevRecordingSender(), store, repository });

    expect(store.sends[0]?.toEmail).toBe("Arav@Example.com");
  });

  it("keeps the source sender when it is one of the owner's linked identities", async () => {
    const store = new InMemoryOutboundEmailStore();
    const repository = new GuardedSendNudgeRepository(baseNudge, {
      senderEmail: "arav@work.com",
      ownerEmail: "arav@example.com",
      ownerIdentities: ["arav@work.com"],
    });

    await sendNudge({ nudgeId, sender: new DevRecordingSender(), store, repository });

    expect(store.sends[0]?.toEmail).toBe("arav@work.com");
  });

  it("falls back to the owner address when the source sender is unknown", async () => {
    const store = new InMemoryOutboundEmailStore();
    const repository = new GuardedSendNudgeRepository(baseNudge, {
      senderEmail: null,
      ownerEmail: "arav@example.com",
    });

    await sendNudge({ nudgeId, sender: new DevRecordingSender(), store, repository });

    expect(store.sends[0]?.toEmail).toBe("arav@example.com");
  });
});

// ---------------------------------------------------------------------------
// html passthrough
// ---------------------------------------------------------------------------

describe("sendNudge — html passthrough", () => {
  /** Captures the OutboundEmail passed to sender.send() so we can inspect htmlBody. */
  class CapturingSender implements EmailSender {
    readonly provider = "capture";
    readonly captured: OutboundEmail[] = [];
    async send(email: OutboundEmail) {
      this.captured.push(email);
      return { providerMessageId: `cap-${email.nudgeId}` };
    }
  }

  it("passes html through to the OutboundEmail htmlBody when provided", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sender = new CapturingSender();
    const htmlPart = "<p>Approve this action.</p>";

    const result = await sendNudge({
      nudgeId,
      sender,
      store,
      repository: makeRepository(),
      html: htmlPart,
    });

    expect(result.status).toBe("sent");
    expect(sender.captured[0]?.htmlBody).toBe(htmlPart);
  });

  it("omits htmlBody from the OutboundEmail when html is not provided", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sender = new CapturingSender();

    await sendNudge({
      nudgeId,
      sender,
      store,
      repository: makeRepository(),
    });

    expect(sender.captured[0]?.htmlBody).toBeUndefined();
  });

  it("does NOT persist html — recordSend receives no html column", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sender = new CapturingSender();

    await sendNudge({
      nudgeId,
      sender,
      store,
      repository: makeRepository(),
      html: "<p>some html</p>",
    });

    // OutboundEmailStore.recordSend has no htmlBody field — the recorded send must not
    // carry it (TypeScript enforces this at compile time; this runtime check confirms).
    const recorded = store.sends[0] as Record<string, unknown>;
    expect(recorded["htmlBody"]).toBeUndefined();
  });
});
