import { describe, expect, it } from "vitest";
import { upsertClerkUserAndClaimInbound } from "@/auth/clerk-users";
import {
  type InboundEmailRepository,
  type InboundWorkflowEvent,
  type PersistInboundEmailInput,
  type PersistPendingInboundEmailInput,
  type StoredInboundEmail,
  type StoredPendingInboundEmail,
  type VerifiedEmailUser,
} from "@/email/inbound";
import type { NormalizedEmail } from "@/email/normalize";
import { forwardLikePostmarkFixture } from "@/email/fixtures/postmark";
import { normalizePostmarkInbound } from "@/email/normalize";

const CLERK_USER_ID = "user_2abcDEF";
// forwardLikePostmarkFixture is sent from this address (see inbound.test.ts).
const SENDER_EMAIL = "arav@example.com";

describe("upsertClerkUserAndClaimInbound", () => {
  it("upserts the user + clerk identity and writes the audit actions when verified", async () => {
    const db = new FakeDb();
    const repository = new InMemoryInboundRepository();

    const result = await upsertClerkUserAndClaimInbound(
      { clerkUserId: CLERK_USER_ID, email: SENDER_EMAIL, verified: true },
      { db: db.asDb(), repository, sendEvent: async () => {}, shouldDispatchWorkflow: true },
    );

    expect(result.user.email).toBe(SENDER_EMAIL);
    expect(db.users).toHaveLength(1);
    expect(db.users[0]).toMatchObject({ email: SENDER_EMAIL, status: "verified" });
    expect(db.users[0].verifiedAt).toBeInstanceOf(Date);

    expect(db.identities).toHaveLength(1);
    expect(db.identities[0]).toMatchObject({
      provider: "clerk",
      providerAccountId: CLERK_USER_ID,
      email: SENDER_EMAIL,
      isPrimary: true,
    });

    expect(db.audits.map((a) => a.action)).toEqual([
      "auth.clerk_user_created",
      "auth.clerk_email_verified",
    ]);
  });

  it("stores a pending user with no verified audit and skips claiming when unverified", async () => {
    const db = new FakeDb();
    const repository = new InMemoryInboundRepository();
    // Hold an inbound email so we can prove an unverified upsert does NOT claim it.
    await holdPendingEmail(repository);

    const result = await upsertClerkUserAndClaimInbound(
      { clerkUserId: CLERK_USER_ID, email: SENDER_EMAIL, verified: false },
      { db: db.asDb(), repository, sendEvent: async () => {}, shouldDispatchWorkflow: true },
    );

    expect(db.users[0]).toMatchObject({ status: "pending" });
    expect(db.users[0].verifiedAt).toBeNull();
    expect(db.audits.map((a) => a.action)).toEqual(["auth.clerk_user_created"]);
    expect(result.claimedEmails).toHaveLength(0);
    expect(repository.pendingCount()).toBe(1);
  });

  it("claims held inbound email and fires sender_verified + received on verify", async () => {
    const db = new FakeDb();
    const repository = new InMemoryInboundRepository();
    await holdPendingEmail(repository);

    const events: InboundWorkflowEvent[] = [];
    const result = await upsertClerkUserAndClaimInbound(
      { clerkUserId: CLERK_USER_ID, email: SENDER_EMAIL, verified: true },
      {
        db: db.asDb(),
        repository,
        sendEvent: async (event) => {
          events.push(event);
        },
        shouldDispatchWorkflow: true,
      },
    );

    expect(result.claimedEmails).toHaveLength(1);
    expect(repository.pendingCount()).toBe(0);
    expect(repository.inboundCount()).toBe(1);
    expect(events.map((event) => event.name)).toEqual([
      "email.sender_verified",
      "email.received",
    ]);
  });

  it("is idempotent on replay: no duplicate identity and no double claim", async () => {
    const db = new FakeDb();
    const repository = new InMemoryInboundRepository();
    await holdPendingEmail(repository);

    const events: InboundWorkflowEvent[] = [];
    const sendEvent = async (event: InboundWorkflowEvent) => {
      events.push(event);
    };
    const deps = { db: db.asDb(), repository, sendEvent, shouldDispatchWorkflow: true };
    const input = { clerkUserId: CLERK_USER_ID, email: SENDER_EMAIL, verified: true };

    const first = await upsertClerkUserAndClaimInbound(input, deps);
    const replay = await upsertClerkUserAndClaimInbound(input, deps);

    expect(first.claimedEmails).toHaveLength(1);
    expect(replay.claimedEmails).toHaveLength(0);
    expect(db.users).toHaveLength(1);
    expect(db.identities).toHaveLength(1);
    expect(repository.inboundCount()).toBe(1);
    expect(events.filter((event) => event.name === "email.received")).toHaveLength(1);
  });

  it("does not dispatch workflow events when the dispatch gate is closed", async () => {
    const db = new FakeDb();
    const repository = new InMemoryInboundRepository();
    await holdPendingEmail(repository);

    const events: InboundWorkflowEvent[] = [];
    const result = await upsertClerkUserAndClaimInbound(
      { clerkUserId: CLERK_USER_ID, email: SENDER_EMAIL, verified: true },
      {
        db: db.asDb(),
        repository,
        sendEvent: async (event) => {
          events.push(event);
        },
        shouldDispatchWorkflow: false,
      },
    );

    // Claim still happens (held email moves to inbound), but no Inngest events fire.
    expect(result.claimedEmails).toHaveLength(1);
    expect(events).toHaveLength(0);
  });
});

async function holdPendingEmail(repository: InMemoryInboundRepository) {
  const normalized = normalizePostmarkInbound(forwardLikePostmarkFixture);
  await repository.createPendingInboundEmail({
    normalized,
    rawPayload: forwardLikePostmarkFixture,
    providerReceivedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

// --- Minimal Drizzle-shaped fake for the insert chains used by clerk-users.ts ---

type UserRow = {
  email: string;
  status: "pending" | "verified";
  verifiedAt: Date | null;
  updatedAt: Date;
};
type IdentityRow = {
  userId: string;
  provider: string;
  providerAccountId: string;
  email: string;
  isPrimary: boolean;
};
type AuditRow = { userId: string; action: string; actorType: string; metadata: unknown };

class FakeDb {
  users: (UserRow & { id: string })[] = [];
  identities: IdentityRow[] = [];
  audits: AuditRow[] = [];
  private nextUserId = 1;

  asDb() {
    // The production code only calls db.insert(table).values(...).{onConflictDoUpdate,returning}.
    return { insert: (table: unknown) => this.insert(table) } as never;
  }

  private insert(table: unknown) {
    const kind = tableKind(table);
    return {
      values: (value: Record<string, unknown>) => this.values(kind, value),
    };
  }

  private values(kind: "users" | "identities" | "audit", value: Record<string, unknown>) {
    if (kind === "audit") {
      this.audits.push(value as unknown as AuditRow);
      // audit inserts are awaited directly (no returning/onConflict chain).
      return Promise.resolve(undefined);
    }

    if (kind === "users") {
      const incoming = value as unknown as UserRow;
      const existing = this.users.find((u) => u.email === incoming.email);
      return {
        onConflictDoUpdate: ({ set }: { set: Partial<UserRow> }) => {
          if (existing) {
            Object.assign(existing, set);
          } else {
            this.users.push({ id: `usr_${this.nextUserId++}`, ...incoming });
          }
          return {
            returning: () => {
              const row = this.users.find((u) => u.email === incoming.email)!;
              return Promise.resolve([{ id: row.id, email: row.email }]);
            },
          };
        },
      };
    }

    // identities
    const incoming = value as unknown as IdentityRow;
    return {
      onConflictDoUpdate: ({ set }: { set: Partial<IdentityRow> }) => {
        const existing = this.identities.find(
          (i) => i.provider === incoming.provider && i.providerAccountId === incoming.providerAccountId,
        );
        if (existing) {
          Object.assign(existing, set);
        } else {
          this.identities.push(incoming);
        }
        return Promise.resolve(undefined);
      },
    };
  }
}

function tableKind(table: unknown): "users" | "identities" | "audit" {
  // Drizzle pgTable objects expose their SQL name via a symbol; match on it.
  const name = pgTableName(table);
  if (name === "users") return "users";
  if (name === "user_identities") return "identities";
  if (name === "audit_log") return "audit";
  throw new Error(`unexpected table in fake db: ${name}`);
}

function pgTableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find(
    (s) => s.description === "drizzle:Name",
  );
  return sym ? ((table as Record<symbol, string>)[sym] as string) : "";
}

// --- Reused in-memory inbound repository (mirrors inbound.test.ts) ---

type PendingRecord = PersistPendingInboundEmailInput & {
  id: string;
  status: "pending" | "claimed";
};

class InMemoryInboundRepository implements InboundEmailRepository {
  private readonly verifiedUsers = new Map<string, VerifiedEmailUser>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly inbound = new Map<string, StoredInboundEmail & { normalized: NormalizedEmail }>();
  private nextId = 1;

  inboundCount() {
    return this.inbound.size;
  }

  pendingCount() {
    return [...this.pending.values()].filter((record) => record.status === "pending").length;
  }

  async findVerifiedUserByEmail(email: string): Promise<VerifiedEmailUser | null> {
    return this.verifiedUsers.get(email.toLowerCase()) ?? null;
  }

  // Thread-following is not exercised by the clerk-user flow; satisfy the interface.
  async findThreadOwnerForFollow(): Promise<VerifiedEmailUser | null> {
    return null;
  }

  async recordThreadFollowedAudit(): Promise<void> {
    // no-op
  }

  async createPendingInboundEmail(
    input: PersistPendingInboundEmailInput,
  ): Promise<StoredPendingInboundEmail> {
    const key = providerKey(input.normalized);
    const existing = this.pending.get(key);
    if (existing) {
      return { id: existing.id, providerMessageId: input.normalized.providerMessageId, duplicate: true };
    }
    const id = this.allocateId("pending");
    this.pending.set(key, { ...input, id, status: "pending" });
    return { id, providerMessageId: input.normalized.providerMessageId, duplicate: false };
  }

  async createInboundEmailForUser(
    input: PersistInboundEmailInput & { userId: string; threadKey: string },
  ): Promise<StoredInboundEmail> {
    const key = providerKey(input.normalized);
    const existing = this.inbound.get(key);
    if (existing) {
      return { ...existing, duplicate: true };
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
