/**
 * DB-gated integration tests for deliverability-admin helpers.
 *
 * SKIPPED unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { users, auditLog } from "@/db/schema";
import { listSuppressedUsers, reactivateUser } from "@/admin/deliverability-admin";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("deliverability-admin (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });

  const RUN_ID = Date.now();
  let bouncedUserId: string;
  let complainedUserId: string;
  let activeUserId: string;
  // A fake admin user id (no DB row needed — stored only in audit metadata).
  const ADMIN_USER_ID = `admin-${RUN_ID}`;

  beforeAll(async () => {
    const rows = await db
      .insert(users)
      .values([
        {
          email: `test-bounced-${RUN_ID}@test.invalid`,
          outboundEmailState: "bounced",
          timezone: "UTC",
        },
        {
          email: `test-complained-${RUN_ID}@test.invalid`,
          outboundEmailState: "complained",
          timezone: "UTC",
        },
        {
          email: `test-active-${RUN_ID}@test.invalid`,
          outboundEmailState: "active",
          timezone: "UTC",
        },
      ])
      .returning({ id: users.id, email: users.email, state: users.outboundEmailState });

    for (const r of rows) {
      if (r.state === "bounced") bouncedUserId = r.id;
      else if (r.state === "complained") complainedUserId = r.id;
      else activeUserId = r.id;
    }
  });

  afterAll(async () => {
    const ids = [bouncedUserId, complainedUserId, activeUserId].filter(Boolean);
    if (ids.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // listSuppressedUsers
  // ---------------------------------------------------------------------------

  it("listSuppressedUsers returns only non-active users", async () => {
    const rows = await listSuppressedUsers({ db });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(bouncedUserId);
    expect(ids).toContain(complainedUserId);
    expect(ids).not.toContain(activeUserId);
  });

  it("listSuppressedUsers includes state and updatedAt", async () => {
    const rows = await listSuppressedUsers({ db });
    const bounced = rows.find((r) => r.id === bouncedUserId);
    expect(bounced).toBeDefined();
    expect(bounced!.outboundEmailState).toBe("bounced");
    expect(bounced!.updatedAt).toBeInstanceOf(Date);
    expect(bounced!.email).toContain("test-bounced-");
  });

  // ---------------------------------------------------------------------------
  // reactivateUser
  // ---------------------------------------------------------------------------

  it("reactivateUser sets outboundEmailState to active", async () => {
    const result = await reactivateUser(
      { userId: bouncedUserId, adminUserId: ADMIN_USER_ID },
      db,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing
    expect(result.priorState).toBe("bounced");

    // Verify DB row updated.
    const [row] = await db
      .select({ state: users.outboundEmailState })
      .from(users)
      .where(eq(users.id, bouncedUserId));
    expect(row.state).toBe("active");
  });

  it("reactivateUser writes an audit_log row with priorState and adminUserId", async () => {
    // Use the complained user for this test.
    await reactivateUser({ userId: complainedUserId, adminUserId: ADMIN_USER_ID }, db);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, complainedUserId));

    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const reactivatedRow = auditRows.find((r) => r.action === "email.outbound.reactivated");
    expect(reactivatedRow).toBeDefined();
    expect(reactivatedRow!.actorType).toBe("admin");

    const meta = reactivatedRow!.metadata as Record<string, unknown>;
    expect(meta.priorState).toBe("complained");
    expect(meta.adminUserId).toBe(ADMIN_USER_ID);
  });

  it("reactivateUser returns not_found for unknown userId", async () => {
    const result = await reactivateUser(
      { userId: "00000000-0000-0000-0000-000000000000", adminUserId: ADMIN_USER_ID },
      db,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });

  it("reactivateUser returns already_active for an active user", async () => {
    const result = await reactivateUser(
      { userId: activeUserId, adminUserId: ADMIN_USER_ID },
      db,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("already_active");
  });

  it("reactivated user no longer appears in listSuppressedUsers", async () => {
    // bouncedUser was reactivated in the earlier test.
    const rows = await listSuppressedUsers({ db });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(bouncedUserId);
  });
});
