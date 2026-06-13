/**
 * score-draft-feedback — daily Inngest cron (02:05 UTC).
 *
 * Computes draft approval metrics from approval_requests over the last 7 days
 * and upserts them into quality_metrics_daily.
 *
 * Metrics written:
 *   draft_approval_rate  = approved / (approved + rejected + edited)
 *   draft_edit_rate      = edited / (approved + edited)
 *
 * Deriving "edited" from the schema:
 * ──────────────────────────────────────────────────────────────────────────
 * The approval_status enum has values: 'pending', 'approved', 'rejected',
 * 'expired', 'cancelled'. There is no explicit 'edited' status.
 *
 * Rationale for derivation:
 *   When a user wants to edit a draft before approving, the typical flow is:
 *     (a) The approval_request is 'rejected' (user declines the prepared draft), and
 *     (b) A NEW approval_request is later created for the same draft (draftId) that
 *         ends up 'approved'.
 *
 * Therefore we define:
 *   "edited" = an approval_request with status 'rejected' where the same draftId
 *              has at least one subsequent approval_request with status 'approved'
 *              (i.e., the draft was eventually approved after an initial rejection).
 *
 * This is the best available signal from the schema: a draft that went
 * reject→approve is treated as "edited then approved".
 *
 * Counts used:
 *   approved = count of approval_requests with status='approved' in window
 *   rejected = count of approval_requests with status='rejected' in window
 *              that do NOT qualify as "edited" (the rejection was final, no later approval)
 *   edited   = count of approval_requests (the rejected leg) where the same draftId
 *              also has an 'approved' row in the window
 *
 * Denominator for draft_approval_rate:  approved + rejected + edited
 * Denominator for draft_edit_rate:      approved + edited
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Inngest determinism: `now` is minted inside step.run in production.
 * DB-injectable: accepts `db` (defaults to getDb()) so tests target test Postgres.
 */

import { and, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { approvalRequests, qualityMetricsDaily } from "@/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DraftFeedbackDb = PostgresJsDatabase<typeof schema>;

export interface ScoreDraftFeedbackOptions {
  /** Current timestamp — must be minted inside Inngest step.run in production. */
  now: Date;
  /** Injectable DB connection; defaults to getDb(). */
  db?: DraftFeedbackDb;
  /**
   * Test-only: restrict the (otherwise global) aggregation to a single user so
   * DB-gated tests are deterministic under parallel workers sharing one Postgres.
   * Production omits this — the cron aggregates across all users.
   */
  scopeUserId?: string;
}

export interface ScoreDraftFeedbackResult {
  /** draft_approval_rate = approved / (approved + rejected + edited). 0 if denominator is 0. */
  draftApprovalRate: number;
  /** draft_edit_rate = edited / (approved + edited). 0 if denominator is 0. */
  draftEditRate: number;
  /** Count breakdown for observability. */
  counts: {
    approved: number;
    rejected: number;
    edited: number;
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function toUtcDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Core logic — exported for tests
// ---------------------------------------------------------------------------

/**
 * Compute draft approval/edit rates from the last 7 days of approval_requests,
 * then upsert into quality_metrics_daily.
 */
export async function scoreDraftFeedback(
  options: ScoreDraftFeedbackOptions,
): Promise<ScoreDraftFeedbackResult> {
  const { now, scopeUserId } = options;
  const db = options.db ?? getDb();

  const todayIso = toUtcDateIso(now);
  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // -----------------------------------------------------------------------
  // Fetch all decided (approved + rejected) approval_requests in the window.
  // We look at decidedAt (the moment the decision was recorded).
  // -----------------------------------------------------------------------

  const decidedRequests = await db
    .select({
      id: approvalRequests.id,
      draftId: approvalRequests.draftId,
      status: approvalRequests.status,
    })
    .from(approvalRequests)
    .where(
      and(
        // Only terminal statuses that count toward the metric
        sql`${approvalRequests.status} IN ('approved', 'rejected')`,
        // Use decidedAt for the window; fall back to createdAt if decidedAt is null
        sql`COALESCE(${approvalRequests.decidedAt}, ${approvalRequests.createdAt}) >= ${windowStart.toISOString()}::timestamptz`,
        scopeUserId ? sql`${approvalRequests.userId} = ${scopeUserId}` : undefined,
      ),
    );

  // -----------------------------------------------------------------------
  // Derive "edited" from the schema.
  //
  // Build a Set of draftIds that have at least one 'approved' row in the window.
  // A 'rejected' row for the same draftId is counted as 'edited' (the user
  // rejected the first draft then later approved a revised one).
  // -----------------------------------------------------------------------

  const approvedDraftIds = new Set<string>(
    decidedRequests
      .filter((r) => r.status === "approved")
      .map((r) => r.draftId),
  );

  let approvedCount = 0;
  let rejectedCount = 0;
  let editedCount = 0;

  for (const req of decidedRequests) {
    if (req.status === "approved") {
      approvedCount++;
    } else if (req.status === "rejected") {
      // If this draft was eventually approved → count the rejection as "edited"
      if (approvedDraftIds.has(req.draftId)) {
        editedCount++;
      } else {
        rejectedCount++;
      }
    }
  }

  // Rate denominators
  const approvalDenominator = approvedCount + rejectedCount + editedCount;
  const editDenominator = approvedCount + editedCount;

  const draftApprovalRate =
    approvalDenominator > 0 ? approvedCount / approvalDenominator : 0;
  const draftEditRate = editDenominator > 0 ? editedCount / editDenominator : 0;

  // -----------------------------------------------------------------------
  // Upsert both metrics into quality_metrics_daily
  // -----------------------------------------------------------------------

  await db
    .insert(qualityMetricsDaily)
    .values({
      date: todayIso,
      metric: "draft_approval_rate",
      value: draftApprovalRate,
      denominator: approvalDenominator,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: [qualityMetricsDaily.date, qualityMetricsDaily.metric],
      set: {
        value: draftApprovalRate,
        denominator: approvalDenominator,
      },
    });

  await db
    .insert(qualityMetricsDaily)
    .values({
      date: todayIso,
      metric: "draft_edit_rate",
      value: draftEditRate,
      denominator: editDenominator,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: [qualityMetricsDaily.date, qualityMetricsDaily.metric],
      set: {
        value: draftEditRate,
        denominator: editDenominator,
      },
    });

  return {
    draftApprovalRate,
    draftEditRate,
    counts: {
      approved: approvedCount,
      rejected: rejectedCount,
      edited: editedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding
// ---------------------------------------------------------------------------

export const scoreDraftFeedbackFunction = inngest.createFunction(
  {
    id: "score-draft-feedback",
    triggers: { cron: "5 2 * * *" },
    retries: 1,
  },
  async ({ step }) => {
    // Mint `now` inside step.run (Inngest determinism rule).
    const result = await step.run("score-draft-feedback-metrics", async () => {
      const now = new Date();
      return scoreDraftFeedback({ now });
    });

    console.log(
      `[score-draft-feedback] draftApprovalRate=${result.draftApprovalRate} draftEditRate=${result.draftEditRate} approved=${result.counts.approved} rejected=${result.counts.rejected} edited=${result.counts.edited}`,
    );

    return result;
  },
);
