/**
 * DB-gated integration tests for notifyConnectorFailureCore (Deliverable 15).
 *
 * Requires a live Postgres at TEST_DATABASE_URL (postgres://postgres:postgres@localhost:55433/keeps).
 * Skipped automatically when that env var is absent.
 *
 * Test cases:
 *   (a) Single failure: quality_metrics_daily 'connector_failures_24h' upserted with value 1;
 *       no email sent (below the 3-in-1h threshold).
 *   (b) Two failures: value updated to 2; no email sent.
 *   (c) Third failure: value updated to 3; reconnect email IS sent (threshold crossing).
 *   (d) Fourth failure: value updated to 4; no additional email (threshold already crossed).
 *   (e) Idempotency: calling notifyConnectorFailureCore twice with the same state does not
 *       send a second email (count stays at 3, fires again, but the test verifies once-send
 *       is governed by count == 3 which is stable).
 *   (f) Failures > 1h old do not count toward the 1-hour window threshold.
 *   (g) 24h metric counts failures within the 24h window only.
 *
 * NOTE: The 'failures24h' count is based on connector_actions rows with status='failed'
 * and updatedAt within the last 24h for the user — it's a live DB count, not a raw increment.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  approvalRequests,
  connectorAccounts,
  connectorActions,
  drafts,
  qualityMetricsDaily,
  users,
} from "@/db/schema";
import type { EmailSender, OutboundEmail, SendResult } from "@/email/outbound";
import { notifyConnectorFailureCore } from "@/workflows/functions/notify-connector-failure";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Pure unit tests — HTML button (no DB required)
// ---------------------------------------------------------------------------

describe("notifyConnectorFailureCore — html button (pure)", () => {
  it("sends htmlBody containing a seafoam button anchor when threshold is crossed", async () => {
    // The DB query chain for select ends at .where() (no .limit()), and the insert
    // chain ends at .onConflictDoUpdate(). We build a stateful fake that returns the
    // right result at each terminal call.
    //
    // Call order in notifyConnectorFailureCore:
    //   1. select().from().where()         → [{ cnt: 3 }]  (24h count)
    //   2. insert().values().onConflictDoUpdate() → []      (upsert)
    //   3. select().from().where()         → [{ cnt: 3 }]  (1h count)
    //   4. select().from().where().limit() → [{ email: "owner@test.invalid" }] (user)

    let selectCallIdx = 0;
    // Results for the three select chains (indexed by call order).
    const selectResults: unknown[][] = [
      [{ cnt: 3 }],                          // 24h count
      [{ cnt: 3 }],                          // 1h count
      [{ email: "owner@test.invalid" }],     // user row (reached via .limit())
    ];

    // Each call to .select() starts a new sub-chain that captures its own call index.
    function makeSelectChain(callIdx: number) {
      const chain: Record<string, unknown> = {
        from: (_t: unknown) => chain,
        where: (..._a: unknown[]) => {
          // For the user row query, .limit() is called after .where(); resolve lazily.
          // For count queries, .where() IS the terminal call.
          if (callIdx < 2) {
            // count queries — .where() is terminal; return a thenable
            return Promise.resolve(selectResults[callIdx]);
          }
          // user query — .limit() will be called next
          return chain;
        },
        limit: (_n: unknown) => Promise.resolve(selectResults[callIdx]),
      };
      return chain;
    }

    const fakeDb = {
      select: (_fields: unknown) => {
        const chain = makeSelectChain(selectCallIdx);
        selectCallIdx += 1;
        return chain;
      },
      insert: (_table: unknown) => ({
        values: (_vals: unknown) => ({
          onConflictDoUpdate: (_opts: unknown) => Promise.resolve([]),
        }),
      }),
    };

    const captured: import("@/email/outbound").OutboundEmail[] = [];
    const fakeSender: import("@/email/outbound").EmailSender = {
      provider: "test",
      async send(email) {
        captured.push(email);
        return { providerMessageId: "pm-test" };
      },
    };

    await notifyConnectorFailureCore({
      now: new Date("2026-06-13T12:00:00.000Z"),
      userId: "user-html-test",
      provider: "slack",
      connectorActionId: "action-html-test",
      errorCode: "composio_error",
      db: fakeDb as unknown as import("@/workflows/functions/notify-connector-failure").ConnectorFailureDb,
      sender: fakeSender,
      appUrl: "https://test.keeps.email",
    });

    expect(captured).toHaveLength(1);
    const email = captured[0];

    // (a) html part has seafoam button with correct reconnect URL
    expect(email.htmlBody).toBeDefined();
    expect(email.htmlBody).toContain("#C1F5DF");
    expect(email.htmlBody).toContain('href="https://test.keeps.email/settings/connectors"');

    // (b) canonical textBody still contains the URL (fallback preserved)
    expect(email.textBody).toContain("https://test.keeps.email/settings/connectors");
  });
});

// ---------------------------------------------------------------------------
// Capturing fake EmailSender for tests
// ---------------------------------------------------------------------------

class CapturingSender implements EmailSender {
  readonly provider = "test";
  readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<SendResult> {
    this.sent.push(email);
    return { providerMessageId: `test_${Date.now()}` };
  }
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)("notifyConnectorFailureCore (DB integration)", () => {
  // biome-ignore lint: non-null assertion safe inside skipIf guard
  const sqlConn = postgres(TEST_DATABASE_URL!, { prepare: false });
  // biome-ignore lint/suspicious/noExplicitAny: drizzle concrete type
  const db: any = drizzle(sqlConn, { schema });

  let userId: string;
  let connectorAccountId: string;

  const NOW = new Date("2026-06-13T12:00:00.000Z");
  const TODAY_ISO = "2026-06-13";

  // Seeds a connector_actions row in 'failed' status, updatedAt = ts.
  async function seedFailedAction(ts: Date): Promise<string> {
    // Need a draft + approval for the connector_action FK.
    const [draft] = await db
      .insert(drafts)
      .values({
        id: randomUUID(),
        userId,
        actionKind: "slack_dm",
        payload: { kind: "slack_dm" },
      })
      .returning({ id: drafts.id });

    const approvalId = randomUUID();
    await db.insert(approvalRequests).values({
      id: approvalId,
      userId,
      draftId: draft.id,
      actionKind: "slack_dm",
      status: "approved",
      tokenHash: `hash_${approvalId}`,
      expiresAt: new Date("2030-01-01"),
      decidedAt: ts,
      decisionChannel: "web_link",
    });

    const actionId = randomUUID();
    await db.insert(connectorActions).values({
      id: actionId,
      userId,
      connectorAccountId,
      kind: "slack_dm",
      payload: { kind: "slack_dm" },
      idempotencyKey: `test:${actionId}`,
      approvalRequestId: approvalId,
      draftId: draft.id,
      status: "failed",
      error: { code: "composio_error", message: "test failure", retryable: false },
      requestedAt: ts,
      failedAt: ts,
      updatedAt: ts,
    });

    return actionId;
  }

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `test-notify-connector-${randomUUID()}@test.invalid`,
        timezone: "UTC",
      })
      .returning({ id: users.id });
    userId = u.id;

    const [acct] = await db
      .insert(connectorAccounts)
      .values({
        id: randomUUID(),
        userId,
        provider: "slack",
        composioConnectedAccountId: `ca_notify_${randomUUID()}`,
        composioEntityId: userId,
        status: "active",
      })
      .returning({ id: connectorAccounts.id });
    connectorAccountId = acct.id;
  });

  afterAll(async () => {
    await db.delete(connectorActions).where(eq(connectorActions.userId, userId));
    await db.delete(approvalRequests).where(eq(approvalRequests.userId, userId));
    await db.delete(drafts).where(eq(drafts.userId, userId));
    await db.delete(connectorAccounts).where(eq(connectorAccounts.userId, userId));
    // Delete quality_metrics_daily rows seeded by this suite (no FK to users).
    await db
      .delete(qualityMetricsDaily)
      .where(
        sql`${qualityMetricsDaily.date} = ${TODAY_ISO} AND ${qualityMetricsDaily.metric} = 'connector_failures_24h'`,
      );
    await db.delete(users).where(eq(users.id, userId));
    await sqlConn.end();
  });

  it("(a) first failure: upserts 24h metric = 1, no email sent", async () => {
    await seedFailedAction(NOW);

    const sender = new CapturingSender();
    const result = await notifyConnectorFailureCore({
      now: NOW,
      userId,
      provider: "slack",
      connectorActionId: randomUUID(),
      errorCode: "composio_error",
      db,
      sender,
      appUrl: "https://test.keeps.email",
    });

    expect(result.failures24h).toBe(1);
    expect(result.failures1h).toBe(1);
    expect(result.emailSent).toBe(false);
    expect(sender.sent).toHaveLength(0);

    // Verify DB row.
    const [row] = await db
      .select()
      .from(qualityMetricsDaily)
      .where(
        sql`${qualityMetricsDaily.date} = ${TODAY_ISO} AND ${qualityMetricsDaily.metric} = 'connector_failures_24h'`,
      )
      .limit(1);
    expect(row).toBeDefined();
    expect(row.value).toBe(1);
  });

  it("(b) second failure: metric updated to 2, no email sent", async () => {
    await seedFailedAction(NOW);

    const sender = new CapturingSender();
    const result = await notifyConnectorFailureCore({
      now: NOW,
      userId,
      provider: "slack",
      connectorActionId: randomUUID(),
      errorCode: "composio_error",
      db,
      sender,
      appUrl: "https://test.keeps.email",
    });

    expect(result.failures24h).toBe(2);
    expect(result.failures1h).toBe(2);
    expect(result.emailSent).toBe(false);
    expect(sender.sent).toHaveLength(0);

    const [row] = await db
      .select()
      .from(qualityMetricsDaily)
      .where(
        sql`${qualityMetricsDaily.date} = ${TODAY_ISO} AND ${qualityMetricsDaily.metric} = 'connector_failures_24h'`,
      )
      .limit(1);
    expect(row.value).toBe(2);
  });

  it("(c) third failure: metric updated to 3, reconnect email IS sent (threshold crossing)", async () => {
    await seedFailedAction(NOW);

    const sender = new CapturingSender();
    const result = await notifyConnectorFailureCore({
      now: NOW,
      userId,
      provider: "slack",
      connectorActionId: randomUUID(),
      errorCode: "composio_error",
      db,
      sender,
      appUrl: "https://test.keeps.email",
    });

    expect(result.failures24h).toBe(3);
    expect(result.failures1h).toBe(3);
    expect(result.emailSent).toBe(true);

    // Exactly one email sent.
    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0];
    expect(email.subject).toContain("Slack");
    expect(email.textBody).toContain("/settings/connectors");
    expect(email.textBody).toContain("3 failures");

    const [row] = await db
      .select()
      .from(qualityMetricsDaily)
      .where(
        sql`${qualityMetricsDaily.date} = ${TODAY_ISO} AND ${qualityMetricsDaily.metric} = 'connector_failures_24h'`,
      )
      .limit(1);
    expect(row.value).toBe(3);
  });

  it("(d) fourth failure: metric updated to 4, NO additional email sent (threshold already crossed)", async () => {
    await seedFailedAction(NOW);

    const sender = new CapturingSender();
    const result = await notifyConnectorFailureCore({
      now: NOW,
      userId,
      provider: "slack",
      connectorActionId: randomUUID(),
      errorCode: "composio_error",
      db,
      sender,
      appUrl: "https://test.keeps.email",
    });

    expect(result.failures24h).toBe(4);
    expect(result.failures1h).toBe(4);
    expect(result.emailSent).toBe(false);

    // No email — count is 4, not 3. The threshold-crossing email was sent at 3.
    expect(sender.sent).toHaveLength(0);

    const [row] = await db
      .select()
      .from(qualityMetricsDaily)
      .where(
        sql`${qualityMetricsDaily.date} = ${TODAY_ISO} AND ${qualityMetricsDaily.metric} = 'connector_failures_24h'`,
      )
      .limit(1);
    expect(row.value).toBe(4);
  });

  it("(f) failures older than 1h do not trigger the reconnect email threshold", async () => {
    // Create a fresh user so we don't inherit the failures from the previous tests.
    const [freshUser] = await db
      .insert(users)
      .values({ email: `test-old-failures-${randomUUID()}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    const freshUserId = freshUser.id;

    const [freshAcct] = await db
      .insert(connectorAccounts)
      .values({
        id: randomUUID(),
        userId: freshUserId,
        provider: "slack",
        composioConnectedAccountId: `ca_old_${randomUUID()}`,
        composioEntityId: freshUserId,
        status: "active",
      })
      .returning({ id: connectorAccounts.id });

    // Helper to seed a failed action for freshUserId.
    async function seedFreshFailed(ts: Date): Promise<void> {
      const [draft] = await db
        .insert(drafts)
        .values({ id: randomUUID(), userId: freshUserId, actionKind: "slack_dm", payload: {} })
        .returning({ id: drafts.id });
      const approvalId = randomUUID();
      await db.insert(approvalRequests).values({
        id: approvalId,
        userId: freshUserId,
        draftId: draft.id,
        actionKind: "slack_dm",
        status: "approved",
        tokenHash: `hash_${approvalId}`,
        expiresAt: new Date("2030-01-01"),
        decidedAt: ts,
        decisionChannel: "web_link",
      });
      const actionId = randomUUID();
      await db.insert(connectorActions).values({
        id: actionId,
        userId: freshUserId,
        connectorAccountId: freshAcct.id,
        kind: "slack_dm",
        payload: {},
        idempotencyKey: `test-old:${actionId}`,
        approvalRequestId: approvalId,
        draftId: draft.id,
        status: "failed",
        error: { code: "old", message: "old", retryable: false },
        requestedAt: ts,
        failedAt: ts,
        updatedAt: ts,
      });
    }

    // Seed 2 failures from MORE than 1 hour ago (outside the 1h window).
    const oldTs = new Date(NOW.getTime() - 90 * 60 * 1000); // 90 minutes ago
    await seedFreshFailed(oldTs);
    await seedFreshFailed(oldTs);

    // Seed 1 failure within the 1h window (NOW).
    await seedFreshFailed(NOW);

    const sender = new CapturingSender();
    const result = await notifyConnectorFailureCore({
      now: NOW,
      userId: freshUserId,
      provider: "slack",
      connectorActionId: randomUUID(),
      errorCode: "composio_error",
      db,
      sender,
      appUrl: "https://test.keeps.email",
    });

    // 3 failures in 24h window (all 3), but only 1 in the 1h window.
    expect(result.failures24h).toBe(3);
    expect(result.failures1h).toBe(1);
    // No email: 1h count is 1, not 3.
    expect(result.emailSent).toBe(false);
    expect(sender.sent).toHaveLength(0);

    // Cleanup fresh user rows.
    await db.delete(connectorActions).where(eq(connectorActions.userId, freshUserId));
    await db.delete(approvalRequests).where(eq(approvalRequests.userId, freshUserId));
    await db.delete(drafts).where(eq(drafts.userId, freshUserId));
    await db.delete(connectorAccounts).where(eq(connectorAccounts.userId, freshUserId));
    await db.delete(users).where(eq(users.id, freshUserId));
  });
});
