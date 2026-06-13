import { describe, expect, it } from "vitest";
import type { ConnectedAccountRetrieveResponse } from "@composio/core";
import type { EventMap } from "@/workflows/events";
import type { ConnectorAuditWriter, EmitEvent } from "@/connectors/audit";
import {
  reconnectUrl,
  sweepConnectorStatus,
  type OwnerEmailResolver,
  type SendSystemNotice,
} from "@/workflows/functions/sweep-connector-status";
import {
  FakeConnectorAccountsRepository,
  makeAccountRow,
} from "@/connectors/accounts-repository.test";

const NOW = new Date("2026-06-13T12:00:00Z");
const APP_URL = "https://keeps.email";

function detail(status: string, statusReason: string | null = null): ConnectedAccountRetrieveResponse {
  return { status, statusReason, toolkit: { slug: "slack" } } as unknown as ConnectedAccountRetrieveResponse;
}

class FakeAudit implements ConnectorAuditWriter {
  readonly writes: Array<{ action: string }> = [];
  async writeAudit(input: { action: string }) {
    this.writes.push(input);
  }
}

class FakeOwnerResolver implements OwnerEmailResolver {
  constructor(private readonly email: string | null) {}
  async findOwnerEmail() {
    return this.email;
  }
}

function makeEmitter() {
  const events: Array<{ name: keyof EventMap; data: unknown }> = [];
  const emit: EmitEvent = async (name, data) => {
    events.push({ name, data });
  };
  return { events, emit };
}

function makeNotice() {
  const sent: Array<{ to: string; subject: string; textBody: string }> = [];
  const send: SendSystemNotice = async (n) => {
    sent.push(n);
  };
  return { sent, send };
}

describe("reconnectUrl", () => {
  it("builds the per-provider settings deep link", () => {
    expect(reconnectUrl(APP_URL, "slack")).toBe(
      "https://keeps.email/settings/connectors?connected=slack",
    );
    expect(reconnectUrl(APP_URL, "google_calendar")).toBe(
      "https://keeps.email/settings/connectors?connected=google_calendar",
    );
  });
});

describe("sweepConnectorStatus", () => {
  it("flips a now-EXPIRED account: marks status, emits revoked, sends ONE reconnect email", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const userId = "44444444-4444-4444-4444-444444444444";
    const expiring = makeAccountRow({
      userId,
      provider: "slack",
      status: "active",
      composioConnectedAccountId: "ca_expiring",
    });
    repo.seed(expiring);

    const audit = new FakeAudit();
    const { events, emit } = makeEmitter();
    const { sent, send } = makeNotice();

    const result = await sweepConnectorStatus({
      accountsRepo: repo,
      ownerResolver: new FakeOwnerResolver("owner@acme.com"),
      emitEvent: emit,
      audit,
      sendSystemNotice: send,
      fetchConnectedAccount: async () => detail("EXPIRED", "token expired"),
      appUrl: APP_URL,
      now: NOW,
    });

    expect(result).toEqual({ scanned: 1, flipped: 1, emailed: 1, errored: 0 });
    expect((await repo.findById(expiring.id))?.status).toBe("auth_error");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("connector.revoked");
    expect(audit.writes[0].action).toBe("connector.account_auth_error");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@acme.com");
    expect(sent[0].subject).toContain("Reconnect your Slack");
    expect(sent[0].textBody).toContain(
      "https://keeps.email/settings/connectors?connected=slack",
    );
  });

  it("leaves a still-ACTIVE account untouched (no flip, no email, no event)", async () => {
    const repo = new FakeConnectorAccountsRepository();
    repo.seed(
      makeAccountRow({
        provider: "google_calendar",
        status: "active",
        composioConnectedAccountId: "ca_ok",
      }),
    );
    const audit = new FakeAudit();
    const { events, emit } = makeEmitter();
    const { sent, send } = makeNotice();

    const result = await sweepConnectorStatus({
      accountsRepo: repo,
      ownerResolver: new FakeOwnerResolver("owner@acme.com"),
      emitEvent: emit,
      audit,
      sendSystemNotice: send,
      fetchConnectedAccount: async () => detail("ACTIVE"),
      appUrl: APP_URL,
      now: NOW,
    });

    expect(result).toEqual({ scanned: 1, flipped: 0, emailed: 0, errored: 0 });
    expect(events).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(audit.writes).toHaveLength(0);
  });

  it("flips one and leaves the other in a mixed batch", async () => {
    const repo = new FakeConnectorAccountsRepository();
    repo.seed(makeAccountRow({ status: "active", composioConnectedAccountId: "ca_active" }));
    repo.seed(makeAccountRow({ status: "active", composioConnectedAccountId: "ca_revoked" }));

    const audit = new FakeAudit();
    const { events, emit } = makeEmitter();
    const { sent, send } = makeNotice();

    const result = await sweepConnectorStatus({
      accountsRepo: repo,
      ownerResolver: new FakeOwnerResolver("owner@acme.com"),
      emitEvent: emit,
      audit,
      sendSystemNotice: send,
      fetchConnectedAccount: async (id) =>
        id === "ca_revoked" ? detail("REVOKED", "user revoked") : detail("ACTIVE"),
      appUrl: APP_URL,
      now: NOW,
    });

    expect(result.scanned).toBe(2);
    expect(result.flipped).toBe(1);
    expect(result.emailed).toBe(1);
    expect((await repo.findByComposioAccount("ca_revoked"))?.status).toBe("revoked");
    expect((await repo.findByComposioAccount("ca_active"))?.status).toBe("active");
    expect(audit.writes[0].action).toBe("connector.account_revoked");
  });

  it("counts a Composio fetch failure as errored without aborting the sweep", async () => {
    const repo = new FakeConnectorAccountsRepository();
    repo.seed(makeAccountRow({ status: "active", composioConnectedAccountId: "ca_boom" }));
    repo.seed(makeAccountRow({ status: "active", composioConnectedAccountId: "ca_fine" }));

    const audit = new FakeAudit();
    const { emit } = makeEmitter();
    const { send } = makeNotice();

    const result = await sweepConnectorStatus({
      accountsRepo: repo,
      ownerResolver: new FakeOwnerResolver("owner@acme.com"),
      emitEvent: emit,
      audit,
      sendSystemNotice: send,
      fetchConnectedAccount: async (id) => {
        if (id === "ca_boom") throw new Error("composio 500");
        return detail("ACTIVE");
      },
      appUrl: APP_URL,
      now: NOW,
    });

    expect(result.scanned).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.flipped).toBe(0);
  });
});
