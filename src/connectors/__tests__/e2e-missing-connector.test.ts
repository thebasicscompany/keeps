/**
 * E3 — Missing connector (pure; no DB, no approval ever created).
 *
 * No connector_accounts row for the user's Slack. The flow must stop at step (a):
 * send ONE connect-link email (buildConnectorMissingEmail, containing the
 * /settings/connectors URL), create NO approval, and call the provider executor
 * ZERO times.
 */

import { describe, expect, it } from "vitest";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { ToolExecutor } from "@/connectors/recipient";
import {
  runUpToApproval,
  buildConnectorMissingEmail,
  type CapturedEmail,
  type RunConnectorCommandDeps,
} from "@/connectors/__tests__/e2e-harness";
import { routeConnectorEmail } from "@/connectors/__tests__/e2e-router";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const APP_URL = "https://app.keeps.test";

/** A db that throws if touched — proves the missing-account branch does NO db work. */
const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("E3: the missing-account branch must not touch the database");
    },
  },
) as never;

describe("E3 — missing connector account", () => {
  it("sends ONE connect-link email, creates NO approval, executor called ZERO times", async () => {
    const routed = await routeConnectorEmail({
      body: "@Slack tell Maya the report is ready",
      userId: "00000000-0000-0000-0000-000000000003",
      inboundEmailId: "00000000-0000-0000-0000-0000000000a3",
      now: NOW,
    });

    let recipientCalls = 0;
    const recipientExecutor: ToolExecutor = async () => {
      recipientCalls += 1;
      return { successful: true, data: {}, error: null };
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
      account: null, // ← MISSING connector account.
      ownerEmail: "owner@keeps.test",
      appUrl: APP_URL,
      db: explodingDb,
      recipientExecutor,
      connectorExecutor,
      emails,
      now: NOW,
    };

    const outcome = await runUpToApproval(deps);

    // Stopped at the missing-account branch.
    expect(outcome.branch).toBe("missing_account");

    // EXACTLY ONE email, and it is the connect-link email with the settings URL.
    expect(emails).toHaveLength(1);
    expect(emails[0].template).toBe("connector_missing");
    const expected = buildConnectorMissingEmail({
      provider: "slack",
      commandSummary: "send a Slack message to Maya",
      connectUrl: `${APP_URL}/settings/connectors`,
    });
    expect(emails[0].subject).toBe(expected.subject);
    expect(emails[0].textBody).toBe(expected.textBody);
    expect(emails[0].textBody).toContain(`${APP_URL}/settings/connectors`);

    // No recipient resolution, no execution — the flow never got past (a).
    expect(recipientCalls).toBe(0);
    expect(execCalls).toBe(0);
  });
});
