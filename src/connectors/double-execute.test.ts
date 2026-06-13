/**
 * Deliverable D2 — Double-execute regression test.
 *
 * IDEMPOTENCY CONTRACT:
 *   Submitting the same connector action TWICE (via the same idempotency_key, or via two
 *   concurrent executeConnectorAction calls with the same connectorActionId) MUST:
 *     1. Result in AT MOST ONE connector_actions row in the database (the UNIQUE constraint
 *        on idempotency_key enforces this at the DB level for duplicate inserts).
 *     2. Call the underlying provider executor EXACTLY ONCE (the SELECT ... FOR UPDATE
 *        row-level lock in executeConnectorAction.ts enforces this for concurrent runs).
 *     3. Return a successful/cached result to all callers (not an error or duplicate).
 *
 * Test (a) — duplicate idempotency_key insert:
 *   Attempting to insert two connector_actions rows with the SAME idempotency_key must
 *   throw a unique-constraint error. No duplicate row is created.
 *
 * Test (b) — concurrent execute-once:
 *   Two concurrent executeConnectorAction calls with the SAME connectorActionId must
 *   result in exactly one executor invocation. Both callers get a 'completed' result.
 *   (This is the core D2 invariant from execute.db.test.ts; this file adds a focused
 *   regression test with a clear comment so the invariant is easy to audit.)
 *
 * DB-gated: requires a live Postgres at TEST_DATABASE_URL because the exactly-once
 * invariant relies on real SELECT ... FOR UPDATE serialization, which cannot be
 * reproduced by an in-memory fake.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test src/connectors/double-execute.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  approvalRequests,
  connectorAccounts,
  connectorActions,
  drafts,
  users,
} from "@/db/schema";
import {
  DrizzleConnectorActionsRepository,
  executeConnectorAction,
} from "@/connectors/execute";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { SlackDmPayload } from "@/agent/schemas";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const SLACK_PAYLOAD: SlackDmPayload = {
  kind: "slack_dm",
  destination: { kind: "person", nameText: "Regression", emailText: null },
  message: "double-execute regression test message",
  channel: "U_REGRESSION",
  recipientName: "Regression",
  recipientEmail: null,
};

const NOW = new Date("2026-06-13T12:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("D2 — double-execute regression (idempotency contract)", () => {
  // biome-ignore lint: non-null assertion safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // biome-ignore lint/suspicious/noExplicitAny: drizzle concrete type
  const db: any = drizzle(sql, { schema });
  const repo = new DrizzleConnectorActionsRepository(db);

  let userId: string;
  let connectorAccountId: string;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-double-exec-${randomUUID()}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    const [acct] = await db
      .insert(connectorAccounts)
      .values({
        id: randomUUID(),
        userId,
        provider: "slack",
        composioConnectedAccountId: `ca_d2_${randomUUID()}`,
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
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  /** Seed a draft + APPROVED approval + pending connector_action; returns the action id. */
  async function seedApprovedAction(idempotencyKey: string): Promise<string> {
    const [draft] = await db
      .insert(drafts)
      .values({
        id: randomUUID(),
        userId,
        actionKind: "slack_dm",
        payload: SLACK_PAYLOAD as unknown as Record<string, unknown>,
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
      expiresAt: FUTURE,
      decidedAt: NOW,
      decisionChannel: "web_link",
    });

    const action = await repo.createAction({
      userId,
      connectorAccountId,
      kind: "slack_dm",
      payload: SLACK_PAYLOAD,
      idempotencyKey,
      approvalRequestId: approvalId,
      draftId: draft.id,
      now: NOW,
    });
    return action.id;
  }

  it("(a) duplicate idempotency_key insert is REJECTED by the unique constraint — no duplicate row", async () => {
    /**
     * IDEMPOTENCY CONTRACT § 1: the connector_actions table has a UNIQUE index on
     * idempotency_key. A second INSERT with the same key must fail at the DB level,
     * guaranteeing that the same command cannot create two separate action rows even
     * if handle-connector-command.ts is re-invoked (e.g. Inngest at-least-once delivery).
     */
    const key = `regression:dup:${randomUUID()}`;

    // First insert — succeeds.
    const firstId = await seedApprovedAction(key);
    expect(firstId).toBeTruthy();

    // Verify exactly one row with this key exists.
    const rows = await db
      .select({ id: connectorActions.id })
      .from(connectorActions)
      .where(eq(connectorActions.idempotencyKey, key));
    expect(rows).toHaveLength(1);

    // Second insert with the SAME key — must throw (unique constraint violation).
    await expect(
      repo.createAction({
        userId,
        connectorAccountId,
        kind: "slack_dm",
        payload: SLACK_PAYLOAD,
        idempotencyKey: key, // <-- same key
        now: NOW,
      }),
    ).rejects.toThrow();

    // Still exactly one row — the duplicate was rejected.
    const rowsAfter = await db
      .select({ id: connectorActions.id })
      .from(connectorActions)
      .where(eq(connectorActions.idempotencyKey, key));
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].id).toBe(firstId);
  });

  it("(b) two concurrent executeConnectorAction calls call the provider EXACTLY ONCE — both return completed", async () => {
    /**
     * IDEMPOTENCY CONTRACT § 2: executeConnectorAction uses SELECT ... FOR UPDATE on the
     * connector_actions row inside a transaction. This serializes concurrent callers:
     *   - First caller: acquires lock, sees status='pending', flips to 'executing', runs
     *     the executor, commits 'completed'.
     *   - Second caller: blocks on lock, then reads status='completed' → returns cached
     *     result WITHOUT calling the executor.
     * Net result: the provider executor is called EXACTLY ONCE regardless of concurrency.
     */
    const key = `regression:concurrent:${randomUUID()}`;
    const actionId = await seedApprovedAction(key);

    let callCount = 0;
    const fakeExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return {
        successful: true,
        data: { ok: true, ts: "1700000000.000200", channel: "U_REGRESSION" },
        error: null,
      };
    };

    // Fire BOTH concurrently. The FOR UPDATE lock serializes them.
    const [a, b] = await Promise.all([
      executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: actionId, now: NOW }),
      executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: actionId, now: NOW }),
    ]);

    // EXACTLY ONE provider call across both concurrent invocations.
    expect(callCount).toBe(1);

    // Both callers report completed.
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");

    // Exactly one is the fresh run; the other returned the cached result.
    const freshRuns = [a, b].filter((r) => r.status === "completed" && r.cached === false);
    expect(freshRuns).toHaveLength(1);

    // The row is terminal 'completed'.
    const [row] = await db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.id, actionId))
      .limit(1);
    expect(row.status).toBe("completed");
    expect(row.executedAt).not.toBeNull();
  });

  it("(c) a third sequential call after completion returns cached — executor still called exactly once total", async () => {
    /**
     * IDEMPOTENCY CONTRACT § 3: a row in status='completed' is terminal. Any
     * subsequent executeConnectorAction call returns the cached result without
     * calling the executor again.
     */
    const key = `regression:third:${randomUUID()}`;
    const actionId = await seedApprovedAction(key);

    let callCount = 0;
    const fakeExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return {
        successful: true,
        data: { ok: true, ts: "1700000000.000300", channel: "U_REGRESSION" },
        error: null,
      };
    };

    const first = await executeConnectorAction({
      db,
      execute: fakeExecutor,
      connectorActionId: actionId,
      now: NOW,
    });
    expect(first.status).toBe("completed");
    expect(callCount).toBe(1);

    // Second call — cached.
    const second = await executeConnectorAction({
      db,
      execute: fakeExecutor,
      connectorActionId: actionId,
      now: NOW,
    });
    expect(second.status).toBe("completed");
    expect(second.status === "completed" && second.cached).toBe(true);
    // Executor NOT called again.
    expect(callCount).toBe(1);

    // Third call — still cached.
    const third = await executeConnectorAction({
      db,
      execute: fakeExecutor,
      connectorActionId: actionId,
      now: NOW,
    });
    expect(third.status).toBe("completed");
    expect(third.status === "completed" && third.cached).toBe(true);
    expect(callCount).toBe(1);
  });
});
