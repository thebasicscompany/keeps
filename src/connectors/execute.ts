/**
 * Connector EXECUTE-ONCE layer (Phase 4 — D2).
 *
 * This is the security + idempotency boundary for connector actions. It is the
 * connector analogue of `src/approvals/execute.ts`: the single funnel through
 * which a frozen, approved connector payload reaches the live provider, with two
 * invariants it MUST uphold:
 *
 *   1. AR-7 — NOTHING executes without `authorize()` returning 'allowed' against
 *      the LIVE approval_request row (loaded inside the same transaction, never a
 *      cached copy from the workflow event).
 *
 *   2. EXACTLY-ONCE — the same approval delivered twice (Inngest at-least-once
 *      delivery, a retry, two concurrent runs) results in EXACTLY ONE
 *      `executeConnectorPayload` call and ONE `completed` row. This is enforced by
 *      a row lock: every caller opens a transaction and `SELECT ... FOR UPDATE`s
 *      the connector_actions row before deciding what to do. The first caller
 *      flips the row to 'executing' (then 'completed') under the lock; the second
 *      caller blocks on the lock, then reads the already-terminal status and
 *      returns the cached result WITHOUT executing.
 *
 * The provider call (`executeConnectorPayload`) is injectable (`execute`) so the
 * load-bearing concurrency test can assert the executor was invoked exactly once.
 *
 * @see src/approvals/execute.ts — the approval-side analogue (executeApprovedDraft)
 * @see src/policy/actions.ts — authorize() (the AR-7 gate)
 * @see src/connectors/action-registry.ts — executeConnectorPayload (the one Composio path)
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalRequests,
  auditLog,
  connectorAccounts,
  connectorActions,
  users,
} from "@/db/schema";
import type { ConnectorAction } from "@/db/schema";
import { auditActionEnum } from "@/db/schema";
import { authorize, type KeepsActionKind } from "@/policy/actions";
import {
  executeConnectorPayload,
  type ConnectorExecutor,
} from "@/connectors/action-registry";
import type {
  ConnectorActionKind,
  ConnectorActionPayload,
} from "@/agent/schemas";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AuditAction = (typeof auditActionEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// connector_actions repository — db-injectable, mirrors accounts-repository.
// ---------------------------------------------------------------------------

export interface CreateConnectorActionInput {
  userId: string;
  connectorAccountId: string;
  kind: ConnectorActionKind;
  payload: ConnectorActionPayload;
  idempotencyKey: string;
  approvalRequestId?: string | null;
  draftId?: string | null;
  inboundEmailId?: string | null;
  loopId?: string | null;
  now?: Date;
}

export interface ConnectorActionsRepository {
  /** Insert a fresh connector_actions row (status 'pending'). Returns the row. */
  createAction(input: CreateConnectorActionInput): Promise<ConnectorAction>;
  /** Lookup by primary key, or null. */
  findById(id: string): Promise<ConnectorAction | null>;
  /** Flip the row to 'cancelled' (rejected/cancelled approval). Returns the row, or null. */
  markCancelled(id: string, now?: Date): Promise<ConnectorAction | null>;
}

/**
 * Drizzle-backed connector_actions repository. `db` is injectable so DB-gated
 * integration tests target a test Postgres (mirrors DrizzleConnectorAccountsRepository).
 */
export class DrizzleConnectorActionsRepository implements ConnectorActionsRepository {
  private readonly db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  async createAction(input: CreateConnectorActionInput): Promise<ConnectorAction> {
    const now = input.now ?? new Date();
    const [row] = await this.db
      .insert(connectorActions)
      .values({
        id: randomUUID(),
        userId: input.userId,
        connectorAccountId: input.connectorAccountId,
        inboundEmailId: input.inboundEmailId ?? null,
        loopId: input.loopId ?? null,
        draftId: input.draftId ?? null,
        approvalRequestId: input.approvalRequestId ?? null,
        kind: input.kind,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        requestedAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new Error("createAction: no row returned");
    }
    return row;
  }

  async findById(id: string): Promise<ConnectorAction | null> {
    const [row] = await this.db
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.id, id))
      .limit(1);
    return row ?? null;
  }

  async markCancelled(id: string, now?: Date): Promise<ConnectorAction | null> {
    const at = now ?? new Date();
    const [row] = await this.db
      .update(connectorActions)
      .set({ status: "cancelled", updatedAt: at })
      .where(eq(connectorActions.id, id))
      .returning();
    return row ?? null;
  }
}

// ---------------------------------------------------------------------------
// executeConnectorAction — the execute-once primitive
// ---------------------------------------------------------------------------

/** Structured error stored on connector_actions.error. */
export interface ConnectorActionError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ExecuteConnectorActionResult =
  | { status: "completed"; result: unknown; cached: boolean }
  | { status: "executing"; cached: boolean }
  | { status: "denied"; error: ConnectorActionError }
  | { status: "failed"; error: ConnectorActionError }
  | { status: "cancelled" }
  | { status: "not_found" };

export interface ExecuteConnectorActionInput {
  connectorActionId: string;
  /** Injectable db so DB-gated tests target a test Postgres. */
  db?: Db;
  /** Injectable provider executor so tests assert the call count (exactly-once proof). */
  execute?: ConnectorExecutor;
  /** Injected clock; defaults to new Date() inside the transaction. */
  now?: Date;
}

/**
 * Execute a connector action EXACTLY ONCE.
 *
 * Transaction body (the whole thing runs under a row lock on connector_actions):
 *   1. SELECT ... FOR UPDATE the connector_actions row.
 *      - not found            → return not_found (nothing to do).
 *      - status 'completed'   → return the cached result (NO execute).
 *      - status 'executing'   → return cached/executing (NO execute — a sibling is
 *                               mid-flight or already wrote 'executing' before commit).
 *      - status 'failed'      → return the cached failure (NO execute, NO re-run).
 *      - status 'cancelled'   → return cancelled (NO execute).
 *      - status 'pending'     → proceed.
 *   2. Load the LIVE approval_request row (via approval_request_id) and call
 *      authorize(kind, { userId, approval:{id,status,expiresAt} }, { now }). This is
 *      AR-7: the gate reads the live row, not the event. If result !== 'allowed':
 *      set status 'failed' + structured error, write a policy.authorize_denied audit,
 *      COMMIT, return denied. NO execute.
 *   3. Allowed: flip status 'executing' (the second concurrent caller, blocked on the
 *      lock, will see this once we commit), load the connector account + user timezone,
 *      call executeConnectorPayload with the FROZEN payload. On success: write
 *      result + status 'completed' + executed_at, COMMIT, return completed. On throw:
 *      write status 'failed' + error + failed_at, audit connector.action_failed, COMMIT,
 *      return failed (the error is swallowed so the failure is recorded durably and the
 *      caller can emit connector.action_failed — Inngest does not re-run a committed
 *      'failed' row because the lock + status guard short-circuits a retry).
 *
 * THE INVARIANT (proven by execute.db.test.ts): two concurrent invocations against
 * the same row ⇒ the first acquires the lock, executes, commits 'completed'; the
 * second blocks, then reads 'completed' and returns cached ⇒ executeConnectorPayload
 * is called EXACTLY ONCE.
 */
export async function executeConnectorAction(
  input: ExecuteConnectorActionInput,
): Promise<ExecuteConnectorActionResult> {
  const db = input.db ?? getDb();
  const execute = input.execute;

  return db.transaction(async (tx) => {
    const now = input.now ?? new Date();

    // 1) Lock the row. FOR UPDATE serializes concurrent callers on this id — the
    // whole point: only one transaction proceeds past 'pending' at a time.
    const [action] = await tx
      .select()
      .from(connectorActions)
      .where(eq(connectorActions.id, input.connectorActionId))
      .for("update")
      .limit(1);

    if (!action) {
      return { status: "not_found" } as const;
    }

    // Terminal / in-flight states → return cached, never re-execute.
    if (action.status === "completed") {
      return { status: "completed", result: action.result, cached: true } as const;
    }
    if (action.status === "executing") {
      return { status: "executing", cached: true } as const;
    }
    if (action.status === "failed") {
      const err = (action.error as ConnectorActionError | null) ?? {
        code: "unknown",
        message: "previously failed",
        retryable: false,
      };
      return { status: "failed", error: err } as const;
    }
    if (action.status === "cancelled") {
      return { status: "cancelled" } as const;
    }

    // status === 'pending' from here on.

    // 2) AR-7 gate — authorize against the LIVE approval row.
    const approval = action.approvalRequestId
      ? (
          await tx
            .select()
            .from(approvalRequests)
            .where(eq(approvalRequests.id, action.approvalRequestId))
            .limit(1)
        )[0] ?? null
      : null;

    const decision = authorize(
      action.kind as KeepsActionKind,
      {
        userId: action.userId,
        approval: approval
          ? {
              id: approval.id,
              status: approval.status,
              expiresAt: approval.expiresAt,
            }
          : undefined,
      },
      { now },
    );

    if (decision.result !== "allowed") {
      const code =
        decision.reason && /expired/i.test(decision.reason)
          ? "approval_expired"
          : "authorize_denied";
      const error: ConnectorActionError = {
        code,
        message: decision.reason ?? `authorization ${decision.result}`,
        retryable: false,
      };
      await tx
        .update(connectorActions)
        .set({ status: "failed", error, failedAt: now, updatedAt: now })
        .where(eq(connectorActions.id, action.id));
      await writeAudit(tx, {
        action: "policy.authorize_denied",
        userId: action.userId,
        metadata: {
          connectorActionId: action.id,
          kind: action.kind,
          result: decision.result,
          reason: error.message,
        },
      });
      return { status: "denied", error } as const;
    }

    // 3) Allowed — flip to 'executing' under the lock, then call the provider.
    await tx
      .update(connectorActions)
      .set({ status: "executing", updatedAt: now })
      .where(eq(connectorActions.id, action.id));

    // Load the connected account + user timezone the executor needs.
    const [account] = await tx
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, action.connectorAccountId))
      .limit(1);

    if (!account) {
      const error: ConnectorActionError = {
        code: "connector_account_missing",
        message: `connector account ${action.connectorAccountId} not found`,
        retryable: false,
      };
      await tx
        .update(connectorActions)
        .set({ status: "failed", error, failedAt: now, updatedAt: now })
        .where(eq(connectorActions.id, action.id));
      await writeAudit(tx, {
        action: "connector.action_failed",
        userId: action.userId,
        metadata: { connectorActionId: action.id, reason: error.code },
      });
      return { status: "failed", error } as const;
    }

    const [user] = await tx
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, account.userId))
      .limit(1);

    try {
      const result = await executeConnectorPayload({
        payload: action.payload as ConnectorActionPayload,
        // The connector account's userId IS the Composio entity id.
        keepsUserId: account.userId,
        connectedAccountId: account.composioConnectedAccountId,
        user: { timezone: user?.timezone ?? null },
        ...(execute ? { execute } : {}),
      });

      await tx
        .update(connectorActions)
        .set({
          status: "completed",
          result: result as unknown as Record<string, unknown>,
          executedAt: now,
          updatedAt: now,
        })
        .where(eq(connectorActions.id, action.id));

      await writeAudit(tx, {
        action: "connector.action_executed",
        userId: action.userId,
        metadata: { connectorActionId: action.id, kind: action.kind },
      });

      return { status: "completed", result, cached: false } as const;
    } catch (err) {
      const error = toConnectorActionError(err);
      await tx
        .update(connectorActions)
        .set({ status: "failed", error, failedAt: now, updatedAt: now })
        .where(eq(connectorActions.id, action.id));
      await writeAudit(tx, {
        action: "connector.action_failed",
        userId: action.userId,
        metadata: {
          connectorActionId: action.id,
          kind: action.kind,
          reason: error.code,
          message: error.message,
        },
      });
      // Swallow: the failure is now durably recorded as 'failed'. Rethrowing would let
      // Inngest retry, but the committed 'failed' status short-circuits any re-run at the
      // status guard above — so we surface a typed result instead and let D1 emit
      // connector.action_failed.
      return { status: "failed", error } as const;
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a thrown error into the structured shape stored on connector_actions.error. */
function toConnectorActionError(err: unknown): ConnectorActionError {
  // ConnectorActionFailedError (provider rejected — successful:false) is NOT retryable;
  // ConnectorTransportError (network / transient) IS retryable. Both carry a `code`.
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "connector_action_threw";
  const message = err instanceof Error ? err.message : String(err);
  const retryable = code === "CONNECTOR_TRANSPORT_ERROR";
  return { code, message, retryable };
}

/** Write an audit row inside the execute-once transaction. */
async function writeAudit(
  tx: Tx,
  input: { action: AuditAction; userId: string | null; metadata: Record<string, unknown> },
): Promise<void> {
  await tx.insert(auditLog).values({
    id: randomUUID(),
    userId: input.userId,
    action: input.action,
    actorType: "system",
    metadata: input.metadata,
  });
}
