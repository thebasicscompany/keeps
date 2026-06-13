/**
 * E2 — Idempotent re-delivery (DB-gated; the FOR UPDATE execute-once lock enforces it).
 *
 * Same Slack happy path as E1, but the execute path is driven TWICE (Inngest delivers
 * approval.received at-least-once / a retry re-runs the step). The real connector_actions
 * row lock must ensure the provider executor runs EXACTLY ONCE and exactly ONE row ends
 * 'completed'. The in-memory fake cannot reproduce row-level locking — only real Postgres
 * can serialize the two transactions — so this fixture is DB-gated.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComposioToolResult } from "@/connectors/composio";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { ToolExecutor } from "@/connectors/recipient";
import { executeConnectorAction } from "@/connectors/execute";
import {
  runUpToApproval,
  approveViaDecide,
  type CapturedEmail,
  type RunConnectorCommandDeps,
} from "@/connectors/__tests__/e2e-harness";
import {
  setupE2eDb,
  getConnectorAction,
  countCompletedActions,
  TEST_DATABASE_URL,
  type E2eDb,
} from "@/connectors/__tests__/e2e-db";
import { routeConnectorEmail } from "@/connectors/__tests__/e2e-router";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const APP_URL = "https://app.keeps.test";

describe.skipIf(!TEST_DATABASE_URL)("E2 — idempotent re-delivery (execute-once)", () => {
  let h: E2eDb;

  beforeAll(async () => {
    h = await setupE2eDb({ provider: "slack" });
  });
  afterAll(async () => {
    await h.teardown();
  });

  it("driving execute TWICE runs the provider EXACTLY ONCE and leaves ONE completed row", async () => {
    const routed = await routeConnectorEmail({
      body: "@Slack tell Maya I'll send the deck Friday",
      userId: h.userId,
      inboundEmailId: h.inboundEmailId,
      now: NOW,
    });

    const recipientExecutor: ToolExecutor = async (slug): Promise<ComposioToolResult> => {
      if (slug === "SLACK_LIST_ALL_USERS") {
        return {
          successful: true,
          data: { members: [{ id: "U_MAYA", real_name: "Maya", profile: { real_name: "Maya", display_name: "Maya", email: null } }] },
          error: null,
        };
      }
      return { successful: false, data: {}, error: "users_not_found" };
    };

    let callCount = 0;
    const connectorExecutor: ConnectorExecutor = async () => {
      callCount += 1;
      return { successful: true, data: { ok: true, ts: "1718000000.000200", channel: "U_MAYA" }, error: null };
    };

    const emails: CapturedEmail[] = [];
    const deps: RunConnectorCommandDeps = {
      command: routed.command,
      userId: h.userId,
      inboundEmailId: routed.inboundEmailId,
      account: h.account,
      ownerEmail: "owner@keeps.test",
      appUrl: APP_URL,
      db: h.db,
      recipientExecutor,
      connectorExecutor,
      emails,
      now: NOW,
    };

    const outcome = await runUpToApproval(deps);
    if (outcome.branch !== "awaiting_decision") throw new Error("expected awaiting_decision");

    // Still exactly one approval email before any execution.
    expect(emails).toHaveLength(1);
    expect(emails[0].template).toBe("connector_approval");

    await approveViaDecide(h.db, outcome.approvalId, NOW);

    // ── Drive the execute path TWICE (re-delivery / retry). Fire concurrently so the
    // FOR UPDATE lock is the only thing that can serialize them.
    const [a, b] = await Promise.all([
      executeConnectorAction({ db: h.db, execute: connectorExecutor, connectorActionId: outcome.connectorActionId, now: NOW }),
      executeConnectorAction({ db: h.db, execute: connectorExecutor, connectorActionId: outcome.connectorActionId, now: NOW }),
    ]);

    // EXACTLY ONE provider call across both deliveries.
    expect(callCount).toBe(1);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    // Exactly one of the two is the fresh run; the other returned the cached result.
    const fresh = [a, b].filter((r) => r.status === "completed" && r.cached === false);
    expect(fresh).toHaveLength(1);

    // A THIRD sequential delivery still does not re-execute.
    const third = await executeConnectorAction({
      db: h.db,
      execute: connectorExecutor,
      connectorActionId: outcome.connectorActionId,
      now: NOW,
    });
    expect(third.status).toBe("completed");
    expect(third.status === "completed" && third.cached).toBe(true);
    expect(callCount).toBe(1);

    // Exactly ONE connector_actions row for this user, and it is 'completed'.
    const row = await getConnectorAction(h.db, outcome.connectorActionId);
    expect(row.status).toBe("completed");
    expect(await countCompletedActions(h.db, h.userId)).toBe(1);
  });
});
