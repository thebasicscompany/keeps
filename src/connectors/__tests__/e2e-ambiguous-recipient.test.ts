/**
 * E4 — Ambiguous recipient (pure; the two-Mayas safety gate — the most important block).
 *
 * "@Slack ping Alex ..." where the recipient resolver returns TWO Alexes. The flow MUST
 * stop at step (b): send ONE clarification email (buildConnectorAmbiguousEmail, listing
 * both candidates with 1-indexed ordinals), create NO approval_request, create NO
 * connector_actions row, and call the provider executor ZERO times.
 *
 * The db is an exploding proxy: reaching createApprovalAndAction would touch it and fail
 * the test, so this directly proves the ambiguity gate BLOCKS approval entirely.
 */

import { describe, expect, it } from "vitest";
import type { ComposioToolResult } from "@/connectors/composio";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { ToolExecutor } from "@/connectors/recipient";
import {
  runUpToApproval,
  buildConnectorAmbiguousEmail,
  type CapturedEmail,
  type RunConnectorCommandDeps,
} from "@/connectors/__tests__/e2e-harness";
import { routeConnectorEmail } from "@/connectors/__tests__/e2e-router";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const APP_URL = "https://app.keeps.test";

const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("E4: an ambiguous recipient must NEVER reach approval/db creation");
    },
  },
) as never;

const slackAccount = {
  id: "11111111-1111-1111-1111-111111111111",
  userId: "00000000-0000-0000-0000-000000000004",
  provider: "slack",
  composioConnectedAccountId: "ca_e4",
  composioEntityId: "00000000-0000-0000-0000-000000000004",
  externalAccountEmail: null,
  externalAccountLabel: null,
  scopes: [],
  status: "active",
  statusReason: null,
  metadata: {},
  connectedAt: NOW,
  lastUsedAt: null,
  disconnectedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} as never;

describe("E4 — ambiguous recipient blocks approval", () => {
  it("sends ONE clarification email, NO approval, NO action row, executor ZERO times", async () => {
    const routed = await routeConnectorEmail({
      body: "@Slack ping Alex about the renewal",
      userId: "00000000-0000-0000-0000-000000000004",
      inboundEmailId: "00000000-0000-0000-0000-0000000000a4",
      now: NOW,
    });
    expect(routed.command.destination.nameText).toBe("Alex");

    // The resolver finds TWO Alexes.
    const recipientExecutor: ToolExecutor = async (slug): Promise<ComposioToolResult> => {
      if (slug === "SLACK_LIST_ALL_USERS") {
        return {
          successful: true,
          data: {
            members: [
              { id: "U_ALEX1", real_name: "Alex", profile: { real_name: "Alex", display_name: "Alex", email: "alex.kim@x.com" } },
              { id: "U_ALEX2", real_name: "Alex", profile: { real_name: "Alex", display_name: "Alex", email: "alex.ng@x.com" } },
            ],
          },
          error: null,
        };
      }
      return { successful: false, data: {}, error: "users_not_found" };
    };

    let execCalls = 0;
    const connectorExecutor: ConnectorExecutor = async () => {
      execCalls += 1;
      return { successful: true, data: {}, error: null };
    };

    const emails: CapturedEmail[] = [];
    const deps: RunConnectorCommandDeps = {
      command: routed.command,
      userId: routed.userId,
      inboundEmailId: routed.inboundEmailId,
      account: slackAccount,
      ownerEmail: "owner@keeps.test",
      appUrl: APP_URL,
      db: explodingDb, // touching the db (creating an approval) would throw → test fails.
      recipientExecutor,
      connectorExecutor,
      emails,
      now: NOW,
    };

    const outcome = await runUpToApproval(deps);

    // Blocked at the ambiguity gate — NO approval created (the exploding db was never touched).
    expect(outcome.branch).toBe("recipient_ambiguous");

    // EXACTLY ONE email, the clarification, listing BOTH candidates with ordinals.
    expect(emails).toHaveLength(1);
    expect(emails[0].template).toBe("connector_ambiguous");
    const expected = buildConnectorAmbiguousEmail({
      recipientNameText: "Alex",
      candidates: [
        { name: "Alex", email: "alex.kim@x.com" },
        { name: "Alex", email: "alex.ng@x.com" },
      ],
      commandSummary: "send a Slack message to Alex",
    });
    expect(emails[0].subject).toBe(expected.subject);
    expect(emails[0].textBody).toBe(expected.textBody);
    // Ordinals + both emails present.
    expect(emails[0].textBody).toContain("1. Alex (alex.kim@x.com)");
    expect(emails[0].textBody).toContain("2. Alex (alex.ng@x.com)");

    // Provider NEVER called.
    expect(execCalls).toBe(0);
  });
});
