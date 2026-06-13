/**
 * accounts-repository — the SINGLE owner of writes to `connector_accounts`.
 *
 * Every path that mutates a connector account (the Composio webhook, the
 * hydration step, the status-poll sweep) goes through this port. Business logic
 * never touches Drizzle directly; tests inject the in-memory fake instead.
 *
 * Composio status strings (ACTIVE / EXPIRED / REVOKED / INACTIVE / FAILED /
 * INITIATED / INITIALIZING) are mapped to our `connector_account_status` enum
 * (active / revoked / auth_error / disabled) by the one exported helper
 * `mapComposioStatus`. Keep that mapping in one place — both the webhook and the
 * sweep depend on it agreeing.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts } from "@/db/schema";
import type { ConnectorAccount } from "@/db/schema";

// ---------------------------------------------------------------------------
// Provider + status types
// ---------------------------------------------------------------------------

/** Keeps-internal connector provider keys (mirror connector_provider enum). */
export type ConnectorProvider = "slack" | "google_calendar";

/** Our connector_account_status enum values. */
export type ConnectorAccountStatus = "active" | "revoked" | "auth_error" | "disabled";

/**
 * Composio's connected-account status strings, verified against
 * @composio/core 0.10.0 ConnectedAccountStatuses
 * (node_modules/@composio/core/dist/customTool.types-CMOMgxoM.d.mts:12-20)
 * and RESEARCH-COMPOSIO.md Q4.
 */
export type ComposioStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

/**
 * Maps a Composio connected-account status string to our enum.
 *
 *   ACTIVE                     → active
 *   REVOKED                    → revoked
 *   EXPIRED / INACTIVE / FAILED→ auth_error  (reconnect needed)
 *   INITIATED / INITIALIZING   → auth_error  (never reached ACTIVE; treat as needing reconnect)
 *   anything unrecognized      → auth_error  (fail safe: a non-ACTIVE account must not execute)
 *
 * The single source of truth for the mapping — both the webhook and the sweep
 * call this so they can never disagree about what "ACTIVE" means.
 */
export function mapComposioStatus(status: string): ConnectorAccountStatus {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "REVOKED":
      return "revoked";
    case "EXPIRED":
    case "INACTIVE":
    case "FAILED":
      return "auth_error";
    default:
      // INITIATED / INITIALIZING / anything unexpected — non-ACTIVE means it
      // cannot execute tools, so surface it as needing reconnect.
      return "auth_error";
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface UpsertByComposioAccountInput {
  composioConnectedAccountId: string;
  composioEntityId: string;
  userId: string;
  provider: ConnectorProvider;
  status: ConnectorAccountStatus;
  statusReason?: string | null;
  externalAccountEmail?: string | null;
  externalAccountLabel?: string | null;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  /** Defaults to now() in the DB layer when omitted. Injectable for determinism. */
  now?: Date;
}

export interface MarkStatusInput {
  /** Address the row by primary key OR by Composio connected-account id (one required). */
  id?: string;
  composioConnectedAccountId?: string;
  status: ConnectorAccountStatus;
  statusReason?: string | null;
  /** Set when transitioning into a non-active terminal state. */
  disconnectedAt?: Date | null;
  now?: Date;
}

export interface HydrateInput {
  id: string;
  externalAccountEmail?: string | null;
  externalAccountLabel?: string | null;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ConnectorAccountsRepository {
  /**
   * Insert-or-update keyed on composio_connected_account_id (its unique index).
   * On insert, seeds connectedAt. On conflict, refreshes status/reason/entity and
   * any provided external/scopes/metadata fields, bumps updatedAt. Returns the row.
   */
  upsertByComposioAccount(input: UpsertByComposioAccountInput): Promise<ConnectorAccount>;

  /**
   * Flip an account's status (+ optional reason / disconnectedAt). Addressable by
   * primary key or composio_connected_account_id. Returns the updated row, or null
   * if no row matched.
   */
  markStatus(input: MarkStatusInput): Promise<ConnectorAccount | null>;

  /**
   * Populate the fields that require a Composio API call (email/label/scopes/metadata).
   * Idempotent on the connector_account id — re-running re-writes the same fields.
   * Returns the updated row, or null if the id is unknown.
   */
  hydrate(input: HydrateInput): Promise<ConnectorAccount | null>;

  /** The single ACTIVE account for (userId, provider), or null. */
  findActiveByUserAndProvider(
    userId: string,
    provider: ConnectorProvider,
  ): Promise<ConnectorAccount | null>;

  /** Every ACTIVE account — the sweep's working set. */
  listActive(): Promise<ConnectorAccount[]>;

  /** Lookup by Composio connected-account id, or null. */
  findByComposioAccount(composioConnectedAccountId: string): Promise<ConnectorAccount | null>;

  /** Lookup by local primary-key id, or null (used by the hydration step). */
  findById(id: string): Promise<ConnectorAccount | null>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

export class DrizzleConnectorAccountsRepository implements ConnectorAccountsRepository {
  private readonly db: ReturnType<typeof getDb>;

  /** `db` is injectable so DB-gated integration tests can target a test Postgres. */
  constructor(db?: ReturnType<typeof getDb>) {
    this.db = db ?? getDb();
  }

  async upsertByComposioAccount(
    input: UpsertByComposioAccountInput,
  ): Promise<ConnectorAccount> {
    const now = input.now ?? new Date();

    // Columns we always set on both insert and update.
    const mutable = {
      userId: input.userId,
      provider: input.provider,
      composioEntityId: input.composioEntityId,
      status: input.status,
      statusReason: input.statusReason ?? null,
      updatedAt: now,
    };

    // Optional hydration-ish fields — only overwrite when explicitly provided so an
    // active-event upsert doesn't blank out email/label/scopes a prior hydrate wrote.
    const optional: Record<string, unknown> = {};
    if (input.externalAccountEmail !== undefined)
      optional.externalAccountEmail = input.externalAccountEmail;
    if (input.externalAccountLabel !== undefined)
      optional.externalAccountLabel = input.externalAccountLabel;
    if (input.scopes !== undefined) optional.scopes = input.scopes;
    if (input.metadata !== undefined) optional.metadata = input.metadata;

    // RECONCILE ON (user_id, provider) — the "one connector per user per provider"
    // invariant. A reconnect arrives with a NEW composio_connected_account_id for an
    // EXISTING (user, provider) row, so conflicting on the composio id alone would
    // miss it and hit the (user_id, provider) unique constraint as an unhandled throw.
    // We therefore conflict on (user_id, provider) and ADOPT the new composio id on
    // the existing row. (The new ca_ id is globally unique to this user, so updating
    // it can't collide with another row's composio-id unique index in practice.)
    const updateSet: Record<string, unknown> = {
      ...mutable,
      ...optional,
      composioConnectedAccountId: input.composioConnectedAccountId,
    };
    // Becoming active (the connect/reconnect path) clears the disconnect marker and
    // refreshes connectedAt to this fresh connection.
    if (input.status === "active") {
      updateSet.connectedAt = now;
      updateSet.disconnectedAt = null;
    }

    const [row] = await this.db
      .insert(connectorAccounts)
      .values({
        id: randomUUID(),
        composioConnectedAccountId: input.composioConnectedAccountId,
        ...mutable,
        ...optional,
        connectedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorAccounts.userId, connectorAccounts.provider],
        set: updateSet,
      })
      .returning();

    return row;
  }

  async markStatus(input: MarkStatusInput): Promise<ConnectorAccount | null> {
    const now = input.now ?? new Date();
    const set: Record<string, unknown> = {
      status: input.status,
      statusReason: input.statusReason ?? null,
      updatedAt: now,
    };
    if (input.disconnectedAt !== undefined) {
      set.disconnectedAt = input.disconnectedAt;
    }

    const where = input.id
      ? eq(connectorAccounts.id, input.id)
      : input.composioConnectedAccountId
        ? eq(
            connectorAccounts.composioConnectedAccountId,
            input.composioConnectedAccountId,
          )
        : null;

    if (!where) {
      throw new Error("markStatus requires id or composioConnectedAccountId");
    }

    const [row] = await this.db
      .update(connectorAccounts)
      .set(set)
      .where(where)
      .returning();

    return row ?? null;
  }

  async hydrate(input: HydrateInput): Promise<ConnectorAccount | null> {
    const now = input.now ?? new Date();
    const set: Record<string, unknown> = { updatedAt: now };
    if (input.externalAccountEmail !== undefined)
      set.externalAccountEmail = input.externalAccountEmail;
    if (input.externalAccountLabel !== undefined)
      set.externalAccountLabel = input.externalAccountLabel;
    if (input.scopes !== undefined) set.scopes = input.scopes;
    if (input.metadata !== undefined) set.metadata = input.metadata;

    const [row] = await this.db
      .update(connectorAccounts)
      .set(set)
      .where(eq(connectorAccounts.id, input.id))
      .returning();

    return row ?? null;
  }

  async findActiveByUserAndProvider(
    userId: string,
    provider: ConnectorProvider,
  ): Promise<ConnectorAccount | null> {
    const [row] = await this.db
      .select()
      .from(connectorAccounts)
      .where(
        and(
          eq(connectorAccounts.userId, userId),
          eq(connectorAccounts.provider, provider),
          eq(connectorAccounts.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listActive(): Promise<ConnectorAccount[]> {
    return this.db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.status, "active"));
  }

  async findByComposioAccount(
    composioConnectedAccountId: string,
  ): Promise<ConnectorAccount | null> {
    const [row] = await this.db
      .select()
      .from(connectorAccounts)
      .where(
        eq(
          connectorAccounts.composioConnectedAccountId,
          composioConnectedAccountId,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<ConnectorAccount | null> {
    const [row] = await this.db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, id))
      .limit(1);
    return row ?? null;
  }
}
