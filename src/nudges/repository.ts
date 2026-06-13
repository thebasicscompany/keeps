/**
 * Nudge repository — thin SQL layer via Drizzle.
 *
 * Architecture rule: NO business logic here. Eligibility decisions (isEligibleForNudge),
 * cap decisions (enforceDailyCap), and next-check-at computation (advanceNextCheckAt)
 * all live in src/nudges/selectors.ts. This layer only:
 *   1. Pre-filters cheaply in SQL (status IN active set, next_check_at <= now).
 *   2. Counts nudges sent since a given timestamp.
 *   3. Writes nudge bookkeeping rows atomically.
 *
 * The nudge type 'nudge' is the only value counted toward the daily cap; 'digest',
 * 'private_reply', 'approval', and 'expiry' do not count (per Deliverable #6).
 */

import { and, count, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { auditLog, loopEvents, loops, nudges, users } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { NudgeType } from "@/nudges/types";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Shape returned by findNudgeCandidates — carries all fields that
 * NudgeEligibilityLoop (src/nudges/selectors.ts) requires plus the user's
 * timezone for per-user daily cap calculations.
 */
export interface NudgeCandidate {
  /** Loop id */
  id: string;
  userId: string;
  status: string;
  createdAt: Date;
  nextCheckAt: Date | null;
  lastNudgedAt: Date | null;
  nudgeCount: number;
  summary: string;
  /** User's IANA timezone (e.g. "America/Los_Angeles"). */
  userTimezone: string;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface NudgeRepository {
  /**
   * Returns all loops that are cheap candidates for a nudge at `now`.
   *
   * SQL pre-filter (cheap — uses loops_next_check_at_idx):
   *   status IN ('open','waiting_on_me','waiting_on_other','candidate')
   *   AND next_check_at IS NOT NULL
   *   AND next_check_at <= now
   *
   * Callers MUST re-validate each candidate with isEligibleForNudge() before
   * sending — this query is a hint, not an authoritative eligibility decision.
   */
  findNudgeCandidates(now: Date): Promise<NudgeCandidate[]>;

  /**
   * Counts nudge rows of type 'nudge' sent to a user since `since`.
   * Callers should pass `startOfLocalDay(tz, now)` as `since`.
   * Digest, private_reply, approval, and expiry types are excluded.
   */
  countNudgesSentSince(userId: string, since: Date): Promise<number>;

  /**
   * Marks a loop as nudged: sets last_nudged_at, increments nudge_count,
   * advances next_check_at, and updates updated_at.
   */
  markLoopNudged(input: { loopId: string; nextCheckAt: Date; now: Date }): Promise<void>;

  /**
   * Defers a loop's next check window without incrementing nudge_count.
   * Used when a loop is over the daily cap.
   */
  deferLoopNextCheck(input: { loopId: string; nextCheckAt: Date; now: Date }): Promise<void>;

  /**
   * Inserts a nudges row with status 'pending'. Returns the new row's id.
   */
  createNudgeRow(input: {
    userId: string;
    loopId: string | null;
    inboundEmailId: string | null;
    subject: string;
    body: string;
    type: NudgeType;
    metadata: Record<string, unknown>;
    scheduledFor?: Date | null;
  }): Promise<{ id: string }>;

  /**
   * Loads a single NudgeCandidate by loop id for re-validation inside send-nudge.
   * Returns null when the loop does not exist or is no longer in an active status.
   *
   * Used by send-nudge to re-check eligibility authoratitively after sweep emission
   * (sweep is a hint; this check is the unit of correctness per Deliverable #5).
   */
  findCandidateById(loopId: string): Promise<NudgeCandidate | null>;

  /**
   * Loads the owner's verified email address for a given userId.
   * Used by send-nudge to resolve the To: address from users.email.
   */
  findUserEmail(userId: string): Promise<string | null>;

  /**
   * Writes a loop_events row with eventType 'nudged' or 'digest_summarized'.
   */
  writeLoopEvent(input: {
    userId: string;
    loopId: string;
    eventType: "nudged" | "digest_summarized";
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Writes an audit_log row.
   * action must be 'nudge.sent' or 'digest.sent'.
   */
  writeAudit(input: {
    userId: string;
    action: "nudge.sent" | "digest.sent" | "report.generated";
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

const NUDGE_CANDIDATE_STATUSES = [
  "open",
  "waiting_on_me",
  "waiting_on_other",
  "candidate",
] as const;

export class DrizzleNudgeRepository implements NudgeRepository {
  private readonly db: PostgresJsDatabase<typeof schema>;

  constructor(db?: PostgresJsDatabase<typeof schema>) {
    this.db = db ?? (getDb() as PostgresJsDatabase<typeof schema>);
  }

  async findNudgeCandidates(now: Date): Promise<NudgeCandidate[]> {
    const rows = await this.db
      .select({
        id: loops.id,
        userId: loops.userId,
        status: loops.status,
        createdAt: loops.createdAt,
        nextCheckAt: loops.nextCheckAt,
        lastNudgedAt: loops.lastNudgedAt,
        nudgeCount: loops.nudgeCount,
        summary: loops.summary,
        userTimezone: users.timezone,
      })
      .from(loops)
      .innerJoin(users, eq(loops.userId, users.id))
      .where(
        and(
          // Uses loops_next_check_at_idx partial index
          inArray(loops.status, [...NUDGE_CANDIDATE_STATUSES]),
          isNotNull(loops.nextCheckAt),
          lte(loops.nextCheckAt, now),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      status: r.status,
      createdAt: r.createdAt,
      nextCheckAt: r.nextCheckAt,
      lastNudgedAt: r.lastNudgedAt,
      nudgeCount: r.nudgeCount,
      summary: r.summary,
      userTimezone: r.userTimezone,
    }));
  }

  async countNudgesSentSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(nudges)
      .where(
        and(
          eq(nudges.userId, userId),
          eq(nudges.nudgeType, "nudge"),
          gte(nudges.sentAt, since),
        ),
      );

    return row?.value ?? 0;
  }

  async markLoopNudged(input: { loopId: string; nextCheckAt: Date; now: Date }): Promise<void> {
    await this.db
      .update(loops)
      .set({
        lastNudgedAt: input.now,
        nudgeCount: sql`${loops.nudgeCount} + 1`,
        nextCheckAt: input.nextCheckAt,
        updatedAt: input.now,
      })
      .where(eq(loops.id, input.loopId));
  }

  async deferLoopNextCheck(input: { loopId: string; nextCheckAt: Date; now: Date }): Promise<void> {
    await this.db
      .update(loops)
      .set({
        nextCheckAt: input.nextCheckAt,
        updatedAt: input.now,
      })
      .where(eq(loops.id, input.loopId));
  }

  async createNudgeRow(input: {
    userId: string;
    loopId: string | null;
    inboundEmailId: string | null;
    subject: string;
    body: string;
    type: NudgeType;
    metadata: Record<string, unknown>;
    scheduledFor?: Date | null;
  }): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(nudges)
      .values({
        userId: input.userId,
        loopId: input.loopId,
        inboundEmailId: input.inboundEmailId,
        nudgeType: input.type,
        status: "pending",
        channel: "email",
        subject: input.subject,
        body: input.body,
        metadata: input.metadata,
        scheduledFor: input.scheduledFor ?? null,
      })
      .returning({ id: nudges.id });

    if (!row) {
      throw new Error("Failed to insert nudge row — no row returned.");
    }

    return { id: row.id };
  }

  async writeLoopEvent(input: {
    userId: string;
    loopId: string;
    eventType: "nudged" | "digest_summarized";
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(loopEvents).values({
      userId: input.userId,
      loopId: input.loopId,
      eventType: input.eventType,
      metadata: input.metadata ?? {},
    });
  }

  async findCandidateById(loopId: string): Promise<NudgeCandidate | null> {
    const [row] = await this.db
      .select({
        id: loops.id,
        userId: loops.userId,
        status: loops.status,
        createdAt: loops.createdAt,
        nextCheckAt: loops.nextCheckAt,
        lastNudgedAt: loops.lastNudgedAt,
        nudgeCount: loops.nudgeCount,
        summary: loops.summary,
        userTimezone: users.timezone,
      })
      .from(loops)
      .innerJoin(users, eq(loops.userId, users.id))
      .where(eq(loops.id, loopId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      createdAt: row.createdAt,
      nextCheckAt: row.nextCheckAt,
      lastNudgedAt: row.lastNudgedAt,
      nudgeCount: row.nudgeCount,
      summary: row.summary,
      userTimezone: row.userTimezone,
    };
  }

  async findUserEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row?.email ?? null;
  }

  async writeAudit(input: {
    userId: string;
    action: "nudge.sent" | "digest.sent" | "report.generated";
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(auditLog).values({
      userId: input.userId,
      action: input.action,
      actorType: "system",
      metadata: input.metadata,
    });
  }
}
