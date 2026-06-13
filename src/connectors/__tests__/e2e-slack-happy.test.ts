/**
 * E1 — Slack happy path (DB-gated, exercises the real execute-once lock).
 *
 * Inbound "@Slack tell Maya I'll send the deck Friday" → Maya resolves to exactly one
 * Slack user → frozen payload carries the resolved channel + verbatim message → ONE
 * connector approval email → approve → the provider executor runs EXACTLY ONCE with
 * SLACK_SEND_MESSAGE { channel:<resolved id>, markdown_text:"I'll send the deck Friday" }
 * → the connector_actions row is 'completed'.
 *
 * THE CRITICAL ASSERTION: exactly ONE outbound email, and it is the connector approval
 * email — NOT a second generic handle-approval email. A second/generic email would mean
 * the approval.requested suppression regressed (the connector workflow owns the lifecycle).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComposioToolResult } from "@/connectors/composio";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { ToolExecutor } from "@/connectors/recipient";
import {
  runUpToApproval,
  executeAndConfirm,
  approveViaDecide,
  type CapturedEmail,
  type RunConnectorCommandDeps,
} from "@/connectors/__tests__/e2e-harness";
import { setupE2eDb, getConnectorAction, TEST_DATABASE_URL, type E2eDb } from "@/connectors/__tests__/e2e-db";
import { routeConnectorEmail } from "@/connectors/__tests__/e2e-router";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const APP_URL = "https://app.keeps.test";

describe.skipIf(!TEST_DATABASE_URL)("E1 — Slack happy path (end-to-end, execute-once)", () => {
  let h: E2eDb;

  beforeAll(async () => {
    h = await setupE2eDb({ provider: "slack" });
  });
  afterAll(async () => {
    await h.teardown();
  });

  it("one approval email, frozen channel+message, executor called EXACTLY ONCE, row completed", async () => {
    // ── email arrives → router → parsed command (real deterministic parser).
    const routed = await routeConnectorEmail({
      body: "@Slack tell Maya I'll send the deck Friday",
      userId: h.userId,
      inboundEmailId: h.inboundEmailId,
      now: NOW,
    });
    expect(routed.kind).toBe("slack_dm");
    expect(routed.provider).toBe("slack");
    // The router itself sends NO nudge (the connector workflow owns all replies).
    expect(routed.nudgeId).toBeNull();
    // Parser extracted the recipient + verbatim message.
    expect(routed.command.destination.nameText).toBe("Maya");
    expect(routed.command.message).toBe("I'll send the deck Friday");

    // Recipient resolver: exactly ONE Maya in the workspace.
    let listCalls = 0;
    const recipientExecutor: ToolExecutor = async (slug): Promise<ComposioToolResult> => {
      if (slug === "SLACK_LIST_ALL_USERS") {
        listCalls += 1;
        return {
          successful: true,
          data: { members: [{ id: "U_MAYA", real_name: "Maya", profile: { real_name: "Maya", display_name: "Maya", email: "maya@x.com" } }] },
          error: null,
        };
      }
      return { successful: false, data: {}, error: "users_not_found" };
    };

    // Provider executor (the live action) — records the call so we prove exactly-once.
    const calls: { slug: string; arguments: Record<string, unknown> }[] = [];
    const connectorExecutor: ConnectorExecutor = async (slug, params) => {
      calls.push({ slug, arguments: params.arguments });
      return { successful: true, data: { ok: true, ts: "1718000000.000100", channel: "U_MAYA" }, error: null };
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
    expect(outcome.branch).toBe("awaiting_decision");
    if (outcome.branch !== "awaiting_decision") throw new Error("unreachable");

    expect(listCalls).toBe(1);

    // ── FROZEN PAYLOAD: resolved channel + verbatim message.
    expect(outcome.payload.kind).toBe("slack_dm");
    if (outcome.payload.kind === "slack_dm") {
      expect(outcome.payload.channel).toBe("U_MAYA");
      expect(outcome.payload.message).toBe("I'll send the deck Friday");
      expect(outcome.payload.recipientName).toBe("Maya");
    }
    // slack_dm is irreversible → hard approval.
    expect(outcome.reversibility).toBe("irreversible");

    // ── CRITICAL: EXACTLY ONE outbound email so far, and it is the connector approval.
    expect(emails).toHaveLength(1);
    expect(emails[0].template).toBe("connector_approval");
    expect(emails[0].subject).toBe("Approval needed: Slack message to Maya");
    expect(emails[0].textBody).toContain("I'll send the deck Friday");
    // The execute action has NOT happened yet (still awaiting decision).
    expect(calls).toHaveLength(0);

    // ── approve → execute-once → confirm.
    await approveViaDecide(h.db, outcome.approvalId, NOW);
    const executed = await executeAndConfirm(deps, outcome.connectorActionId);

    expect(executed.status).toBe("completed");

    // EXACTLY ONE provider call, with the frozen args.
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe("SLACK_SEND_MESSAGE");
    expect(calls[0].arguments).toEqual({ channel: "U_MAYA", markdown_text: "I'll send the deck Friday" });

    // The connector_actions row is terminal 'completed' with executedAt set.
    const row = await getConnectorAction(h.db, outcome.connectorActionId);
    expect(row.status).toBe("completed");
    expect(row.executedAt).not.toBeNull();

    // Total emails over the whole flow: the approval email + the execution confirmation.
    // NO generic approval email ever appeared.
    expect(emails.map((e) => e.template)).toEqual(["connector_approval", "execution_confirm"]);
    expect(emails.some((e) => e.template === "generic_approval")).toBe(false);
  });
});
