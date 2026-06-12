/**
 * Digest repository — thin SQL layer via Drizzle.
 *
 * Architecture rule: NO business logic here. Hour-matching and eligibility
 * decisions stay in the pure functions from Wave A:
 *   - src/users/timezone.ts  → usersDueAtHour() does the hour-matching in TS.
 *     The SQL only fetches ALL digest-enabled users; the caller filters by hour.
 *     Rationale: the DB index (users_digest_send_hour_idx) makes the full-table
 *     scan cheap (<< 1 ms for alpha scale), and keeping the hour logic in TS
 *     avoids re-implementing localHourFor() in SQL and keeps timezone math
 *     testable without a live DB.
 *   - hasRecentDigest() implements the in-function idempotency guard described
 *     in Risks #3 (simpler than a partial unique index; upgrade path is noted).
 */

import { and, eq, gt, gte, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { loops, nudges, users } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { DigestLoopInput } from "@/digests/build";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface DigestUser {
  id: string;
  email: string;
  displayName: string | null;
  timezone: string;
  digestEnabled: boolean;
  digestSendHour: number;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface DigestRepository {
  /**
   * Returns all users where digest_enabled = true.
   *
   * NOTE: Hour-matching is intentionally done in TypeScript via usersDueAtHour()
   * (src/users/timezone.ts) rather than in SQL. This keeps timezone math
   * centralised in the pure helper and avoids duplicating DST-aware logic in
   * SQL. The users_digest_send_hour_idx partial index makes this fetch cheap.
   */
  findDigestEnabledUsers(): Promise<DigestUser[]>;

  /**
   * Returns loops for a user that should appear in their daily digest:
   *   - status IN ('open', 'waiting_on_me', 'waiting_on_other'), OR
   *   - status = 'done' AND updated_at >= now - 24h
   *
   * Returns exactly the DigestLoopInput shape consumed by buildDigest().
   */
  findLoopsForDigest(userId: string, now: Date): Promise<DigestLoopInput[]>;

  /**
   * Returns true if a digest has been sent (sent_at IS NOT NULL) to the user
   * within the last 23 hours — the in-function idempotency guard (Risks #3).
   *
   * Upgrade path: if double-sends are observed in production, add a partial
   * unique index on (user_id, nudge_type, date_trunc('day', sent_at AT TIME ZONE
   * <user_tz>)) as a hard DB-level guard. Document as a Phase 6 follow-up.
   */
  hasRecentDigest(userId: string, now: Date): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

const MS_24H = 24 * 60 * 60 * 1000;
const MS_23H = 23 * 60 * 60 * 1000;

const DIGEST_LOOP_STATUSES = ["open", "waiting_on_me", "waiting_on_other"] as const;

export class DrizzleDigestRepository implements DigestRepository {
  private readonly db: PostgresJsDatabase<typeof schema>;

  constructor(db?: PostgresJsDatabase<typeof schema>) {
    this.db = db ?? (getDb() as PostgresJsDatabase<typeof schema>);
  }

  async findDigestEnabledUsers(): Promise<DigestUser[]> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        timezone: users.timezone,
        digestEnabled: users.digestEnabled,
        digestSendHour: users.digestSendHour,
      })
      .from(users)
      .where(eq(users.digestEnabled, true));

    return rows;
  }

  async findLoopsForDigest(userId: string, now: Date): Promise<DigestLoopInput[]> {
    const cutoff24h = new Date(now.getTime() - MS_24H);

    const rows = await this.db
      .select({
        id: loops.id,
        emailThreadId: loops.emailThreadId,
        status: loops.status,
        summary: loops.summary,
        dueAt: loops.dueAt,
        nextCheckAt: loops.nextCheckAt,
        updatedAt: loops.updatedAt,
        lastNudgedAt: loops.lastNudgedAt,
      })
      .from(loops)
      .where(
        and(
          eq(loops.userId, userId),
          or(
            // Active statuses always included
            and(
              // status IN ('open','waiting_on_me','waiting_on_other')
              // Drizzle inArray would work too but this avoids an extra import
              or(
                eq(loops.status, "open"),
                eq(loops.status, "waiting_on_me"),
                eq(loops.status, "waiting_on_other"),
              ),
            ),
            // Recently done: done AND updated_at >= now - 24h
            and(
              eq(loops.status, "done"),
              gte(loops.updatedAt, cutoff24h),
            ),
          ),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      emailThreadId: r.emailThreadId,
      status: r.status,
      summary: r.summary,
      dueAt: r.dueAt,
      nextCheckAt: r.nextCheckAt,
      updatedAt: r.updatedAt,
      lastNudgedAt: r.lastNudgedAt,
    }));
  }

  async hasRecentDigest(userId: string, now: Date): Promise<boolean> {
    const cutoff23h = new Date(now.getTime() - MS_23H);

    const [row] = await this.db
      .select({ id: nudges.id })
      .from(nudges)
      .where(
        and(
          eq(nudges.userId, userId),
          eq(nudges.nudgeType, "digest"),
          // sent_at IS NOT NULL — digest was actually sent (not just queued)
          gt(nudges.sentAt, cutoff23h),
        ),
      )
      .limit(1);

    return row !== undefined;
  }
}
