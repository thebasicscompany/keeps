import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ConnectorAccount } from "@/db/schema";
import {
  mapComposioStatus,
  type ConnectorAccountsRepository,
  type HydrateInput,
  type MarkStatusInput,
  type UpsertByComposioAccountInput,
} from "@/connectors/accounts-repository";

// ---------------------------------------------------------------------------
// In-memory fake — the canonical test double reused across connector tests.
// ---------------------------------------------------------------------------

export class FakeConnectorAccountsRepository implements ConnectorAccountsRepository {
  readonly rows = new Map<string, ConnectorAccount>();

  seed(row: ConnectorAccount) {
    this.rows.set(row.id, row);
  }

  private byComposio(id: string): ConnectorAccount | undefined {
    return [...this.rows.values()].find((r) => r.composioConnectedAccountId === id);
  }

  async upsertByComposioAccount(
    input: UpsertByComposioAccountInput,
  ): Promise<ConnectorAccount> {
    const now = input.now ?? new Date();
    const existing = this.byComposio(input.composioConnectedAccountId);
    if (existing) {
      const updated: ConnectorAccount = {
        ...existing,
        userId: input.userId,
        provider: input.provider,
        composioEntityId: input.composioEntityId,
        status: input.status,
        statusReason: input.statusReason ?? null,
        externalAccountEmail:
          input.externalAccountEmail !== undefined
            ? input.externalAccountEmail
            : existing.externalAccountEmail,
        externalAccountLabel:
          input.externalAccountLabel !== undefined
            ? input.externalAccountLabel
            : existing.externalAccountLabel,
        scopes: input.scopes !== undefined ? input.scopes : existing.scopes,
        metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
        updatedAt: now,
      };
      this.rows.set(updated.id, updated);
      return updated;
    }
    const row: ConnectorAccount = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      composioConnectedAccountId: input.composioConnectedAccountId,
      composioEntityId: input.composioEntityId,
      externalAccountEmail: input.externalAccountEmail ?? null,
      externalAccountLabel: input.externalAccountLabel ?? null,
      scopes: input.scopes ?? [],
      status: input.status,
      statusReason: input.statusReason ?? null,
      metadata: input.metadata ?? {},
      connectedAt: now,
      lastUsedAt: null,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async markStatus(input: MarkStatusInput): Promise<ConnectorAccount | null> {
    const now = input.now ?? new Date();
    const row = input.id
      ? this.rows.get(input.id)
      : input.composioConnectedAccountId
        ? this.byComposio(input.composioConnectedAccountId)
        : undefined;
    if (!row) return null;
    const updated: ConnectorAccount = {
      ...row,
      status: input.status,
      statusReason: input.statusReason ?? null,
      disconnectedAt:
        input.disconnectedAt !== undefined ? input.disconnectedAt : row.disconnectedAt,
      updatedAt: now,
    };
    this.rows.set(updated.id, updated);
    return updated;
  }

  async hydrate(input: HydrateInput): Promise<ConnectorAccount | null> {
    const row = this.rows.get(input.id);
    if (!row) return null;
    const now = input.now ?? new Date();
    const updated: ConnectorAccount = {
      ...row,
      externalAccountEmail:
        input.externalAccountEmail !== undefined
          ? input.externalAccountEmail
          : row.externalAccountEmail,
      externalAccountLabel:
        input.externalAccountLabel !== undefined
          ? input.externalAccountLabel
          : row.externalAccountLabel,
      scopes: input.scopes !== undefined ? input.scopes : row.scopes,
      metadata: input.metadata !== undefined ? input.metadata : row.metadata,
      updatedAt: now,
    };
    this.rows.set(updated.id, updated);
    return updated;
  }

  async findActiveByUserAndProvider(userId: string, provider: string) {
    return (
      [...this.rows.values()].find(
        (r) => r.userId === userId && r.provider === provider && r.status === "active",
      ) ?? null
    );
  }

  async listActive(): Promise<ConnectorAccount[]> {
    return [...this.rows.values()].filter((r) => r.status === "active");
  }

  async findByComposioAccount(id: string): Promise<ConnectorAccount | null> {
    return this.byComposio(id) ?? null;
  }

  async findById(id: string): Promise<ConnectorAccount | null> {
    return this.rows.get(id) ?? null;
  }
}

/** Builds a fully-populated ConnectorAccount row for seeding fakes. */
export function makeAccountRow(
  overrides: Partial<ConnectorAccount> = {},
): ConnectorAccount {
  const now = new Date("2026-06-13T12:00:00Z");
  return {
    id: overrides.id ?? randomUUID(),
    userId: overrides.userId ?? randomUUID(),
    provider: overrides.provider ?? "slack",
    composioConnectedAccountId: overrides.composioConnectedAccountId ?? "ca_test",
    composioEntityId: overrides.composioEntityId ?? overrides.userId ?? randomUUID(),
    externalAccountEmail: overrides.externalAccountEmail ?? null,
    externalAccountLabel: overrides.externalAccountLabel ?? null,
    scopes: overrides.scopes ?? [],
    status: overrides.status ?? "active",
    statusReason: overrides.statusReason ?? null,
    metadata: overrides.metadata ?? {},
    connectedAt: overrides.connectedAt ?? now,
    lastUsedAt: overrides.lastUsedAt ?? null,
    disconnectedAt: overrides.disconnectedAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

// ---------------------------------------------------------------------------
// mapComposioStatus — the single source of truth for status translation.
// ---------------------------------------------------------------------------

describe("mapComposioStatus", () => {
  it("maps the full Composio status table to our enum", () => {
    expect(mapComposioStatus("ACTIVE")).toBe("active");
    expect(mapComposioStatus("REVOKED")).toBe("revoked");
    expect(mapComposioStatus("EXPIRED")).toBe("auth_error");
    expect(mapComposioStatus("INACTIVE")).toBe("auth_error");
    expect(mapComposioStatus("FAILED")).toBe("auth_error");
  });

  it("treats INITIATED / INITIALIZING / unknown as auth_error (fail safe)", () => {
    expect(mapComposioStatus("INITIATED")).toBe("auth_error");
    expect(mapComposioStatus("INITIALIZING")).toBe("auth_error");
    expect(mapComposioStatus("WAT")).toBe("auth_error");
  });
});

// ---------------------------------------------------------------------------
// Fake repo behavior — upsert insert-vs-update + hydrate idempotency.
// ---------------------------------------------------------------------------

describe("FakeConnectorAccountsRepository", () => {
  it("upsert inserts then updates on the same composio id without blanking hydrated fields", async () => {
    const repo = new FakeConnectorAccountsRepository();
    const userId = randomUUID();

    const inserted = await repo.upsertByComposioAccount({
      composioConnectedAccountId: "ca_x",
      composioEntityId: userId,
      userId,
      provider: "slack",
      status: "active",
    });
    // simulate hydration
    await repo.hydrate({
      id: inserted.id,
      externalAccountEmail: "a@b.com",
      scopes: ["chat:write"],
    });

    // a second active-event upsert should NOT clear email/scopes.
    const updated = await repo.upsertByComposioAccount({
      composioConnectedAccountId: "ca_x",
      composioEntityId: userId,
      userId,
      provider: "slack",
      status: "active",
    });

    expect(updated.id).toBe(inserted.id);
    expect(updated.externalAccountEmail).toBe("a@b.com");
    expect(updated.scopes).toEqual(["chat:write"]);
    expect(repo.rows.size).toBe(1);
  });

  it("markStatus returns null for an unknown account", async () => {
    const repo = new FakeConnectorAccountsRepository();
    expect(await repo.markStatus({ id: "nope", status: "revoked" })).toBeNull();
  });
});
