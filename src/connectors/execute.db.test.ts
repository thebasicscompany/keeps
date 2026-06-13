/**
 * DB-gated integration tests for the connector EXECUTE-ONCE layer (D2).
 *
 * These are the load-bearing tests for the exactly-once invariant. The in-memory
 * fake cannot reproduce row-level FOR UPDATE locking — only a real Postgres can
 * serialize two concurrent transactions on the same connector_actions row. So this
 * file seeds real rows and invokes executeConnectorAction TWICE CONCURRENTLY,
 * asserting the injected executor ran EXACTLY ONCE.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  approvalRequests,
  auditLog,
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

describe.skipIf(!TEST_DATABASE_URL)("executeConnectorAction (DB integration — exactly-once)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrizzleConnectorActionsRepository(db as any);

  let userId: string;
  let connectorAccountId: string;
  const NOW = new Date("2026-06-13T12:00:00.000Z");
  const FUTURE = new Date("2026-12-31T00:00:00.000Z");
  const PAST = new Date("2026-01-01T00:00:00.000Z");

  const SLACK_PAYLOAD: SlackDmPayload = {
    kind: "slack_dm",
    destination: { kind: "person", nameText: "Maya", emailText: null },
    message: "hi from the exactly-once test",
    channel: "U_MAYA",
    recipientName: "Maya",
    recipientEmail: null,
  };

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-exec-once-${Date.now()}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    const [acct] = await db
      .insert(connectorAccounts)
      .values({
        id: randomUUID(),
        userId,
        provider: "slack",
        composioConnectedAccountId: `ca_exec_${Date.now()}`,
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
    await db.delete(auditLog).where(eq(auditLog.userId, userId));
    await db.delete(users).where(inArray(users.id, [userId]));
    await sql.end();
  });

  /** Seed a draft + APPROVED approval + pending connector_action; returns the action id. */
  async function seedApprovedAction(opts: { expiresAt: Date }): Promise<string> {
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
      expiresAt: opts.expiresAt,
      decidedAt: NOW,
      decisionChannel: "web_link",
    });

    const action = await repo.createAction({
      userId,
      connectorAccountId,
      kind: "slack_dm",
      payload: SLACK_PAYLOAD,
      idempotencyKey: `connector:slack:${approvalId}`,
      approvalRequestId: approvalId,
      draftId: draft.id,
      now: NOW,
    });
    return action.id;
  }

  it("two concurrent invocations execute the provider EXACTLY ONCE and leave one completed row", async () => {
    const actionId = await seedApprovedAction({ expiresAt: FUTURE });

    let callCount = 0;
    const fakeExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return {
        successful: true,
        data: { ok: true, ts: "1700000000.000100", channel: "U_MAYA" },
        error: null,
      };
    };

    // Fire BOTH at once. FOR UPDATE serializes them: one runs the executor and commits
    // 'completed'; the other blocks on the lock, then reads 'completed' → cached, no run.
    const [a, b] = await Promise.all([
      executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: actionId, now: NOW }),
      executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: actionId, now: NOW }),
    ]);

    // EXACTLY ONE provider call across both concurrent invocations.
    expect(callCount).toBe(1);

    // Both report completed; exactly one is the fresh (cached:false) run.
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    const fresh = [a, b].filter((r) => r.status === "completed" && r.cached === false);
    expect(fresh).toHaveLength(1);

    // The row is terminal 'completed' with executedAt set.
    const [row] = await db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.id, actionId))
      .limit(1);
    expect(row.status).toBe("completed");
    expect(row.executedAt).not.toBeNull();
    expect((row.result as { ts?: string }).ts).toBe("1700000000.000100");
  });

  it("a third invocation after completion returns the cached result without executing", async () => {
    const actionId = await seedApprovedAction({ expiresAt: FUTURE });

    let callCount = 0;
    const fakeExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return { successful: true, data: { ok: true, ts: "1.2", channel: "U_MAYA" }, error: null };
    };

    const first = await executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: actionId, now: NOW });
    expect(first.status).toBe("completed");
    expect(callCount).toBe(1);

    const second = await executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: actionId, now: NOW });
    expect(second.status).toBe("completed");
    expect(second.status === "completed" && second.cached).toBe(true);
    // Still exactly one execution.
    expect(callCount).toBe(1);
  });

  it("DENIAL: an EXPIRED approval fails the action with ZERO executor calls", async () => {
    const actionId = await seedApprovedAction({ expiresAt: PAST });

    let callCount = 0;
    const fakeExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return { successful: true, data: {}, error: null };
    };

    const result = await executeConnectorAction({
      db,
      execute: fakeExecutor,
      connectorActionId: actionId,
      // now is AFTER expiresAt — authorize() must return denied (stale grant).
      now: new Date("2026-06-13T12:00:00.000Z"),
    });

    expect(result.status).toBe("denied");
    expect(result.status === "denied" && result.error.code).toBe("approval_expired");
    // The provider was NEVER called.
    expect(callCount).toBe(0);

    const [row] = await db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.id, actionId))
      .limit(1);
    expect(row.status).toBe("failed");
    expect((row.error as { code?: string }).code).toBe("approval_expired");
  });

  it("DENIAL: a PENDING (undecided) approval fails the action with ZERO executor calls", async () => {
    // Seed an action whose approval is still pending (not approved).
    const [draft] = await db
      .insert(drafts)
      .values({ id: randomUUID(), userId, actionKind: "slack_dm", payload: SLACK_PAYLOAD as unknown as Record<string, unknown> })
      .returning({ id: drafts.id });
    const approvalId = randomUUID();
    await db.insert(approvalRequests).values({
      id: approvalId,
      userId,
      draftId: draft.id,
      actionKind: "slack_dm",
      status: "pending",
      tokenHash: `hash_${approvalId}`,
      expiresAt: FUTURE,
    });
    const action = await repo.createAction({
      userId,
      connectorAccountId,
      kind: "slack_dm",
      payload: SLACK_PAYLOAD,
      idempotencyKey: `connector:slack:${approvalId}`,
      approvalRequestId: approvalId,
      draftId: draft.id,
      now: NOW,
    });

    let callCount = 0;
    const fakeExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return { successful: true, data: {}, error: null };
    };

    const result = await executeConnectorAction({ db, execute: fakeExecutor, connectorActionId: action.id, now: NOW });
    expect(result.status).toBe("denied");
    expect(callCount).toBe(0);
  });
});
