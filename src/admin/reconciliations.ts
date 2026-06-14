/**
 * src/admin/reconciliations.ts
 *
 * DB-injectable helper for the /admin/reconciliations page (Phase 7 AR-9).
 *
 * Queries loop_events whose eventType is in ('reconciled', 'reconcile_suggested',
 * 'superseded') and joins the parent loop summary for display context.
 *
 * DB is injectable so this is unit-testable without calling getDb() at module
 * import time.
 */

import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loopEvents, loops } from "@/db/schema";

type DbArg = ReturnType<typeof getDb>;

/** Decision types surfaced on the admin page. */
export type ReconciliationDecision =
  | "reconciled"
  | "reconcile_suggested"
  | "superseded";

/** Metadata shapes written by Phase 7 reconciliation. */
export interface ReconciledMeta {
  sourceInboundEmailId?: string;
  action?: "update" | "close";
  evidence?: string;
  reason?: string;
  absorbedSummary?: string;
}

export interface ReconcileSuggestedMeta {
  sourceInboundEmailId?: string;
  candidateLoopId?: string;
  candidateSummary?: string;
  evidence?: string;
  reason?: string;
  suggestedSummary?: string;
}

export interface SupersededMeta {
  evidence?: string;
  reason?: string;
}

export type ReconciliationMeta =
  | ReconciledMeta
  | ReconcileSuggestedMeta
  | SupersededMeta;

/** A single reconciliation event row as returned by this helper. */
export interface ReconciliationRow {
  id: string;
  loopId: string;
  loopSummary: string;
  eventType: ReconciliationDecision;
  metadata: ReconciliationMeta;
  createdAt: Date;
}

const RECONCILIATION_EVENT_TYPES: ReconciliationDecision[] = [
  "reconciled",
  "reconcile_suggested",
  "superseded",
];

/**
 * Returns the most recent reconciliation loop_events (newest first).
 *
 * @param db  Optional injected DB instance — falls back to getDb() when omitted.
 * @param limit  Max rows to return (default 100).
 */
export async function listRecentReconciliations({
  db,
  limit = 100,
}: {
  db?: DbArg;
  limit?: number;
} = {}): Promise<ReconciliationRow[]> {
  const database = db ?? getDb();

  const rows = await database
    .select({
      id: loopEvents.id,
      loopId: loopEvents.loopId,
      eventType: loopEvents.eventType,
      metadata: loopEvents.metadata,
      createdAt: loopEvents.createdAt,
      loopSummary: loops.summary,
    })
    .from(loopEvents)
    .innerJoin(loops, eq(loopEvents.loopId, loops.id))
    .where(
      inArray(loopEvents.eventType, RECONCILIATION_EVENT_TYPES),
    )
    .orderBy(desc(loopEvents.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    loopId: r.loopId,
    loopSummary: r.loopSummary,
    eventType: r.eventType as ReconciliationDecision,
    metadata: (r.metadata ?? {}) as ReconciliationMeta,
    createdAt: r.createdAt,
  }));
}

/** Human-readable label for display in the admin table. */
export function decisionLabel(eventType: ReconciliationDecision): string {
  switch (eventType) {
    case "reconciled": {
      return "Auto-reconciled";
    }
    case "reconcile_suggested": {
      return "Asked";
    }
    case "superseded": {
      return "Superseded";
    }
  }
}

/** Extract the one-sentence reason from metadata (present on all three types). */
export function extractReason(meta: ReconciliationMeta): string {
  const m = meta as Record<string, unknown>;
  return typeof m.reason === "string" ? m.reason : "—";
}

/** Extract the evidence snippet from metadata (present on all three types). */
export function extractEvidence(meta: ReconciliationMeta): string {
  const m = meta as Record<string, unknown>;
  return typeof m.evidence === "string" ? m.evidence : "—";
}

/** Narrow the action sub-label for 'reconciled' events. */
export function reconciledActionLabel(meta: ReconciliationMeta): string | null {
  const m = meta as Record<string, unknown>;
  if (m.action === "update") return "Auto-updated";
  if (m.action === "close") return "Auto-closed";
  return null;
}
