import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EventMap } from "@/workflows/events";
import { verifyComposioWebhookSignature } from "@/connectors/composio";
import type { ConnectorAuditWriter, EmitEvent } from "@/connectors/audit";
import {
  classifyLifecycle,
  handleComposioWebhookEvent,
  parseComposioWebhook,
  providerFromToolkitSlug,
  type ParsedWebhookEvent,
} from "./route";
import {
  FakeConnectorAccountsRepository,
  makeAccountRow,
} from "@/connectors/accounts-repository.test";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAudit implements ConnectorAuditWriter {
  readonly writes: Array<{ action: string; userId: string | null; metadata: Record<string, unknown> }> = [];
  async writeAudit(input: { action: string; userId: string | null; metadata: Record<string, unknown> }) {
    this.writes.push(input);
  }
}

function makeEmitter() {
  const events: Array<{ name: keyof EventMap; data: unknown }> = [];
  const emit: EmitEvent = async (name, data) => {
    events.push({ name, data });
  };
  return { events, emit };
}

const NOW = new Date("2026-06-13T12:00:00Z");

// ---------------------------------------------------------------------------
// Signature verification — pass / fail.
// ---------------------------------------------------------------------------

const SECRET = "whsec_dGVzdHNlY3JldA=="; // "testsecret" base64

function signed(body: string, secret = SECRET, ts = String(Math.floor(NOW.getTime() / 1000))) {
  const id = "msg_1";
  // Composio HMACs the secret string verbatim (no whsec_ strip / base64 decode).
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${sig}`,
    },
  };
}

describe("verifyComposioWebhookSignature (webhook route guard)", () => {
  it("accepts a correctly-signed payload", () => {
    const body = JSON.stringify({ type: "composio.connected_account.active" });
    const { headers } = signed(body);
    const result = verifyComposioWebhookSignature({
      payload: body,
      headers,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ type: "composio.connected_account.active" });
    const { headers } = signed(body);
    const result = verifyComposioWebhookSignature({
      payload: body + "x",
      headers,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider + payload parsing.
// ---------------------------------------------------------------------------

describe("providerFromToolkitSlug", () => {
  it("maps toolkit slugs to Keeps providers", () => {
    expect(providerFromToolkitSlug("slack")).toBe("slack");
    expect(providerFromToolkitSlug("googlecalendar")).toBe("google_calendar");
    expect(providerFromToolkitSlug("notion")).toBeNull();
    expect(providerFromToolkitSlug(undefined)).toBeNull();
  });
});

describe("parseComposioWebhook (defensive)", () => {
  it("parses a well-formed connected_account event", () => {
    const parsed = parseComposioWebhook({
      type: "composio.connected_account.active",
      data: {
        id: "ca_abc",
        userId: "u-uuid",
        status: "ACTIVE",
        toolkit: { slug: "slack" },
      },
    });
    expect(parsed?.composioConnectedAccountId).toBe("ca_abc");
    expect(parsed?.composioEntityId).toBe("u-uuid");
    expect(parsed?.provider).toBe("slack");
    expect(parsed?.composioStatus).toBe("ACTIVE");
  });

  it("returns null for an unrecognized shape (no throw)", () => {
    expect(parseComposioWebhook(null)).toBeNull();
    expect(parseComposioWebhook({ type: "something.else" })).toBeNull();
    expect(
      parseComposioWebhook({ type: "composio.connected_account.active", data: {} }),
    ).toBeNull(); // missing ids
  });
});

// ---------------------------------------------------------------------------
// classifyLifecycle.
// ---------------------------------------------------------------------------

describe("classifyLifecycle", () => {
  const base: ParsedWebhookEvent = {
    type: "composio.connected_account.x",
    action: "x",
    composioConnectedAccountId: "ca_1",
    composioEntityId: "u",
    provider: "slack",
    composioStatus: null,
    statusReason: null,
  };

  it("trusts explicit status strings over the action verb", () => {
    expect(classifyLifecycle({ ...base, composioStatus: "ACTIVE" })).toEqual({
      kind: "connected",
      status: "active",
    });
    expect(classifyLifecycle({ ...base, composioStatus: "REVOKED" })).toEqual({
      kind: "revoked",
      status: "revoked",
    });
    expect(classifyLifecycle({ ...base, composioStatus: "EXPIRED" })).toEqual({
      kind: "revoked",
      status: "auth_error",
    });
  });

  it("infers from the action verb when no status is present", () => {
    expect(classifyLifecycle({ ...base, action: "created" }).kind).toBe("connected");
    expect(classifyLifecycle({ ...base, action: "expired" }).kind).toBe("revoked");
    expect(classifyLifecycle({ ...base, action: "deleted" })).toEqual({
      kind: "revoked",
      status: "disabled",
    });
    expect(classifyLifecycle({ ...base, action: "mystery" }).kind).toBe("ignore");
  });
});

// ---------------------------------------------------------------------------
// handleComposioWebhookEvent — dispatch core.
// ---------------------------------------------------------------------------

describe("handleComposioWebhookEvent", () => {
  it("an active event upserts + emits connector.connected + audits", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const audit = new FakeAudit();
    const { events, emit } = makeEmitter();

    const event: ParsedWebhookEvent = {
      type: "composio.connected_account.active",
      action: "active",
      composioConnectedAccountId: "ca_new",
      composioEntityId: "11111111-1111-1111-1111-111111111111",
      provider: "slack",
      composioStatus: "ACTIVE",
      statusReason: null,
    };

    const result = await handleComposioWebhookEvent({
      event,
      accountsRepo: repo,
      emitEvent: emit,
      audit,
      now: NOW,
    });

    expect(result.handled).toBe("connected");
    const row = await repo.findByComposioAccount("ca_new");
    expect(row?.status).toBe("active");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("connector.connected");
    expect((events[0].data as EventMap["connector.connected"]).externalAccountEmail).toBeNull();
    expect(audit.writes[0].action).toBe("connector.account_connected");
  });

  it("a revoked event marks status + emits connector.revoked + audits revoked", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const userId = "22222222-2222-2222-2222-222222222222";
    const existing = makeAccountRow({
      userId,
      composioConnectedAccountId: "ca_old",
      composioEntityId: userId,
      provider: "slack",
      status: "active",
    });
    repo.seed(existing);

    const audit = new FakeAudit();
    const { events, emit } = makeEmitter();

    const result = await handleComposioWebhookEvent({
      event: {
        type: "composio.connected_account.revoked",
        action: "revoked",
        composioConnectedAccountId: "ca_old",
        composioEntityId: userId,
        provider: "slack",
        composioStatus: "REVOKED",
        statusReason: "Revoked via admin tool",
      },
      accountsRepo: repo,
      emitEvent: emit,
      audit,
      now: NOW,
    });

    expect(result.handled).toBe("revoked");
    const row = await repo.findById(existing.id);
    expect(row?.status).toBe("revoked");
    expect(row?.disconnectedAt).toEqual(NOW);
    expect(events[0].name).toBe("connector.revoked");
    expect((events[0].data as EventMap["connector.revoked"]).reason).toBe(
      "Revoked via admin tool",
    );
    expect(audit.writes[0].action).toBe("connector.account_revoked");
  });

  it("an expired event audits auth_error (not revoked)", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const userId = "33333333-3333-3333-3333-333333333333";
    repo.seed(
      makeAccountRow({
        userId,
        composioConnectedAccountId: "ca_exp",
        status: "active",
      }),
    );
    const audit = new FakeAudit();
    const { emit } = makeEmitter();

    await handleComposioWebhookEvent({
      event: {
        type: "composio.connected_account.expired",
        action: "expired",
        composioConnectedAccountId: "ca_exp",
        composioEntityId: userId,
        provider: "google_calendar",
        composioStatus: "EXPIRED",
        statusReason: null,
      },
      accountsRepo: repo,
      emitEvent: emit,
      audit,
      now: NOW,
    });

    expect(audit.writes[0].action).toBe("connector.account_auth_error");
    expect((await repo.findByComposioAccount("ca_exp"))?.status).toBe("auth_error");
  });

  it("ignores an unactionable event (no status, unknown verb)", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const audit = new FakeAudit();
    const { events, emit } = makeEmitter();
    const result = await handleComposioWebhookEvent({
      event: {
        type: "composio.connected_account.mystery",
        action: "mystery",
        composioConnectedAccountId: "ca_z",
        composioEntityId: "u",
        provider: "slack",
        composioStatus: null,
        statusReason: null,
      },
      accountsRepo: repo,
      emitEvent: emit,
      audit,
      now: NOW,
    });
    expect(result.handled).toBe("ignored");
    expect(events).toHaveLength(0);
    expect(audit.writes).toHaveLength(0);
  });
});
