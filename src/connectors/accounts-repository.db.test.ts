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
import { reconcileConnectorAccounts } from "@/connectors/reconcile";
import type { ConnectedAccountListResponse, ConnectedAccountRetrieveResponse } from "@composio/core";

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

// ---------------------------------------------------------------------------
// DB-gated reconcile integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)("reconcileConnectorAccounts (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrizzleConnectorAccountsRepository(db as any);

  let userId: string;

  /** Minimal fake Composio client returning a fixed ACTIVE slack account. */
  function fakeClientWithSlack(composioAccountId: string) {
    return {
      listConnectedAccounts: async (): Promise<ConnectedAccountListResponse> => ({
        items: [
          {
            id: composioAccountId,
            status: "ACTIVE" as const,
            statusReason: null,
            toolkit: { slug: "slack" },
            isDisabled: false,
            createdAt: "2026-06-13T12:00:00.000Z",
            updatedAt: "2026-06-13T12:00:00.000Z",
            authConfig: {} as ConnectedAccountListResponse["items"][0]["authConfig"],
            experimental: undefined,
          },
        ] as unknown as ConnectedAccountListResponse["items"],
        totalPages: 1,
        nextCursor: null,
      }),
    };
  }

  /** Minimal fake detail fetcher returning a slack account with an email. */
  function fakeDetail(
    composioAccountId: string,
    email: string,
  ): (id: string) => Promise<ConnectedAccountRetrieveResponse> {
    return async (_id) =>
      ({
        id: composioAccountId,
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "slack" },
        isDisabled: false,
        createdAt: "2026-06-13T12:00:00.000Z",
        updatedAt: "2026-06-13T12:00:00.000Z",
        state: { email },
        authConfig: {},
        experimental: undefined,
      }) as unknown as ConnectedAccountRetrieveResponse;
  }

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-reconcile-${Date.now()}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;
  });

  afterAll(async () => {
    await db.delete(connectorAccounts).where(eq(connectorAccounts.userId, userId));
    await db.delete(users).where(inArray(users.id, [userId]));
    await sql.end();
  });

  it("creates a connector_accounts row when none exists (webhook-missed scenario)", async () => {
    // No row in DB yet — simulates a user who completed OAuth but whose webhook
    // was not delivered.
    const before = await repo.findActiveByUserAndProvider(userId, "slack");
    expect(before).toBeNull();

    const composioAccountId = `ca_reconcile_${Date.now()}`;
    const upserted = await reconcileConnectorAccounts({
      userId,
      provider: "slack",
      accountsRepo: repo,
      client: fakeClientWithSlack(composioAccountId),
      fetchDetail: fakeDetail(composioAccountId, "user@slack.com"),
    });

    expect(upserted).toHaveLength(1);
    expect(upserted[0].provider).toBe("slack");
    expect(upserted[0].status).toBe("active");
    expect(upserted[0].externalAccountEmail).toBe("user@slack.com");

    // The row is now findable by the normal active lookup.
    const after = await repo.findActiveByUserAndProvider(userId, "slack");
    expect(after).not.toBeNull();
    expect(after!.composioConnectedAccountId).toBe(composioAccountId);
  });

  it("running reconcile twice keeps exactly ONE row (idempotent on real DB)", async () => {
    const composioAccountId = (
      await repo.findActiveByUserAndProvider(userId, "slack")
    )?.composioConnectedAccountId ?? `ca_reconcile2_${Date.now()}`;

    await reconcileConnectorAccounts({
      userId,
      provider: "slack",
      accountsRepo: repo,
      client: fakeClientWithSlack(composioAccountId),
      fetchDetail: fakeDetail(composioAccountId, "user@slack.com"),
    });

    // Still exactly one slack row for this user.
    const all = await db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.userId, userId));
    const slackRows = all.filter((r) => r.provider === "slack");
    expect(slackRows).toHaveLength(1);
  });
});
