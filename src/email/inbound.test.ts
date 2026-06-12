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
  type ThreadFollowedAuditInput,
  type VerifiedEmailUser,
} from "@/email/inbound";
import {
  normalizePostmarkInbound,
  type NormalizedEmail,
  type PostmarkInboundPayload,
} from "@/email/normalize";
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
    expect(result.reply.text).toContain(
      "http://localhost:3000/sign-up?email_address=arav%40example.com",
    );
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

const THREAD_ROOT = "<thread-root@example.com>";
const THREAD_KEY = "thread-root@example.com";

/**
 * A reply from `counterparty` on the thread whose root message-id is THREAD_ROOT.
 * `buildThreadKey` derives the key from the first References token, so two replies that
 * carry the same References root share a threadKey — which is exactly the (forgeable)
 * surface the spoof guard must defend.
 */
function counterpartyReplyFixture(options: {
  messageId: string;
  fromEmail: string;
  fromName?: string;
  references?: string;
}): PostmarkInboundPayload {
  return {
    ...directPostmarkFixture,
    MessageID: options.messageId,
    From: `${options.fromName ?? "Counterparty"} <${options.fromEmail}>`,
    FromFull: { Email: options.fromEmail, Name: options.fromName ?? "Counterparty", MailboxHash: "" },
    To: "agent@keeps.ai",
    ToFull: [{ Email: "agent@keeps.ai", Name: "Keeps", MailboxHash: "" }],
    Subject: "Re: Partner renewal",
    TextBody: "Following up on the renewal packet.",
    HtmlBody: "<p>Following up on the renewal packet.</p>",
    StrippedTextReply: "Following up on the renewal packet.",
    Headers: [
      { Name: "Message-ID", Value: `<${options.messageId}@example.com>` },
      { Name: "References", Value: options.references ?? THREAD_ROOT },
    ],
  };
}

describe("handlePostmarkInboundEmail — CC-once thread following (B3)", () => {
  it("attaches a counterparty reply to the owner's thread when the sender was a prior participant", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    // Prior message on the thread had jordan@example.com on To/Cc.
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "jordan@example.com"],
    });

    const events: InboundWorkflowEvent[] = [];
    const result = await handlePostmarkInboundEmail(
      counterpartyReplyFixture({ messageId: "follow-1", fromEmail: "jordan@example.com" }),
      {
        repository,
        appUrl: "http://localhost:3000",
        sendEvent: async (event) => {
          events.push(event);
        },
      },
    );

    expect(result.status).toBe("sender_verified");
    if (result.status !== "sender_verified") throw new Error("expected sender_verified");
    // Reply addressed to the OWNER, never the counterparty.
    expect(result.reply.to).toBe("arav@example.com");
    expect(repository.inboundCount()).toBe(1);
    expect(repository.pendingCount()).toBe(0);
    expect(events).toMatchObject([
      { name: "email.received", data: { userId: "owner-1", providerMessageId: "follow-1" } },
    ]);
    expect(repository.threadFollowedAudits).toMatchObject([
      { ownerUserId: "owner-1", threadKey: THREAD_KEY, senderEmail: "jordan@example.com" },
    ]);
  });

  it("SPOOF GUARD: a stranger with stolen References (same threadKey) but no participation falls through to pending", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "jordan@example.com"],
    });

    const events: InboundWorkflowEvent[] = [];
    const result = await handlePostmarkInboundEmail(
      // attacker copied the same References root but was never a participant
      counterpartyReplyFixture({ messageId: "spoof-1", fromEmail: "attacker@evil.com" }),
      {
        repository,
        appUrl: "http://localhost:3000",
        sendEvent: async (event) => {
          events.push(event);
        },
      },
    );

    expect(result.status).toBe("sender_unknown");
    expect(repository.inboundCount()).toBe(0);
    expect(repository.pendingCount()).toBe(1);
    expect(repository.threadFollowedAudits).toHaveLength(0);
    expect(events).toMatchObject([
      { name: "email.sender_unknown", data: { senderEmail: "attacker@evil.com" } },
    ]);
  });

  it("SPOOF GUARD: a sender spoofing the agent address itself is never granted participation", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    // The agent address is on the thread (as it is on every captured thread).
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "agent@keeps.email"],
    });

    const result = await handlePostmarkInboundEmail(
      counterpartyReplyFixture({ messageId: "agent-spoof-1", fromEmail: "agent@keeps.email" }),
      { repository, appUrl: "http://localhost:3000" },
    );

    expect(result.status).toBe("sender_unknown");
    expect(repository.inboundCount()).toBe(0);
    expect(repository.threadFollowedAudits).toHaveLength(0);
  });

  it("matches participants case-insensitively (normalizeIdentityEmail lowercases)", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "jordan@example.com"],
    });

    const result = await handlePostmarkInboundEmail(
      // Postmark already lowercases addresses, but the guard must not depend on casing.
      counterpartyReplyFixture({ messageId: "case-1", fromEmail: "Jordan@Example.com" }),
      { repository, appUrl: "http://localhost:3000" },
    );

    expect(result.status).toBe("sender_verified");
    expect(repository.inboundCount()).toBe(1);
  });

  it("SPOOF GUARD: plus-addressing is NOT treated as the same address (normalizeIdentityEmail does not strip +tag)", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "jordan@example.com"],
    });

    const result = await handlePostmarkInboundEmail(
      counterpartyReplyFixture({ messageId: "plus-1", fromEmail: "jordan+spoof@example.com" }),
      { repository, appUrl: "http://localhost:3000" },
    );

    // jordan+spoof@example.com !== jordan@example.com under normalizeIdentityEmail
    expect(result.status).toBe("sender_unknown");
    expect(repository.inboundCount()).toBe(0);
  });

  it("attaches only to the thread the sender actually participated in when another user shares the threadKey", async () => {
    const repository = new InMemoryInboundRepository();
    const ownerA = { id: "owner-a", email: "arav@example.com" };
    const ownerB = { id: "owner-b", email: "blake@example.com" };
    repository.addVerifiedUser(ownerA);
    repository.addVerifiedUser(ownerB);
    // ownerA's thread (created first) does NOT include jordan.
    repository.seedThread({ owner: ownerA, threadKey: THREAD_KEY, participants: ["arav@example.com"] });
    // ownerB's thread shares the same threadKey AND has jordan as a participant.
    repository.seedThread({
      owner: ownerB,
      threadKey: THREAD_KEY,
      participants: ["blake@example.com", "jordan@example.com"],
    });

    const result = await handlePostmarkInboundEmail(
      counterpartyReplyFixture({ messageId: "multi-1", fromEmail: "jordan@example.com" }),
      { repository, appUrl: "http://localhost:3000" },
    );

    expect(result.status).toBe("sender_verified");
    if (result.status !== "sender_verified") throw new Error("expected sender_verified");
    // Must resolve ownerB, the only thread jordan participated in.
    expect(result.reply.to).toBe("blake@example.com");
    expect(repository.threadFollowedAudits).toMatchObject([{ ownerUserId: "owner-b" }]);
  });

  it("does not attach when the qualifying thread's owner is not verified", async () => {
    const repository = new InMemoryInboundRepository();
    // Owner exists with the thread + participation but is NOT verified.
    repository.seedThread({
      owner: { id: "pending-owner", email: "pending@example.com", verified: false },
      threadKey: THREAD_KEY,
      participants: ["pending@example.com", "jordan@example.com"],
    });

    const result = await handlePostmarkInboundEmail(
      counterpartyReplyFixture({ messageId: "unverified-1", fromEmail: "jordan@example.com" }),
      { repository, appUrl: "http://localhost:3000" },
    );

    expect(result.status).toBe("sender_unknown");
    expect(repository.inboundCount()).toBe(0);
  });

  it("a verified sender's brand-new thread is unaffected by follow logic", async () => {
    const repository = new InMemoryInboundRepository();
    repository.addVerifiedUser({ id: "user-1", email: "arav@example.com" });
    const events: InboundWorkflowEvent[] = [];

    const result = await handlePostmarkInboundEmail(directPostmarkFixture, {
      repository,
      appUrl: "http://localhost:3000",
      sendEvent: async (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe("sender_verified");
    expect(repository.threadFollowedAudits).toHaveLength(0);
    expect(events).toMatchObject([{ name: "email.received", data: { userId: "user-1" } }]);
  });

  it("a duplicate thread-followed delivery returns duplicate and emits no second email.received", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "jordan@example.com"],
    });
    const events: InboundWorkflowEvent[] = [];
    const options = {
      repository,
      appUrl: "http://localhost:3000",
      sendEvent: async (event: InboundWorkflowEvent) => {
        events.push(event);
      },
    };
    const fixture = counterpartyReplyFixture({ messageId: "dup-1", fromEmail: "jordan@example.com" });

    const first = await handlePostmarkInboundEmail(fixture, options);
    const second = await handlePostmarkInboundEmail(fixture, options);

    expect(first.status).toBe("sender_verified");
    expect(second.status).toBe("duplicate");
    expect(repository.inboundCount()).toBe(1);
    expect(events.filter((event) => event.name === "email.received")).toHaveLength(1);
    expect(repository.threadFollowedAudits).toHaveLength(1);
  });

  it("SPOOF GUARD: empty References still resolves to a threadKey but never auto-attaches a stranger", async () => {
    const repository = new InMemoryInboundRepository();
    const owner = { id: "owner-1", email: "arav@example.com" };
    repository.addVerifiedUser(owner);
    repository.seedThread({
      owner,
      threadKey: THREAD_KEY,
      participants: ["arav@example.com", "jordan@example.com"],
    });

    // No References/In-Reply-To header: buildThreadKey falls back to the message-id, which
    // will NOT match THREAD_KEY, so a stranger cannot attach.
    const fixture: PostmarkInboundPayload = {
      ...directPostmarkFixture,
      MessageID: "no-refs-1",
      From: "Stranger <stranger@example.com>",
      FromFull: { Email: "stranger@example.com", Name: "Stranger", MailboxHash: "" },
      Headers: [{ Name: "Message-ID", Value: "<no-refs-1@example.com>" }],
    };

    const result = await handlePostmarkInboundEmail(fixture, {
      repository,
      appUrl: "http://localhost:3000",
    });

    expect(result.status).toBe("sender_unknown");
    expect(repository.inboundCount()).toBe(0);
  });
});

type PendingRecord = PersistPendingInboundEmailInput & {
  id: string;
  status: "pending" | "claimed";
};

type ThreadRecord = {
  id: string;
  userId: string;
  threadKey: string;
  createdAt: number;
  participants: Set<string>;
};

class InMemoryInboundRepository implements InboundEmailRepository {
  private readonly verifiedUsers = new Map<string, VerifiedEmailUser>();
  // Users (verified or not) keyed by id, used to resolve thread owners.
  private readonly usersById = new Map<string, VerifiedEmailUser & { verified: boolean }>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly inbound = new Map<string, StoredInboundEmail & { normalized: NormalizedEmail }>();
  // Threads keyed by `${userId}:${threadKey}`, mirroring the UNIQUE(userId, threadKey) constraint.
  private readonly threads = new Map<string, ThreadRecord>();
  readonly threadFollowedAudits: ThreadFollowedAuditInput[] = [];
  private nextId = 1;
  private threadClock = 0;
  private readonly agentEmail = "agent@keeps.email";

  addVerifiedUser(user: VerifiedEmailUser) {
    this.verifiedUsers.set(user.email.toLowerCase(), user);
    this.usersById.set(user.id, { ...user, verified: true });
  }

  /**
   * Seed an existing thread with its prior participants (the From/To/Cc of earlier mail),
   * so follow / spoof-guard logic has history to inspect. The owner need not be verified
   * unless explicitly added via addVerifiedUser.
   */
  seedThread(input: {
    threadId?: string;
    owner: VerifiedEmailUser & { verified?: boolean };
    threadKey: string;
    participants: string[];
  }): ThreadRecord {
    if (!this.usersById.has(input.owner.id)) {
      this.usersById.set(input.owner.id, {
        id: input.owner.id,
        email: input.owner.email,
        verified: input.owner.verified ?? true,
      });
    }

    const key = `${input.owner.id}:${input.threadKey}`;
    const record: ThreadRecord = {
      id: input.threadId ?? this.allocateId("thread"),
      userId: input.owner.id,
      threadKey: input.threadKey,
      createdAt: this.threadClock++,
      participants: new Set(input.participants.map((email) => email.toLowerCase())),
    };
    this.threads.set(key, record);
    return record;
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

  async findThreadOwnerForFollow(
    threadKey: string,
    senderEmail: string,
  ): Promise<VerifiedEmailUser | null> {
    const normalizedSender = senderEmail.trim().toLowerCase();

    if (normalizedSender === this.agentEmail) {
      return null;
    }

    const matching = [...this.threads.values()]
      .filter((thread) => thread.threadKey === threadKey)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const thread of matching) {
      const participatesViaNonAgent = [...thread.participants].some(
        (participant) => participant !== this.agentEmail && participant === normalizedSender,
      );

      if (!participatesViaNonAgent) {
        continue;
      }

      const owner = this.usersById.get(thread.userId);
      if (owner?.verified) {
        return { id: owner.id, email: owner.email };
      }
    }

    return null;
  }

  async recordThreadFollowedAudit(input: ThreadFollowedAuditInput): Promise<void> {
    this.threadFollowedAudits.push(input);
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

    // Reuse the thread for this (userId, threadKey) — mirrors UNIQUE(userId, threadKey) —
    // and fold this message's From/To/Cc into the thread's participant history.
    const threadMapKey = `${input.userId}:${input.threadKey}`;
    let thread = this.threads.get(threadMapKey);
    if (!thread) {
      thread = {
        id: this.allocateId("thread"),
        userId: input.userId,
        threadKey: input.threadKey,
        createdAt: this.threadClock++,
        participants: new Set<string>(),
      };
      this.threads.set(threadMapKey, thread);
    }
    for (const email of participantEmails(input.normalized)) {
      thread.participants.add(email);
    }

    const stored: StoredInboundEmail & { normalized: NormalizedEmail } = {
      id: this.allocateId("inbound"),
      userId: input.userId,
      emailThreadId: thread.id,
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

function participantEmails(email: NormalizedEmail): string[] {
  return [
    email.from.email,
    ...email.to.map((address) => address.email),
    ...email.cc.map((address) => address.email),
  ].map((value) => value.trim().toLowerCase());
}
