/**
 * app/settings/connectors/page.test.ts
 *
 * Unit tests for connectorCardViewModel — the pure presentational function
 * extracted from the server component. No DOM rendering, no Clerk, no DB.
 *
 * Three states per provider × two providers = six cases, plus edge cases
 * for status_reason and identity label fallback.
 */

import { describe, expect, it } from "vitest";
import {
  connectorCardViewModel,
  type ConnectorCardViewModel,
} from "./page";
import type { ConnectorAccount } from "@/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ACCOUNT: ConnectorAccount = {
  id: "ca-uuid-1",
  userId: "user-uuid-1",
  provider: "slack",
  composioConnectedAccountId: "ca_TEST",
  composioEntityId: "entity_TEST",
  externalAccountEmail: null,
  externalAccountLabel: null,
  scopes: [],
  status: "active",
  statusReason: null,
  metadata: {},
  connectedAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: null,
  disconnectedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function makeAccount(
  overrides: Partial<ConnectorAccount>,
): ConnectorAccount {
  return { ...BASE_ACCOUNT, ...overrides };
}

function actionKinds(vm: ConnectorCardViewModel): string[] {
  return vm.actions.map((a) => a.kind);
}

// ---------------------------------------------------------------------------
// Slack — no account / disabled
// ---------------------------------------------------------------------------

describe("connectorCardViewModel — Slack — not connected", () => {
  it("returns 'Not connected' when account is null", () => {
    const vm = connectorCardViewModel("slack", null);
    expect(vm.statusText).toBe("Not connected");
    expect(vm.statusVariant).toBe("none");
    expect(actionKinds(vm)).toEqual(["connect"]);
  });

  it("returns 'Not connected' when account.status is 'disabled'", () => {
    const vm = connectorCardViewModel(
      "slack",
      makeAccount({ status: "disabled" }),
    );
    expect(vm.statusText).toBe("Not connected");
    expect(vm.statusVariant).toBe("none");
    expect(actionKinds(vm)).toEqual(["connect"]);
  });

  it("labels the provider correctly", () => {
    const vm = connectorCardViewModel("slack", null);
    expect(vm.label).toBe("Slack");
    expect(vm.provider).toBe("slack");
  });
});

// ---------------------------------------------------------------------------
// Slack — active
// ---------------------------------------------------------------------------

describe("connectorCardViewModel — Slack — active", () => {
  it("returns 'Connected as <email>' when externalAccountEmail is set", () => {
    const vm = connectorCardViewModel(
      "slack",
      makeAccount({
        status: "active",
        externalAccountEmail: "arav@company.com",
      }),
    );
    expect(vm.statusText).toBe("Connected as arav@company.com");
    expect(vm.statusVariant).toBe("active");
    expect(actionKinds(vm)).toEqual(["disconnect"]);
  });

  it("falls back to externalAccountLabel when email is null", () => {
    const vm = connectorCardViewModel(
      "slack",
      makeAccount({
        status: "active",
        externalAccountEmail: null,
        externalAccountLabel: "Acme Workspace",
      }),
    );
    expect(vm.statusText).toBe("Connected as Acme Workspace");
    expect(vm.statusVariant).toBe("active");
  });

  it("returns 'Connected' when both email and label are null", () => {
    const vm = connectorCardViewModel(
      "slack",
      makeAccount({
        status: "active",
        externalAccountEmail: null,
        externalAccountLabel: null,
      }),
    );
    expect(vm.statusText).toBe("Connected");
    expect(vm.statusVariant).toBe("active");
  });

  it("only shows Disconnect button when active", () => {
    const vm = connectorCardViewModel(
      "slack",
      makeAccount({ status: "active" }),
    );
    expect(actionKinds(vm)).toEqual(["disconnect"]);
    expect(actionKinds(vm)).not.toContain("connect");
    expect(actionKinds(vm)).not.toContain("reconnect");
  });
});

// ---------------------------------------------------------------------------
// Google Calendar — revoked / auth_error
// ---------------------------------------------------------------------------

describe("connectorCardViewModel — Google Calendar — revoked", () => {
  it("returns 'Needs reconnect' for status=revoked", () => {
    const vm = connectorCardViewModel(
      "google_calendar",
      makeAccount({ provider: "google_calendar", status: "revoked" }),
    );
    expect(vm.statusText).toBe("Needs reconnect");
    expect(vm.statusVariant).toBe("error");
    expect(actionKinds(vm)).toContain("reconnect");
    expect(actionKinds(vm)).toContain("disconnect");
    expect(actionKinds(vm)).not.toContain("connect");
  });

  it("returns 'Needs reconnect' for status=auth_error", () => {
    const vm = connectorCardViewModel(
      "google_calendar",
      makeAccount({ provider: "google_calendar", status: "auth_error" }),
    );
    expect(vm.statusText).toBe("Needs reconnect");
    expect(vm.statusVariant).toBe("error");
    expect(actionKinds(vm)).toEqual(["reconnect", "disconnect"]);
  });

  it("labels the provider correctly", () => {
    const vm = connectorCardViewModel("google_calendar", null);
    expect(vm.label).toBe("Google Calendar");
    expect(vm.provider).toBe("google_calendar");
  });
});

// ---------------------------------------------------------------------------
// Error state with status_reason
// ---------------------------------------------------------------------------

describe("connectorCardViewModel — error state", () => {
  it("shows 'Error (<reason>)' for an unrecognised status", () => {
    // Cast to any to simulate an unexpected status value from DB
    const account = makeAccount({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: "unknown_status" as any,
      statusReason: "token_exchange_failed",
    });
    const vm = connectorCardViewModel("slack", account);
    expect(vm.statusText).toBe("Error (token_exchange_failed)");
    expect(vm.statusVariant).toBe("error");
    expect(actionKinds(vm)).toEqual(["reconnect", "disconnect"]);
  });

  it("falls back to status value when statusReason is null", () => {
    const account = makeAccount({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: "broken" as any,
      statusReason: null,
    });
    const vm = connectorCardViewModel("slack", account);
    expect(vm.statusText).toBe("Error (broken)");
  });
});

// ---------------------------------------------------------------------------
// Symmetry: both providers always return a valid shape
// ---------------------------------------------------------------------------

describe("connectorCardViewModel — shape invariants", () => {
  const providers = ["slack", "google_calendar"] as const;
  const statuses = ["active", "disabled", "revoked", "auth_error"] as const;

  for (const provider of providers) {
    for (const status of statuses) {
      it(`${provider}/${status} returns a non-empty actions array`, () => {
        const vm = connectorCardViewModel(
          provider,
          makeAccount({ provider, status }),
        );
        expect(vm.actions.length).toBeGreaterThan(0);
        expect(vm.statusText.length).toBeGreaterThan(0);
      });
    }
  }
});
