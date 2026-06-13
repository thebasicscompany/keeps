/**
 * raw-email-retention-purge — Inngest cron function (daily at 03:00 UTC).
 *
 * For each user with rawEmailRetentionDays IS NOT NULL:
 *   - Finds inbound_emails created before (now - retentionDays) that are not yet scrubbed.
 *   - Scrubs those rows: clears raw_payload, html_body, text_body, stripped_text_reply,
 *     attachment_metadata, headers, and sets normalized_payload = { scrubbed, scrubbed_at }.
 *   - Scrubs the corresponding email_messages rows (text_body, html_body,
 *     stripped_text_reply, scrubbed_at).
 *   - Does NOT touch source_evidence or loops — the quote in source_evidence.quote
 *     is captured at extraction time and must survive the purge.
 *
 * Idempotent: rows with scrubbed_at IS NOT NULL are excluded by the WHERE clause.
 *
 * AR-5 / Inngest determinism: `now` is minted inside step.run and passed as
 * an ISO string. The exported `runRetentionPurge` accepts an injectable `now`
 * so tests are deterministic.
 *
 * DB-injectable: accepts a `db` param (default getDb()) so tests can target
 * the local Postgres without touching the production connection.
 */

import { sql, isNull, and, lt, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { users, inboundEmails, emailMessages } from "@/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetentionPurgeDb = PostgresJsDatabase<typeof schema>;

export interface RunRetentionPurgeOptions {
  /** Current timestamp — must be minted inside Inngest step.run in production. */
  now: Date;
  /** Injectable DB connection; defaults to getDb(). */
  db?: RetentionPurgeDb;
}

export interface RetentionPurgeResult {
  /** Total inbound_email rows scrubbed across all users. */
  scrubbedInboundCount: number;
  /** Total email_message rows scrubbed across all users. */
  scrubbedMessageCount: number;
  /** Number of users whose retention window was checked. */
  usersProcessed: number;
}

// ---------------------------------------------------------------------------
// Core logic — exported for tests
// ---------------------------------------------------------------------------

/**
 * Run the retention purge.
 *
 * Works per-user so that different users' retention windows are handled
 * independently. Processes users in a single batch of up to 1000 at a time.
 */
export async function runRetentionPurge(
  options: RunRetentionPurgeOptions,
): Promise<RetentionPurgeResult> {
  const { now } = options;
  const db = options.db ?? getDb();

  let scrubbedInboundCount = 0;
  let scrubbedMessageCount = 0;

  // Fetch all users that have an explicit retention policy (IS NOT NULL).
  // Limit to 1000 per run; a subsequent run handles overflow.
  const eligibleUsers = await db
    .select({
      id: users.id,
      rawEmailRetentionDays: users.rawEmailRetentionDays,
    })
    .from(users)
    .where(
      and(
        // rawEmailRetentionDays IS NOT NULL — null means "keep forever"
        sql`${users.rawEmailRetentionDays} IS NOT NULL`,
      ),
    )
    .limit(1000);

  const usersProcessed = eligibleUsers.length;

  for (const user of eligibleUsers) {
    // retentionDays is guaranteed non-null by the IS NOT NULL filter above
    const retentionDays = user.rawEmailRetentionDays as number;

    // Compute the cutoff: emails created before this instant are eligible.
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoff.toISOString();
    const nowIso = now.toISOString();

    // Find inbound_emails for this user that are past retention and not yet scrubbed.
    const expiredEmails = await db
      .select({ id: inboundEmails.id })
      .from(inboundEmails)
      .where(
        and(
          sql`${inboundEmails.userId} = ${user.id}`,
          lt(inboundEmails.createdAt, cutoff),
          isNull(inboundEmails.scrubbedAt),
        ),
      );

    if (expiredEmails.length === 0) {
      continue;
    }

    const expiredIds = expiredEmails.map((r) => r.id);

    // Build the id array literal once — trusted UUIDs from DB, safe to inline.
    const idArrayLiteral = `ARRAY[${expiredIds.map((id) => `'${id}'::uuid`).join(",")}]`;

    // Scrub inbound_emails rows.
    // nowIso is inlined via sql.raw so Postgres never sees an untyped $N parameter
    // inside jsonb_build_object (which would produce "could not determine data type").
    await db.execute(sql`
      UPDATE inbound_emails
      SET
        raw_payload              = '{}'::jsonb,
        html_body                = NULL,
        text_body                = '',
        stripped_text_reply      = NULL,
        attachment_metadata      = '[]'::jsonb,
        headers                  = '{}'::jsonb,
        normalized_payload       = jsonb_build_object(
                                     'scrubbed',    true,
                                     'scrubbed_at', ${sql.raw(`'${nowIso}'`)}
                                   ),
        scrubbed_at              = ${sql.raw(`'${nowIso}'`)}::timestamptz
      WHERE id = ANY(${sql.raw(idArrayLiteral)})
        AND scrubbed_at IS NULL
    `);

    scrubbedInboundCount += expiredIds.length;

    // Scrub the corresponding email_messages rows.
    await db.execute(sql`
      UPDATE email_messages
      SET
        text_body           = '',
        html_body           = NULL,
        stripped_text_reply = NULL,
        scrubbed_at         = ${sql.raw(`'${nowIso}'`)}::timestamptz
      WHERE inbound_email_id = ANY(${sql.raw(idArrayLiteral)})
        AND scrubbed_at IS NULL
    `);

    // Count scrubbed email_messages for the result.
    const countResult = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt
      FROM email_messages
      WHERE inbound_email_id = ANY(${sql.raw(idArrayLiteral)})
        AND scrubbed_at = ${sql.raw(`'${nowIso}'`)}::timestamptz
    `);

    const cnt = Number((countResult[0] as { cnt: string } | undefined)?.cnt ?? "0");
    scrubbedMessageCount += cnt;
  }

  return {
    scrubbedInboundCount,
    scrubbedMessageCount,
    usersProcessed,
  };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding
// ---------------------------------------------------------------------------

export const rawEmailRetentionPurgeFunction = inngest.createFunction(
  {
    id: "raw-email-retention-purge",
    triggers: { cron: "0 3 * * *" },
    retries: 1,
  },
  async ({ step }) => {
    // Step 1: mint `now` inside step.run (Inngest determinism rule).
    const result = await step.run("purge-expired-raw-emails", async () => {
      const now = new Date();
      return runRetentionPurge({ now });
    });

    console.log(
      `[raw-email-retention-purge] usersProcessed=${result.usersProcessed} scrubbedInbound=${result.scrubbedInboundCount} scrubbedMessages=${result.scrubbedMessageCount}`,
    );

    return result;
  },
);
