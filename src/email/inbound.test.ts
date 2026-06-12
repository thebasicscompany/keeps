import { describe, expect, it } from "vitest";
import {
  claimHeldInboundEmailsForUser,
  handlePostmarkInboundEmail,
  type InboundEmailRepository,
  type InboundWorkflowEvent,
  type PersistInboundEmailInput,
  type PersistPendingInboundEmailInput,
  type StoredInboundEmail,
  type StoredPendingInboundEmail,
  type VerifiedEmailUser,
} from "@/email/inbound";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import {
  bccLikePostmarkFixture,
  directPostmarkFixture,
  forwardLikePostmarkFixture,
  nudgeReplyPostmarkFixture,
} from "@/email/fixtures/postmark";

describe("normalizePostmarkInbound", () => {
  it("preserves forwarded context while keeping stripped reply separately", () => {
    const normalized = normalizePostmarkInbound(forwardLikePostmarkFixture);

    expect(normalized.textBody).toContain("---------- Forwarded message ---------");
    expect(normalized.textBody).toContain("send the renewal packet by Tuesday");
    expect(normalized.strippedTextReply).toBe("Can you keep this from slipping?");
  });
});

describe("handlePostmarkInboundEmail", () => {
  it("stores a BCC-like email for a verified sender and enqueues email.received", async () => {
    const repository = new InMemoryInboundRepository();
    repository.addVerifiedUser({ id: "user-1", email: "arav@example.com" });
    const events: InboundWorkflowEvent[] = [];

    const result = await handlePostmarkInboundEmail(bccLikePostmarkFixture, {
      repository,
      appUrl: "http://localhost:3000",
      sendEvent: async (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe("sender_verified");
    expect(repository.inboundCount()).toBe(1);
    expect(repository.pendingCount()).toBe(0);
    expect(events).toMatchObject([
      {
        name: "email.received",
        data: {
          providerMessageId: "postmark-bcc-001",
          userId: "user-1",
        },
      },
    ]);
  });

  it("stores a direct email for a verified sender", async () => {
    const repository = new InMemoryInboundRepository();
    repository.addVerifiedUser({ id: "user-1", email: "arav@example.com" });

    const result = await handlePostmarkInboundEmail(directPostmarkFixture, {
      repository,
      appUrl: "http://localhost:3000",
    });

    expect(result.status).toBe("sender_verified");
    expect(repository.inboundCount()).toBe(1);
    expect(repository.inboundSubjects()).toEqual(["Follow up on launch blockers"]);
  });

  it("normalizes the MailboxHash to null when absent", () => {
    const normalized = normalizePostmarkInbound(directPostmarkFixture);

    expect(normalized.mailboxHash).toBeNull();
  });

  it("flows MailboxHash through NormalizedEmail onto the inbound_emails row", async () => {
    const normalized = normalizePostmarkInbound(nudgeReplyPostmarkFixture);
    expect(normalized.mailboxHash).toBe("n_00000000-0000-0000-0000-000000000001");

    const repository = new InMemoryInboundRepository();
    repository.addVerifiedUser({ id: "user-1", email: "arav@example.com" });

    const result = await handlePostmarkInboundEmail(nudgeReplyPostmarkFixture, {
      repository,
      appUrl: "http://localhost:3000",
    });

    expect(result.status).toBe("sender_verified");
    expect(repository.inboundCount()).toBe(1);
    expect(repository.inboundMailboxHashes()).toEqual([
      "n_00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("dedupes duplicate provider webhook deliveries", async () => {
    const repository = new InMemoryInboundRepository();
    repository.addVerifiedUser({ id: "user-1", email: "arav@example.com" });
    const events: InboundWorkflowEvent[] = [];
    const options = {
      repository,
      appUrl: "http://localhost:3000",
      sendEvent: async (event: InboundWorkflowEvent) => {
        events.push(event);
      },
    };

    const first = await handlePostmarkInboundEmail(directPostmarkFixture, options);
    const duplicate = await handlePostmarkInboundEmail(directPostmarkFixture, options);

    expect(first.status).toBe("sender_verified");
    expect(duplicate.status).toBe("duplicate");
    expect(repository.inboundCount()).toBe(1);
    expect(events.filter((event) => event.name === "email.received")).toHaveLength(1);
  });

  it("holds unknown sender emails and returns a signup response path", async () => {
    const repository = new InMemoryInboundRepository();
    const events: InboundWorkflowEvent[] = [];

    const result = await handlePostmarkInboundEmail(directPostmarkFixture, {
      repository,
      appUrl: "http://localhost:3000",
      sendEvent: async (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe("sender_unknown");
    if (result.status !== "sender_unknown") {
      throw new Error("expected unknown sender result");
    }
    expect(repository.pendingCount()).toBe(1);
    expect(repository.inboundCount()).toBe(0);
    expect(result.reply.text).toContain("Activate Keeps for arav@example.com");
    expect(result.reply.text).toContain("http://localhost:3000/?email=arav%40example.com");
    expect(events).toMatchObject([
      {
        name: "email.sender_unknown",
        data: {
          senderEmail: "arav@example.com",
          providerMessageId: "postmark-direct-001",
        },
      },
    ]);
  });

  it("claims held emails after signup and associates them with the verified user", async () => {
    const repository = new InMemoryInboundRepository();
    const events: InboundWorkflowEvent[] = [];

    await handlePostmarkInboundEmail(forwardLikePostmarkFixture, {
      repository,
      appUrl: "http://localhost:3000",
    });

    const user = { id: "user-1", email: "arav@example.com" };
    repository.addVerifiedUser(user);

    const claimed = await claimHeldInboundEmailsForUser({
      user,
      repository,
      sendEvent: async (event) => {
        events.push(event);
      },
    });

    expect(claimed).toHaveLength(1);
    expect(repository.pendingCount()).toBe(0);
    expect(repository.inboundCount()).toBe(1);
    expect(repository.inboundSubjects()).toEqual(["Fwd: Partner renewal"]);
    expect(events.map((event) => event.name)).toEqual(["email.sender_verified", "email.received"]);
  });
});

type PendingRecord = PersistPendingInboundEmailInput & {
  id: string;
  status: "pending" | "claimed";
};

class InMemoryInboundRepository implements InboundEmailRepository {
  private readonly verifiedUsers = new Map<string, VerifiedEmailUser>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly inbound = new Map<string, StoredInboundEmail & { normalized: NormalizedEmail }>();
  private nextId = 1;

  addVerifiedUser(user: VerifiedEmailUser) {
    this.verifiedUsers.set(user.email.toLowerCase(), user);
  }

  inboundCount() {
    return this.inbound.size;
  }

  pendingCount() {
    return [...this.pending.values()].filter((record) => record.status === "pending").length;
  }

  inboundSubjects() {
    return [...this.inbound.values()].map((record) => record.subject);
  }

  inboundMailboxHashes() {
    return [...this.inbound.values()].map((record) => record.normalized.mailboxHash);
  }

  async findVerifiedUserByEmail(email: string): Promise<VerifiedEmailUser | null> {
    return this.verifiedUsers.get(email.toLowerCase()) ?? null;
  }

  async createPendingInboundEmail(
    input: PersistPendingInboundEmailInput,
  ): Promise<StoredPendingInboundEmail> {
    const key = providerKey(input.normalized);
    const existing = this.pending.get(key);

    if (existing) {
      return {
        id: existing.id,
        providerMessageId: input.normalized.providerMessageId,
        duplicate: true,
      };
    }

    const id = this.allocateId("pending");
    this.pending.set(key, {
      ...input,
      id,
      status: "pending",
    });

    return {
      id,
      providerMessageId: input.normalized.providerMessageId,
      duplicate: false,
    };
  }

  async createInboundEmailForUser(
    input: PersistInboundEmailInput & { userId: string; threadKey: string },
  ): Promise<StoredInboundEmail> {
    const key = providerKey(input.normalized);
    const existing = this.inbound.get(key);

    if (existing) {
      return {
        ...existing,
        duplicate: true,
      };
    }

    const stored: StoredInboundEmail & { normalized: NormalizedEmail } = {
      id: this.allocateId("inbound"),
      userId: input.userId,
      emailThreadId: this.allocateId("thread"),
      emailMessageId: this.allocateId("message"),
      provider: input.normalized.provider,
      providerMessageId: input.normalized.providerMessageId,
      subject: input.normalized.subject,
      duplicate: false,
      normalized: input.normalized,
    };
    this.inbound.set(key, stored);

    return stored;
  }

  async claimPendingInboundEmailsForUser(user: VerifiedEmailUser): Promise<StoredInboundEmail[]> {
    const claimed: StoredInboundEmail[] = [];

    for (const [key, pending] of this.pending.entries()) {
      if (pending.status !== "pending" || pending.normalized.from.email !== user.email.toLowerCase()) {
        continue;
      }

      const stored = await this.createInboundEmailForUser({
        normalized: pending.normalized,
        rawPayload: pending.rawPayload,
        providerReceivedAt: pending.providerReceivedAt,
        userId: user.id,
        threadKey: pending.normalized.providerMessageId,
      });
      pending.status = "claimed";
      this.pending.delete(key);

      if (!stored.duplicate) {
        claimed.push(stored);
      }
    }

    return claimed;
  }

  private allocateId(prefix: string) {
    return `${prefix}-${this.nextId++}`;
  }
}

function providerKey(email: NormalizedEmail) {
  return `${email.provider}:${email.providerMessageId}`;
}
