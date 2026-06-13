import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { nudges, users } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { EmailSender, OutboundEmail, SendResult } from "@/email/outbound";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Sentinel result returned when the send is skipped due to outbound suppression.
 * `providerMessageId` is an empty string so callers that only log it don't crash.
 */
export const SUPPRESSION_SKIP_RESULT: SendResult = { providerMessageId: "", skipped: true };

/**
 * Wraps an `EmailSender` with a pre-send suppression guard.
 *
 * Before every send, when `OutboundEmail.userId` is set, we check the user's
 * `outboundEmailState`. If it is anything other than `'active'` the send is
 * skipped (no network call). When `OutboundEmail.nudgeId` is also set, the
 * nudge is flipped to `status='skipped'` with `metadata.reason='user_suppressed'`
 * so the workflow sees a terminal state and does not re-queue.
 *
 * The guard is inserted by `getEmailSender()` so it applies to both
 * `PostmarkSender` (production) and `DevRecordingSender` (dev/test).
 *
 * DB-injectable: pass `db` in tests; defaults to `getDb()`.
 */
export class SuppressionAwareSender implements EmailSender {
  readonly provider: string;

  private readonly inner: EmailSender;
  private readonly db: Db | undefined;

  constructor(inner: EmailSender, db?: Db) {
    this.inner = inner;
    this.provider = inner.provider;
    this.db = db;
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    if (email.userId) {
      const suppressed = await this.checkSuppressed(email.userId);

      if (suppressed) {
        // TODO: Sentry breadcrumb (Phase 6 A3)

        if (email.nudgeId) {
          await this.markNudgeSkipped(email.nudgeId);
        }

        return SUPPRESSION_SKIP_RESULT;
      }
    }

    return this.inner.send(email);
  }

  private async checkSuppressed(userId: string): Promise<boolean> {
    const resolvedDb = this.db ?? (getDb() as Db);
    const [user] = await resolvedDb
      .select({ outboundEmailState: users.outboundEmailState })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      // Unknown user: let the send proceed; the transport will fail naturally.
      return false;
    }

    return user.outboundEmailState !== "active";
  }

  private async markNudgeSkipped(nudgeId: string): Promise<void> {
    const resolvedDb = this.db ?? (getDb() as Db);
    await resolvedDb
      .update(nudges)
      .set({
        status: "skipped",
        metadata: { reason: "user_suppressed" },
      })
      .where(eq(nudges.id, nudgeId));
  }
}
