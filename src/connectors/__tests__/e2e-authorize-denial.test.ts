/**
 * E6 — Authorize denial (DB-gated; AR-7 gate denies a stale approved grant).
 *
 * A connector_actions row whose approval is EXPIRED (now is past expiresAt). Driving
 * executeConnectorAction must:
 *   - leave the row 'failed' with error.code 'approval_expired',
 *   - call the provider executor ZERO times,
 *   - write a policy.authorize_denied audit row.
 *
 * This exercises the security boundary directly: even an 'approved' approval does not
 * authorize once expired — authorize() reads the LIVE row inside the execute-once
 * transaction (never the cached event). Mirrors execute.db.test.ts's denial seeding,
 * and additionally asserts the audit row (the orchestrator-facing requirement).
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRequests, drafts } from "@/db/schema";
import { executeConnectorAction, DrizzleConnectorActionsRepository } from "@/connectors/execute";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { SlackDmPayload } from "@/agent/schemas";
import { setupE2eDb, countAudit, getConnectorAction, TEST_DATABASE_URL, type E2eDb } from "@/connectors/__tests__/e2e-db";

const NOW_PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-13T12:00:00.000Z");

const SLACK_PAYLOAD: SlackDmPayload = {
  kind: "slack_dm",
  destination: { kind: "person", nameText: "Maya", emailText: null },
  message: "I'll send the deck Friday",
  channel: "U_MAYA",
  recipientName: "Maya",
  recipientEmail: null,
};

describe.skipIf(!TEST_DATABASE_URL)("E6 — authorize denial (expired approval)", () => {
  let h: E2eDb;

  beforeAll(async () => {
    h = await setupE2eDb({ provider: "slack" });
  });
  afterAll(async () => {
    await h.teardown();
  });

  it("expired approval → row 'failed' (approval_expired), ZERO executor calls, policy.authorize_denied audit", async () => {
    // Seed: draft + APPROVED approval that has ALREADY EXPIRED + pending connector_action.
    const [draft] = await h.db
      .insert(drafts)
      .values({
        id: randomUUID(),
        userId: h.userId,
        actionKind: "slack_dm",
        payload: SLACK_PAYLOAD as unknown as Record<string, unknown>,
      })
      .returning();

    const approvalId = randomUUID();
    await h.db.insert(approvalRequests).values({
      id: approvalId,
      userId: h.userId,
      draftId: draft.id,
      actionKind: "slack_dm",
      status: "approved", // approved, but...
      tokenHash: `hash_${approvalId}`,
      expiresAt: NOW_PAST, // ...expired in the past → stale grant.
      decidedAt: NOW_PAST,
      decisionChannel: "web_link",
    });

    const repo = new DrizzleConnectorActionsRepository(h.db);
    const action = await repo.createAction({
      userId: h.userId,
      connectorAccountId: h.connectorAccountId,
      kind: "slack_dm",
      payload: SLACK_PAYLOAD,
      idempotencyKey: `connector:slack:${approvalId}`,
      approvalRequestId: approvalId,
      draftId: draft.id,
      inboundEmailId: h.inboundEmailId,
      now: NOW,
    });

    const auditBefore = await countAudit(h.db, h.userId, "policy.authorize_denied");

    let execCalls = 0;
    const connectorExecutor: ConnectorExecutor = async () => {
      execCalls += 1;
      return { successful: true, data: {}, error: null };
    };

    // now (June) is AFTER expiresAt (January) → authorize() denies the stale grant.
    const result = await executeConnectorAction({
      db: h.db,
      execute: connectorExecutor,
      connectorActionId: action.id,
      now: NOW,
    });

    expect(result.status).toBe("denied");
    expect(result.status === "denied" && result.error.code).toBe("approval_expired");

    // Provider NEVER called.
    expect(execCalls).toBe(0);

    // The row is terminal 'failed' with the structured error.
    const row = await getConnectorAction(h.db, action.id);
    expect(row.status).toBe("failed");
    expect((row.error as { code?: string }).code).toBe("approval_expired");
    expect(row.failedAt).not.toBeNull();

    // A policy.authorize_denied audit row was written inside the same transaction.
    const auditAfter = await countAudit(h.db, h.userId, "policy.authorize_denied");
    expect(auditAfter).toBe(auditBefore + 1);

    // And re-driving it does NOT execute (committed 'failed' short-circuits the retry).
    const second = await executeConnectorAction({
      db: h.db,
      execute: connectorExecutor,
      connectorActionId: action.id,
      now: NOW,
    });
    expect(second.status).toBe("failed");
    expect(execCalls).toBe(0);
    // cleanup of the extra approvalRequests/drafts rows happens via teardown (by userId).
  });
});
