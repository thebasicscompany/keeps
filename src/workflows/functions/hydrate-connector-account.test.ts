import { describe, expect, it } from "vitest";
import type { ConnectedAccountRetrieveResponse } from "@composio/core";
import {
  extractAccountFields,
  hydrateConnectorAccount,
} from "@/workflows/functions/hydrate-connector-account";
import {
  FakeConnectorAccountsRepository,
  makeAccountRow,
} from "@/connectors/accounts-repository.test";

const NOW = new Date("2026-06-13T12:00:00Z");

/** Build a loosely-typed connected-account detail (we cast through the SDK type). */
function detail(partial: Record<string, unknown>): ConnectedAccountRetrieveResponse {
  return partial as unknown as ConnectedAccountRetrieveResponse;
}

describe("extractAccountFields", () => {
  it("pulls slack email/label/scopes/workspace_id from the state bag", () => {
    const fields = extractAccountFields(
      detail({
        toolkit: { slug: "slack" },
        state: {
          email: "founder@acme.com",
          team_name: "Acme HQ",
          requested_scopes: ["chat:write", "users:read"],
          team_id: "T123",
        },
      }),
      "slack",
    );
    expect(fields.externalAccountEmail).toBe("founder@acme.com");
    expect(fields.externalAccountLabel).toBe("Acme HQ");
    expect(fields.scopes).toEqual(["chat:write", "users:read"]);
    expect(fields.metadata).toEqual({ workspace_id: "T123" });
  });

  it("pulls google primary_calendar_id and splits a space-delimited scope string", () => {
    const fields = extractAccountFields(
      detail({
        toolkit: { slug: "googlecalendar" },
        data: {
          user_email: "me@gmail.com",
          scope: "calendar.events calendar.readonly",
          primary_calendar_id: "me@gmail.com",
        },
      }),
      "google_calendar",
    );
    expect(fields.externalAccountEmail).toBe("me@gmail.com");
    expect(fields.scopes).toEqual(["calendar.events", "calendar.readonly"]);
    expect(fields.metadata).toEqual({ primary_calendar_id: "me@gmail.com" });
  });

  it("never throws on a sparse detail — returns null/[]/{} fallbacks", () => {
    const fields = extractAccountFields(detail({ toolkit: { slug: "slack" } }), "slack");
    expect(fields).toEqual({
      externalAccountEmail: null,
      externalAccountLabel: null,
      scopes: [],
      metadata: {},
    });
  });
});

describe("hydrateConnectorAccount", () => {
  it("writes the extracted fields onto the row and is idempotent", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const row = makeAccountRow({
      composioConnectedAccountId: "ca_h",
      provider: "slack",
      status: "active",
    });
    repo.seed(row);

    const fetchConnectedAccount = async () =>
      detail({
        toolkit: { slug: "slack" },
        state: {
          email: "x@y.com",
          team_name: "Team Y",
          requested_scopes: ["chat:write"],
          team_id: "T9",
        },
      });

    const run = () =>
      hydrateConnectorAccount({
        connectorAccountId: row.id,
        composioConnectedAccountId: row.composioConnectedAccountId,
        provider: "slack",
        accountsRepo: repo,
        fetchConnectedAccount,
        now: NOW,
      });

    const first = await run();
    expect(first.status).toBe("hydrated");
    const afterFirst = await repo.findById(row.id);
    expect(afterFirst?.externalAccountEmail).toBe("x@y.com");
    expect(afterFirst?.externalAccountLabel).toBe("Team Y");
    expect(afterFirst?.scopes).toEqual(["chat:write"]);
    expect(afterFirst?.metadata).toEqual({ workspace_id: "T9" });

    // Re-running writes the same fields (idempotent).
    await run();
    const afterSecond = await repo.findById(row.id);
    expect(afterSecond?.externalAccountEmail).toBe("x@y.com");
    expect(afterSecond?.scopes).toEqual(["chat:write"]);
  });

  it("returns not_found when the row is gone", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const result = await hydrateConnectorAccount({
      connectorAccountId: "missing",
      composioConnectedAccountId: "ca_missing",
      provider: "slack",
      accountsRepo: repo,
      fetchConnectedAccount: async () => detail({ toolkit: { slug: "slack" } }),
      now: NOW,
    });
    expect(result.status).toBe("not_found");
  });
});
