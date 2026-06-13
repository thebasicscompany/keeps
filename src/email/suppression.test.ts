import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SuppressionAwareSender, SUPPRESSION_SKIP_RESULT } from "@/email/suppression";
import type { EmailSender, OutboundEmail, SendResult } from "@/email/outbound";

// ---------------------------------------------------------------------------
// Minimal spy sender — pure in-memory, no network
// ---------------------------------------------------------------------------

class SpySender implements EmailSender {
  readonly provider = "spy";
  readonly calls: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<SendResult> {
    this.calls.push(email);
    return { providerMessageId: "spy-message-id" };
  }
}

function makeEmail(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    userId: null,
    nudgeId: null,
    to: "test@example.com",
    subject: "Test",
    textBody: "Hello",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB-free tests: suppression guard bypassed when no userId
// ---------------------------------------------------------------------------

describe("SuppressionAwareSender (no DB — userId null)", () => {
  it("delegates to the inner sender when userId is null", async () => {
    const spy = new SpySender();
    const sender = new SuppressionAwareSender(spy);
    const email = makeEmail({ userId: null });

    const result = await sender.send(email);

    expect(result.providerMessageId).toBe("spy-message-id");
    expect(spy.calls).toHaveLength(1);
  });

  it("exposes the inner provider name", () => {
    const sender = new SuppressionAwareSender(new SpySender());
    expect(sender.provider).toBe("spy");
  });
});

// ---------------------------------------------------------------------------
// DB-gated tests: all four outboundEmailState values
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("SuppressionAwareSender (DB-gated)", () => {
  let db: import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof import("@/db/schema")>;
  let spy: SpySender;
  let userId: string;
  let nudgeId: string;
  const testEmail = `suppression-test-${Date.now()}@example.com`;

  beforeEach(async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const schema = await import("@/db/schema");

    const client = postgres(TEST_DB_URL!);
    db = drizzle(client, { schema }) as typeof db;
    spy = new SpySender();

    // Insert a user with state 'active' (will be changed per test)
    const [insertedUser] = await db
      .insert(schema.users)
      .values({ email: testEmail, outboundEmailState: "active" })
      .returning({ id: schema.users.id });
    userId = insertedUser.id;

    // Insert a pending nudge owned by this user
    const [insertedNudge] = await db
      .insert(schema.nudges)
      .values({ userId, body: "Test nudge body", status: "pending" })
      .returning({ id: schema.nudges.id });
    nudgeId = insertedNudge.id;
  });

  afterEach(async () => {
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.nudges).where(eq(schema.nudges.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  async function setState(state: "active" | "bounced" | "complained" | "suppressed") {
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.users)
      .set({ outboundEmailState: state })
      .where(eq(schema.users.id, userId));
  }

  async function getNudgeStatus() {
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ status: schema.nudges.status, metadata: schema.nudges.metadata })
      .from(schema.nudges)
      .where(eq(schema.nudges.id, nudgeId));
    return row;
  }

  it("active → inner sender is called, returns real result", async () => {
    await setState("active");
    const sender = new SuppressionAwareSender(spy, db);
    const email = makeEmail({ userId, nudgeId });

    const result = await sender.send(email);

    expect(result.providerMessageId).toBe("spy-message-id");
    expect(spy.calls).toHaveLength(1);

    const nudge = await getNudgeStatus();
    expect(nudge.status).toBe("pending"); // unchanged
  });

  it("bounced → send is skipped, nudge marked skipped with user_suppressed reason", async () => {
    await setState("bounced");
    const sender = new SuppressionAwareSender(spy, db);
    const email = makeEmail({ userId, nudgeId });

    const result = await sender.send(email);

    expect(result).toBe(SUPPRESSION_SKIP_RESULT);
    expect(spy.calls).toHaveLength(0);

    const nudge = await getNudgeStatus();
    expect(nudge.status).toBe("skipped");
    expect(nudge.metadata).toMatchObject({ reason: "user_suppressed" });
  });

  it("complained → send is skipped, nudge marked skipped", async () => {
    await setState("complained");
    const sender = new SuppressionAwareSender(spy, db);
    const email = makeEmail({ userId, nudgeId });

    const result = await sender.send(email);

    expect(result).toBe(SUPPRESSION_SKIP_RESULT);
    expect(spy.calls).toHaveLength(0);

    const nudge = await getNudgeStatus();
    expect(nudge.status).toBe("skipped");
  });

  it("suppressed → send is skipped, nudge marked skipped", async () => {
    await setState("suppressed");
    const sender = new SuppressionAwareSender(spy, db);
    const email = makeEmail({ userId, nudgeId });

    const result = await sender.send(email);

    expect(result).toBe(SUPPRESSION_SKIP_RESULT);
    expect(spy.calls).toHaveLength(0);

    const nudge = await getNudgeStatus();
    expect(nudge.status).toBe("skipped");
  });

  it("bounced but nudgeId is null → send is skipped, no nudge update attempted", async () => {
    await setState("bounced");
    const sender = new SuppressionAwareSender(spy, db);
    const email = makeEmail({ userId, nudgeId: null });

    const result = await sender.send(email);

    expect(result).toBe(SUPPRESSION_SKIP_RESULT);
    expect(spy.calls).toHaveLength(0);
  });
});
