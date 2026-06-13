/**
 * reports/repository — the SINGLE owner of reads/writes to `generated_reports`.
 *
 * The `ReportsRepository` port is what the B2 service depends on; the
 * `DrizzleReportsRepository` is the production implementation. DB-gated tests
 * can inject a handle pointing at the local 55433 test instance.
 */

import { and, eq, inArray, lt, max, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { generatedReports, inboundEmails, loopEvents, loops, sourceEvidence } from "@/db/schema";
import type { ReportLoop, ReportLoopActivity } from "@/reports/query";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type InsertReportInput = {
  userId: string;
  kind: "insights" | "waiting_on" | "stale" | "weekly" | "entity";
  scope: Record<string, unknown>;
  summary: string;
  tokenHash: string;
  requestedVia: string;
  requestInboundEmailId?: string | null;
  requestNudgeId?: string | null;
};

export type InsertedReport = { id: string; expiresAt: Date; createdAt: Date };

export type StoredReport = {
  id: string;
  userId: string;
  kind: "insights" | "waiting_on" | "stale" | "weekly" | "entity";
  scope: Record<string, unknown>;
  summary: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  lastViewedAt: Date | null;
  viewCount: number;
};

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ReportsRepository {
  insertReport(input: InsertReportInput): Promise<InsertedReport>;

  findReportByTokenHash(tokenHash: string): Promise<StoredReport | null>;

  /**
   * Debounced view bump. Increments view_count + last_viewed_at only when
   * last_viewed_at is null OR older than `debounceMs` before `now`.
   * Returns true when it actually bumped (caller should emit report.viewed).
   */
  touchReportViewed(reportId: string, now: Date, debounceMs?: number): Promise<boolean>;

  /**
   * Loads all non-dismissed loops for the user, joined with source_evidence for
   * the quote. Also computes per-loop lastActivityAt (max of non-'created' loop
   * events and later inbound emails on the thread, excluding the loop's own
   * originating inbound email).
   *
   * NOTE: Entity/scope filtering is intentionally NOT applied here — assembleReport
   * in query.ts is the authoritative bucket+filter step. The `scope` parameter is
   * accepted for forward-compatibility but is ignored for the loop set; returning
   * all non-dismissed loops keeps the repository simple and lets query.ts stay
   * authoritative for all business logic.
   */
  loadLoopsForScope(
    userId: string,
    scope: Record<string, unknown>,
  ): Promise<{ loops: ReportLoop[]; loopActivity: ReportLoopActivity[] }>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

/** Statuses that should be visible to assembleReport (everything except dismissed). */
const VISIBLE_STATUSES: Array<
  "open" | "waiting_on_me" | "waiting_on_other" | "snoozed" | "blocked" | "candidate" | "done"
> = ["open", "waiting_on_me", "waiting_on_other", "snoozed", "blocked", "candidate", "done"];

export class DrizzleReportsRepository implements ReportsRepository {
  private readonly db: ReturnType<typeof getDb>;

  /** `db` is injectable so DB-gated integration tests can target a test Postgres. */
  constructor(db?: ReturnType<typeof getDb>) {
    this.db = db ?? getDb();
  }

  // -------------------------------------------------------------------------

  async insertReport(input: InsertReportInput): Promise<InsertedReport> {
    const [row] = await this.db
      .insert(generatedReports)
      .values({
        userId: input.userId,
        kind: input.kind,
        scope: input.scope,
        summary: input.summary,
        tokenHash: input.tokenHash,
        requestedVia: input.requestedVia,
        requestInboundEmailId: input.requestInboundEmailId ?? null,
        requestNudgeId: input.requestNudgeId ?? null,
        // expiresAt intentionally omitted — DB default applies (now() + 7 days)
      })
      .returning({
        id: generatedReports.id,
        expiresAt: generatedReports.expiresAt,
        createdAt: generatedReports.createdAt,
      });

    return row;
  }

  // -------------------------------------------------------------------------

  async findReportByTokenHash(tokenHash: string): Promise<StoredReport | null> {
    const [row] = await this.db
      .select()
      .from(generatedReports)
      .where(eq(generatedReports.tokenHash, tokenHash))
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      userId: row.userId,
      kind: row.kind,
      scope: row.scope as Record<string, unknown>,
      summary: row.summary,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      lastViewedAt: row.lastViewedAt ?? null,
      viewCount: row.viewCount,
    };
  }

  // -------------------------------------------------------------------------

  async touchReportViewed(
    reportId: string,
    now: Date,
    debounceMs = 5 * 60 * 1000,
  ): Promise<boolean> {
    // Load current lastViewedAt
    const [row] = await this.db
      .select({ lastViewedAt: generatedReports.lastViewedAt })
      .from(generatedReports)
      .where(eq(generatedReports.id, reportId))
      .limit(1);

    if (!row) return false;

    const { lastViewedAt } = row;
    const debounceThreshold = new Date(now.getTime() - debounceMs);

    // Bump only if: never viewed OR last viewed before the debounce threshold
    if (lastViewedAt !== null && lastViewedAt > debounceThreshold) {
      return false;
    }

    await this.db
      .update(generatedReports)
      .set({
        viewCount: sql`${generatedReports.viewCount} + 1`,
        lastViewedAt: now,
      })
      .where(eq(generatedReports.id, reportId));

    return true;
  }

  // -------------------------------------------------------------------------

  async loadLoopsForScope(
    userId: string,
    _scope: Record<string, unknown>,
  ): Promise<{ loops: ReportLoop[]; loopActivity: ReportLoopActivity[] }> {
    // ── 1. Load loops joined to source_evidence ──────────────────────────────
    const rows = await this.db
      .select({
        // loops columns
        id: loops.id,
        status: loops.status,
        summary: loops.summary,
        ownerText: loops.ownerText,
        requesterText: loops.requesterText,
        dueAt: loops.dueAt,
        confidence: loops.confidence,
        participants: loops.participants,
        sourceEvidenceId: loops.sourceEvidenceId,
        emailThreadId: loops.emailThreadId,
        inboundEmailId: loops.inboundEmailId,
        createdAt: loops.createdAt,
        updatedAt: loops.updatedAt,
        // source_evidence columns
        sourceQuote: sourceEvidence.quote,
      })
      .from(loops)
      .innerJoin(sourceEvidence, eq(loops.sourceEvidenceId, sourceEvidence.id))
      .where(
        and(
          eq(loops.userId, userId),
          inArray(loops.status, VISIBLE_STATUSES),
        ),
      );

    if (rows.length === 0) {
      return { loops: [], loopActivity: [] };
    }

    const loopIds = rows.map((r) => r.id);
    const threadIds = [...new Set(rows.map((r) => r.emailThreadId))];

    // ── 2. Max non-'created' loop event per loop (one grouped query) ─────────
    const eventRows = await this.db
      .select({
        loopId: loopEvents.loopId,
        maxCreatedAt: max(loopEvents.createdAt).as("max_created_at"),
      })
      .from(loopEvents)
      .where(
        and(
          inArray(loopEvents.loopId, loopIds),
          ne(loopEvents.eventType, "created"),
        ),
      )
      .groupBy(loopEvents.loopId);

    const eventMaxMap = new Map<string, Date>();
    for (const e of eventRows) {
      if (e.maxCreatedAt) {
        eventMaxMap.set(e.loopId, new Date(e.maxCreatedAt));
      }
    }

    // ── 3. Max providerReceivedAt of LATER inbound emails per thread ─────────
    //    Exclude the loop's originating inboundEmailId per loop. We collect the
    //    max per thread (excluding any of the originating IDs), then apply the
    //    per-loop exclusion in-memory. This keeps us at ≤ 2 grouped queries.
    const originatingEmailIds = [...new Set(rows.map((r) => r.inboundEmailId))];

    const threadEmailRows = await this.db
      .select({
        emailThreadId: inboundEmails.emailThreadId,
        inboundEmailId: inboundEmails.id,
        providerReceivedAt: inboundEmails.providerReceivedAt,
      })
      .from(inboundEmails)
      .where(
        and(
          inArray(inboundEmails.emailThreadId, threadIds),
          // Exclude all originating inbound emails across this user's loops
          // (fine-grained per-loop exclusion happens below in-memory)
          sql`${inboundEmails.id} NOT IN (${sql.join(
            originatingEmailIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
      );

    // Build a map: threadId → list of { id, providerReceivedAt }
    const threadEmailsMap = new Map<string, Array<{ id: string; at: Date | null }>>();
    for (const r of threadEmailRows) {
      let list = threadEmailsMap.get(r.emailThreadId);
      if (!list) {
        list = [];
        threadEmailsMap.set(r.emailThreadId, list);
      }
      list.push({ id: r.inboundEmailId, at: r.providerReceivedAt });
    }

    // ── 4. Assemble ReportLoop + ReportLoopActivity ──────────────────────────
    const reportLoops: ReportLoop[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      summary: r.summary,
      ownerText: r.ownerText ?? null,
      requesterText: r.requesterText ?? null,
      dueAt: r.dueAt ?? null,
      confidence: r.confidence,
      participants: (r.participants as Array<{ name?: string | null; email?: string | null }>) ?? [],
      sourceQuote: r.sourceQuote,
      sourceEvidenceId: r.sourceEvidenceId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    const loopActivity: ReportLoopActivity[] = rows.map((r) => {
      const eventMax = eventMaxMap.get(r.id) ?? null;

      // Find max providerReceivedAt for emails on this loop's thread,
      // excluding the loop's own originating inboundEmailId.
      const threadEmails = threadEmailsMap.get(r.emailThreadId) ?? [];
      let emailMax: Date | null = null;
      for (const e of threadEmails) {
        if (e.id === r.inboundEmailId) continue; // exclude originating email (redundant safety)
        if (e.at !== null && (emailMax === null || e.at > emailMax)) {
          emailMax = e.at;
        }
      }

      // lastActivityAt = max(eventMax, emailMax); null if neither
      let lastActivityAt: Date | null = null;
      if (eventMax !== null && emailMax !== null) {
        lastActivityAt = eventMax > emailMax ? eventMax : emailMax;
      } else {
        lastActivityAt = eventMax ?? emailMax;
      }

      return { loopId: r.id, lastActivityAt };
    });

    return { loops: reportLoops, loopActivity };
  }
}
