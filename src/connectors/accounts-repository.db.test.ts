/**
 * DB-gated integration tests for DrizzleConnectorAccountsRepository.
 *
 * These exercise the REAL Drizzle SQL (onConflictDoUpdate, the unique-index
 * reconciliation) against a live Postgres — the in-memory fake cannot catch a
 * wrong conflict target. SKIPPED unless TEST_DATABASE_URL is set:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { connectorAccounts, users } from "@/db/schema";
import { DrizzleConnectorAccountsRepository } from "@/connectors/accounts-repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("DrizzleConnectorAccountsRepository (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrizzleConnectorAccountsRepository(db as any);

  let userId: string;
  const NOW = new Date("2026-06-13T12:00:00.000Z");
  const LATER = new Date("2026-06-13T18:00:00.000Z");

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-connector-repo-${Date.now()}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;
  });

  afterAll(async () => {
    await db.delete(connectorAccounts).where(eq(connectorAccounts.userId, userId));
    await db.delete(users).where(inArray(users.id, [userId]));
    await sql.end();
  });

  it("inserts a new connector account on first connect", async () => {
    const row = await repo.upsertByComposioAccount({
      composioConnectedAccountId: "ca_first",
      composioEntityId: userId,
      userId,
      provider: "slack",
      status: "active",
      statusReason: null,
      now: NOW,
    });
    expect(row.composioConnectedAccountId).toBe("ca_first");
    expect(row.status).toBe("active");
    expect(row.userId).toBe(userId);
  });

  it("RECONNECT: a new composio id for the same (user, provider) updates the SAME row, not a duplicate", async () => {
    const before = await repo.findActiveByUserAndProvider(userId, "slack");
    expect(before?.composioConnectedAccountId).toBe("ca_first");

    // Simulate disconnect then reconnect: mark disabled (sets disconnectedAt), then a
    // fresh connect arrives with a DIFFERENT composio id.
    await repo.markStatus({
      composioConnectedAccountId: "ca_first",
      status: "disabled",
      disconnectedAt: NOW,
      now: NOW,
    });

    const reconnected = await repo.upsertByComposioAccount({
      composioConnectedAccountId: "ca_second", // NEW id — the reconnect bug case
      composioEntityId: userId,
      userId,
      provider: "slack",
      status: "active",
      statusReason: null,
      now: LATER,
    });

    // Same logical row (id preserved), composio id adopted, reactivated, disconnect cleared.
    expect(reconnected.id).toBe(before!.id);
    expect(reconnected.composioConnectedAccountId).toBe("ca_second");
    expect(reconnected.status).toBe("active");
    expect(reconnected.disconnectedAt).toBeNull();

    // Exactly ONE row for (user, slack) — no duplicate.
    const all = await db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.userId, userId));
    const slackRows = all.filter((r) => r.provider === "slack");
    expect(slackRows).toHaveLength(1);
  });

  it("upsert does NOT blank hydration fields when they are omitted", async () => {
    await repo.hydrate({
      id: (await repo.findActiveByUserAndProvider(userId, "slack"))!.id,
      externalAccountEmail: "arav@example.com",
      externalAccountLabel: "Acme Workspace",
      scopes: ["chat:write"],
      metadata: { workspace_id: "T123" },
    });

    // A later active-event upsert (no email/label provided) must preserve them.
    const after = await repo.upsertByComposioAccount({
      composioConnectedAccountId: "ca_second",
      composioEntityId: userId,
      userId,
      provider: "slack",
      status: "active",
      statusReason: null,
      now: LATER,
    });
    expect(after.externalAccountEmail).toBe("arav@example.com");
    expect(after.externalAccountLabel).toBe("Acme Workspace");
  });

  it("listActive returns only active accounts", async () => {
    const active = await repo.listActive();
    expect(active.some((r) => r.userId === userId && r.provider === "slack")).toBe(true);

    await repo.markStatus({ composioConnectedAccountId: "ca_second", status: "revoked", now: LATER });
    const afterRevoke = await repo.listActive();
    expect(afterRevoke.some((r) => r.userId === userId && r.provider === "slack")).toBe(false);
  });
});
