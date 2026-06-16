/**
 * Automation run repository (Wave 3) — Drizzle persistence for the automation pipeline + the
 * effects the executor needs. Mirrors the nudge/approval repository style (thin SQL, no policy).
 *
 *  - insertRun: ON CONFLICT(idempotency_key) DO NOTHING (run-ledger idempotency, AD3/SR4).
 *  - insertRunActions / updateRunStatus / updateRunActionStatus: status transitions.
 *  - loadGrantContext: fresh standing_grants row → StandingGrantContext (SR3 re-load at execute).
 *  - countCapUsage: completed run-actions per kind within a window (the executor's fresh cap check).
 *
 * The pure mapper grantRowToContext is exported + unit-tested; the Drizzle methods are DB-gated.
 */
import { and, count, eq, gte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { automationRunActions, automationRuns, standingGrants } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { AutomationRunStatus, AutomationRunActionStatus, StandingGrant } from "@/db/schema";
import type { KeepsActionKind } from "@/policy/actions";
import type { GrantCaps, GrantScope, StandingGrantContext, StandingGrantStatus } from "@/automation/types";
import type { SandboxPlan } from "@/automation/sandbox-plan";

/** PURE: a standing_grants row → the context authorize() evaluates. capUsage/hasAttendees/targetZone
 *  are NOT set here — the executor augments them per-action inside its txn. */
export function grantRowToContext(g: StandingGrant): StandingGrantContext {
  return {
    recipeKey: g.recipeKey,
    status: g.status as StandingGrantStatus,
    allowedActionKinds: (g.allowedActionKinds as KeepsActionKind[]) ?? [],
    blockedActionKinds: (g.blockedActionKinds as KeepsActionKind[]) ?? [],
    expiresAt: g.expiresAt,
    scope: (g.scope as GrantScope) ?? {},
    caps: (g.caps as GrantCaps) ?? {},
  };
}

export type InsertRunInput = {
  userId: string;
  standingGrantId: string | null;
  recipeKey: string;
  triggerKind: "calendar_event" | "loop_stale" | "explicit_command" | "cron";
  triggerRef: string | null;
  status: AutomationRunStatus;
  idempotencyKey: string;
  inputSnapshot?: Record<string, unknown>;
  sandboxPlan: SandboxPlan;
  policyDecision?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

export type AutomationRunRepository = {
  /** Insert a run; ON CONFLICT(idempotency_key) DO NOTHING. Returns the row id + whether it deduped. */
  insertRun(input: InsertRunInput): Promise<{ id: string; deduped: boolean }>;
  insertRunActions(
    runId: string,
    actions: { actionKind: string; target: Record<string, unknown> }[],
  ): Promise<void>;
  updateRunStatus(
    runId: string,
    status: AutomationRunStatus,
    extra?: { result?: Record<string, unknown>; error?: Record<string, unknown>; at?: Date },
  ): Promise<void>;
  /** Fresh grant context for the SR3 re-check; null = revoked/expired/deleted. */
  loadGrantContext(standingGrantId: string): Promise<StandingGrantContext | null>;
  /** Completed run-actions per kind for this grant since `since` (the cap-usage re-check). */
  countCapUsage(
    standingGrantId: string,
    since: Date,
  ): Promise<Partial<Record<KeepsActionKind, number>>>;
};

type Db = PostgresJsDatabase<typeof schema>;

export class DrizzleAutomationRunRepository implements AutomationRunRepository {
  private readonly db: Db;
  constructor(db?: Db) {
    this.db = db ?? (getDb() as Db);
  }

  async insertRun(input: InsertRunInput): Promise<{ id: string; deduped: boolean }> {
    const [row] = await this.db
      .insert(automationRuns)
      .values({
        userId: input.userId,
        standingGrantId: input.standingGrantId,
        recipeKey: input.recipeKey,
        triggerKind: input.triggerKind,
        triggerRef: input.triggerRef,
        status: input.status,
        idempotencyKey: input.idempotencyKey,
        inputSnapshot: input.inputSnapshot ?? {},
        sandboxPlan: input.sandboxPlan as unknown as Record<string, unknown>,
        policyDecision: input.policyDecision ?? {},
        provenance: input.provenance ?? {},
      })
      .onConflictDoNothing({ target: automationRuns.idempotencyKey })
      .returning({ id: automationRuns.id });

    if (row) return { id: row.id, deduped: false };

    // Conflict → the run already exists; return its id.
    const [existing] = await this.db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!existing) throw new Error("insertRun: conflict but no existing row found");
    return { id: existing.id, deduped: true };
  }

  async insertRunActions(
    runId: string,
    actions: { actionKind: string; target: Record<string, unknown> }[],
  ): Promise<void> {
    if (actions.length === 0) return;
    await this.db.insert(automationRunActions).values(
      actions.map((a) => ({
        automationRunId: runId,
        actionKind: a.actionKind,
        status: "planned" as AutomationRunActionStatus,
        target: a.target,
      })),
    );
  }

  async updateRunStatus(
    runId: string,
    status: AutomationRunStatus,
    extra?: { result?: Record<string, unknown>; error?: Record<string, unknown>; at?: Date },
  ): Promise<void> {
    const now = extra?.at ?? new Date();
    const set: Partial<typeof automationRuns.$inferInsert> = { status, updatedAt: now };
    if (extra?.result) set.result = extra.result;
    if (extra?.error) set.error = extra.error;
    if (status === "executing") set.executedAt = now;
    if (status === "completed") set.completedAt = now;
    if (status === "failed") set.failedAt = now;
    await this.db.update(automationRuns).set(set).where(eq(automationRuns.id, runId));
  }

  async loadGrantContext(standingGrantId: string): Promise<StandingGrantContext | null> {
    const [g] = await this.db
      .select()
      .from(standingGrants)
      .where(eq(standingGrants.id, standingGrantId))
      .limit(1);
    return g ? grantRowToContext(g) : null;
  }

  async countCapUsage(
    standingGrantId: string,
    since: Date,
  ): Promise<Partial<Record<KeepsActionKind, number>>> {
    const rows = await this.db
      .select({ kind: automationRunActions.actionKind, n: count() })
      .from(automationRunActions)
      .innerJoin(automationRuns, eq(automationRunActions.automationRunId, automationRuns.id))
      .where(
        and(
          eq(automationRuns.standingGrantId, standingGrantId),
          eq(automationRunActions.status, "completed"),
          gte(automationRunActions.createdAt, since),
        ),
      )
      .groupBy(automationRunActions.actionKind);

    const out: Partial<Record<KeepsActionKind, number>> = {};
    for (const r of rows) out[r.kind as KeepsActionKind] = Number(r.n);
    return out;
  }
}
