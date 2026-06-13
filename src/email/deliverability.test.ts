import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { classifyPostmarkEvent, applyDeliverabilityEvent } from "@/email/deliverability";

// ---------------------------------------------------------------------------
// Pure classification tests (no DB needed)
// ---------------------------------------------------------------------------

describe("classifyPostmarkEvent", () => {
  describe("Bounce", () => {
    it("classifies a Bounce payload → kind=bounce, newState=bounced, extracts Email", () => {
      const payload = {
        RecordType: "Bounce",
        ID: 42,
        Email: "user@example.com",
        Type: "HardBounce",
      };
      const result = classifyPostmarkEvent(payload);
      expect(result.kind).toBe("bounce");
      expect(result.recipient).toBe("user@example.com");
      expect(result.newState).toBe("bounced");
      expect(result.providerRecordId).toBe(42);
    });

    it("returns null recipient when Email field is absent", () => {
      const payload = { RecordType: "Bounce", ID: 1 };
      const result = classifyPostmarkEvent(payload);
      expect(result.kind).toBe("bounce");
      expect(result.recipient).toBeNull();
    });
  });

  describe("SpamComplaint", () => {
    it("classifies a SpamComplaint payload → kind=complaint, newState=complained, extracts Recipient", () => {
      const payload = {
        RecordType: "SpamComplaint",
        ID: 99,
        Recipient: "spammer@example.com",
      };
      const result = classifyPostmarkEvent(payload);
      expect(result.kind).toBe("complaint");
      expect(result.recipient).toBe("spammer@example.com");
      expect(result.newState).toBe("complained");
      expect(result.providerRecordId).toBe(99);
    });
  });

  describe("Delivery", () => {
    it("classifies a Delivery payload → kind=delivery, newState=null", () => {
      const payload = {
        RecordType: "Delivery",
        Recipient: "ok@example.com",
        ID: 7,
      };
      const result = classifyPostmarkEvent(payload);
      expect(result.kind).toBe("delivery");
      expect(result.recipient).toBe("ok@example.com");
      expect(result.newState).toBeNull();
    });
  });

  describe("ignored / unknown", () => {
    it("classifies unknown RecordType → kind=ignored, newState=null", () => {
      const result = classifyPostmarkEvent({ RecordType: "Open", Recipient: "x@example.com" });
      expect(result.kind).toBe("ignored");
      expect(result.newState).toBeNull();
    });

    it("classifies non-object input → kind=ignored", () => {
      expect(classifyPostmarkEvent(null).kind).toBe("ignored");
      expect(classifyPostmarkEvent("string").kind).toBe("ignored");
      expect(classifyPostmarkEvent(42).kind).toBe("ignored");
    });

    it("classifies payload with no RecordType → kind=ignored", () => {
      expect(classifyPostmarkEvent({}).kind).toBe("ignored");
    });
  });
});

// ---------------------------------------------------------------------------
// DB-gated applyDeliverabilityEvent tests
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("applyDeliverabilityEvent (DB-gated)", () => {
  // We import drizzle lazily so the module top-level never calls getDb().
  let db: import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof import("@/db/schema")>;
  let userId: string;
  const testEmail = `deliverability-test-${Date.now()}@example.com`;

  beforeEach(async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const schema = await import("@/db/schema");

    const client = postgres(TEST_DB_URL!);
    db = drizzle(client, { schema }) as typeof db;

    // Seed a test user
    const [inserted] = await db
      .insert(schema.users)
      .values({ email: testEmail, outboundEmailState: "active" })
      .returning({ id: schema.users.id });
    userId = inserted.id;
  });

  afterEach(async () => {
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // Clean up: delete audit rows first (FK), then user
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("updates outboundEmailState to 'bounced' and writes an audit row for a bounce", async () => {
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const result = await applyDeliverabilityEvent(
      { kind: "bounce", recipient: testEmail, newState: "bounced", providerRecordId: 101 },
      db,
    );

    expect(result).toEqual({ updated: true, userId });

    const [user] = await db
      .select({ outboundEmailState: schema.users.outboundEmailState })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(user.outboundEmailState).toBe("bounced");

    const [auditRow] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(auditRow.action).toBe("email.outbound.suppressed");
    expect(auditRow.metadata).toMatchObject({
      recipient: testEmail,
      type: "bounce",
      postmarkRecordId: 101,
    });
  });

  it("updates outboundEmailState to 'complained' and writes an audit row for a complaint", async () => {
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const result = await applyDeliverabilityEvent(
      { kind: "complaint", recipient: testEmail, newState: "complained", providerRecordId: 202 },
      db,
    );

    expect(result).toEqual({ updated: true, userId });

    const [user] = await db
      .select({ outboundEmailState: schema.users.outboundEmailState })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(user.outboundEmailState).toBe("complained");
  });

  it("returns { updated: false } when no user matches recipient", async () => {
    const result = await applyDeliverabilityEvent(
      { kind: "bounce", recipient: "nobody@example.com", newState: "bounced", providerRecordId: null },
      db,
    );
    expect(result).toEqual({ updated: false });
  });

  it("returns { updated: false } when newState is null (e.g. Delivery event)", async () => {
    const result = await applyDeliverabilityEvent(
      { kind: "delivery", recipient: testEmail, newState: null, providerRecordId: null },
      db,
    );
    expect(result).toEqual({ updated: false });
  });
});
