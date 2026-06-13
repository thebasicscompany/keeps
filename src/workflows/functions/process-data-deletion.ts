/**
 * process-data-deletion — Inngest function (deliverable 7).
 *
 * Account-wide, IRREVERSIBLE deletion. Triggered by `data.delete_requested`
 * (emitted by POST /api/data/delete after a data_deletion_requests row is
 * created in status 'pending').
 *
 * High-level flow (idempotent on dataDeletionRequestId):
 *   1. Load the data_deletion_requests row.
 *      - If status === 'completed', return EARLY without re-emitting
 *        data.delete_completed. This is the idempotency guard that makes an
 *        Inngest replay (at-least-once delivery) a no-op.
 *   2. Mark status 'in_progress'.
 *   3. Resolve the user's Clerk providerAccountId via user_identities
 *      (provider = 'clerk') and call deleteClerkUser(clerkUserId).
 *      - If the Clerk delete FAILS, we THROW (leaving status 'in_progress')
 *        so Inngest retries with backoff. We delete Clerk FIRST, before any
 *        local cascade, so we never orphan an authenticated Clerk session
 *        pointing at a deleted Keeps account.
 *   4. In ONE DB transaction, in this exact order:
 *      (a) DELETE audit_log WHERE user_id = <userId>     — purge the trail
 *          (audit_log.userId is onDelete:'set null', so the cascade would
 *           ORPHAN these rows; we delete them explicitly instead).
 *      (b) DELETE connector_actions WHERE user_id = <userId>  — see RESTRICT
 *          note below.
 *      (c) DELETE pending_inbound_emails WHERE sender_email = <email>
 *          (no user FK; purge by sender).
 *      (d) DELETE the users row — cascade removes identities / threads /
 *          inbound / messages / source_evidence / loops / loop_events /
 *          nudges / model_calls / connector_accounts / drafts /
 *          approval_requests / outbound_emails / generated_reports.
 *      (e) INSERT one audit_log row, user_id = NULL, action 'user.deleted',
 *          metadata { emailHash: sha256(email), dataDeletionRequestId }.
 *      (f) UPDATE data_deletion_requests SET status='completed', completed_at.
 *   5. AFTER the txn commits, emit data.delete_completed exactly once.
 *
 * RESTRICT note (step b — adversarial-review critical): connector_actions has
 *   connector_account_id uuid NOT NULL REFERENCES connector_accounts ON DELETE
 *   RESTRICT. Both connector_actions.user_id and connector_accounts.user_id
 *   cascade from users. Postgres does NOT guarantee that the cascade delete of
 *   connector_actions runs before the RESTRICT check fires when connector_accounts
 *   is cascade-deleted by the same `DELETE FROM users` statement. To make the
 *   users delete unconditionally safe we explicitly DELETE connector_actions for
 *   the user FIRST, inside the same transaction, so no RESTRICT edge can ever
 *   block the cascade. (Deviation from the literal spec step list, which assumed
 *   the cascade alone would clear connectors; recorded as a hardening decision.)
 *
 * Inngest determinism (AR-5): `now` and any ids are minted inside step.run and
 * passed across step boundaries as primitives (ISO strings). The Clerk client
 * and the DB are injectable so tests never touch Clerk or the prod connection.
 */

import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import {
  users,
  userIdentities,
  auditLog,
  dataDeletionRequests,
} from "@/db/schema";
import type { EventMap } from "@/workflows/events";

// ---------------------------------------------------------------------------
// Types / injectable ports
// ---------------------------------------------------------------------------

export type DataDeletionDb = PostgresJsDatabase<typeof schema>;

/**
 * Deletes the underlying Clerk user. Defaults to the real Clerk Backend SDK.
 * Tests inject a fake that records the call and never hits Clerk.
 */
export type DeleteClerkUser = (clerkUserId: string) => Promise<void>;

/** Event emitter port — defaults to the real typed Inngest send. */
export type EmitEvent = <K extends keyof EventMap>(
  name: K,
  data: EventMap[K],
) => Promise<void>;

export interface RunDataDeletionOptions {
  dataDeletionRequestId: string;
  /** Injectable DB; defaults to getDb(). */
  db?: DataDeletionDb;
  /** Injectable Clerk deleter; defaults to the real Clerk Backend SDK. */
  deleteClerkUser?: DeleteClerkUser;
  /** Injectable event emitter; defaults to the real Inngest send. */
  emitEvent?: EmitEvent;
  /** Injectable clock; defaults to new Date(). Must be minted in step.run in prod. */
  now?: Date;
}

export type RunDataDeletionResult =
  | { status: "completed"; alreadyCompleted: false; userId: string; email: string }
  | { status: "completed"; alreadyCompleted: true; userId: string; email: string }
  | { status: "skipped_not_found" };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Real Clerk deleter. Imported lazily so a missing CLERK_SECRET_KEY at module
 *  load never breaks importing this file (tests inject a fake). */
const defaultDeleteClerkUser: DeleteClerkUser = async (clerkUserId) => {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const client = await clerkClient();
  await client.users.deleteUser(clerkUserId);
};

const defaultEmitEvent: EmitEvent = async (name, data) => {
  await inngest.send({ name, data } as { name: string; data: unknown });
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Core logic — exported for tests
// ---------------------------------------------------------------------------

export async function runDataDeletion(
  options: RunDataDeletionOptions,
): Promise<RunDataDeletionResult> {
  const { dataDeletionRequestId } = options;
  const db = options.db ?? getDb();
  const deleteClerkUser = options.deleteClerkUser ?? defaultDeleteClerkUser;
  const emitEvent = options.emitEvent ?? defaultEmitEvent;
  const now = options.now ?? new Date();

  // --- 1. Load the request row -------------------------------------------------
  const [request] = await db
    .select({
      id: dataDeletionRequests.id,
      userId: dataDeletionRequests.userId,
      email: dataDeletionRequests.email,
      status: dataDeletionRequests.status,
    })
    .from(dataDeletionRequests)
    .where(eq(dataDeletionRequests.id, dataDeletionRequestId))
    .limit(1);

  if (!request) {
    // Nothing to do — request id does not exist. Do not throw (a phantom
    // replay should not retry forever).
    return { status: "skipped_not_found" };
  }

  // --- Idempotency guard: already completed → no work, NO re-emit -------------
  if (request.status === "completed") {
    return {
      status: "completed",
      alreadyCompleted: true,
      userId: request.userId ?? "",
      email: request.email,
    };
  }

  const userId = request.userId;
  const email = request.email;

  // A request with no userId cannot delete an account graph; complete it as a
  // no-op so it does not retry forever. (Defensive — the route always sets userId.)
  if (!userId) {
    await db
      .update(dataDeletionRequests)
      .set({ status: "completed", completedAt: now })
      .where(eq(dataDeletionRequests.id, dataDeletionRequestId));
    return { status: "completed", alreadyCompleted: false, userId: "", email };
  }

  // --- 2. Mark in_progress -----------------------------------------------------
  await db
    .update(dataDeletionRequests)
    .set({ status: "in_progress" })
    .where(eq(dataDeletionRequests.id, dataDeletionRequestId));

  // --- 3. Delete the Clerk user FIRST (external, irreversible) -----------------
  // Resolve the clerk providerAccountId. If the identity is gone (e.g. a prior
  // partial run already cascaded it), skip the Clerk call — there is nothing to
  // delete and we must not block local cleanup.
  const [clerkIdentity] = await db
    .select({ providerAccountId: userIdentities.providerAccountId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, userId),
        eq(userIdentities.provider, "clerk"),
      ),
    )
    .limit(1);

  if (clerkIdentity?.providerAccountId) {
    // If this throws, status stays 'in_progress' and Inngest retries with
    // backoff. We have NOT yet touched the local graph, so a retry is safe.
    await deleteClerkUser(clerkIdentity.providerAccountId);
  }

  // --- 4. Cascade the local graph in one transaction ---------------------------
  await db.transaction(async (tx) => {
    // (a) Purge the user's audit trail (FK is set-null → would orphan otherwise).
    await tx.delete(auditLog).where(eq(auditLog.userId, userId));

    // (b) Drop connector_actions explicitly — connector_actions.connector_account_id
    //     is ON DELETE RESTRICT to connector_accounts, and we cannot rely on the
    //     cascade ordering of `DELETE FROM users`. Removing them first guarantees
    //     the users delete cannot be blocked.
    await tx.execute(
      sql`DELETE FROM connector_actions WHERE user_id = ${userId}::uuid`,
    );

    // (c) Purge pending_inbound_emails by sender (no user FK).
    await tx.execute(
      sql`DELETE FROM pending_inbound_emails WHERE sender_email = ${email}`,
    );

    // (d) Delete the users row — cascade removes the rest of the graph.
    await tx.delete(users).where(eq(users.id, userId));

    // (e) Tombstone audit row: user_id NULL, action 'user.deleted'.
    await tx.insert(auditLog).values({
      userId: null,
      action: "user.deleted",
      actorType: "system",
      metadata: {
        emailHash: sha256(email),
        dataDeletionRequestId,
      },
    });

    // (f) Mark the request completed.
    await tx
      .update(dataDeletionRequests)
      .set({ status: "completed", completedAt: now })
      .where(eq(dataDeletionRequests.id, dataDeletionRequestId));
  });

  // --- 5. Emit completion exactly once (post-commit) ---------------------------
  await emitEvent("data.delete_completed", {
    dataDeletionRequestId,
    userId,
    email,
  });

  return { status: "completed", alreadyCompleted: false, userId, email };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding
// ---------------------------------------------------------------------------

export const processDataDeletionFunction = inngest.createFunction(
  {
    id: "process-data-deletion",
    triggers: { event: "data.delete_requested" },
    retries: 5,
  },
  async ({ event, step }) => {
    const dataDeletionRequestId = event.data.dataDeletionRequestId as string;

    // The Clerk delete + DB cascade run inside a single step so a retry re-enters
    // runDataDeletion, whose status-based guards make every stage idempotent.
    // (now is minted inside the step per AR-5.)
    const result = await step.run("run-data-deletion", async () => {
      return runDataDeletion({
        dataDeletionRequestId,
        now: new Date(),
        // emitEvent omitted → default uses inngest.send; sending an event from
        // inside step.run is fine and is itself deduped by Inngest if replayed.
      });
    });

    console.log(
      `[process-data-deletion] requestId=${dataDeletionRequestId} status=${result.status}` +
        ("alreadyCompleted" in result ? ` alreadyCompleted=${result.alreadyCompleted}` : ""),
    );

    return result;
  },
);
