/**
 * DB-gated test plumbing for the connector e2e fixtures (E1, E2, E5, E6).
 *
 * Mirrors execute.db.test.ts's harness: a dedicated postgres-js connection to the
 * TEST_DATABASE_URL instance, a per-suite seeded user + connector_account, and a
 * teardown that deletes every row the suite created. The execute-once layer's real
 * SELECT ... FOR UPDATE lock is only exercisable against a real Postgres, so the
 * paths that actually execute (E1/E2/E5/E6) seed real rows here.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  approvalRequests,
  auditLog,
  connectorAccounts,
  connectorActions,
  drafts,
  emailThreads,
  inboundEmails,
  users,
  type ConnectorAccount,
} from "@/db/schema";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface E2eDb {
  sql: ReturnType<typeof postgres>;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle concrete type; harness only uses insert/select/update.
  db: any;
  userId: string;
  connectorAccountId: string;
  account: ConnectorAccount;
  /** A real inbound_emails row id (FK target for connector_actions.inbound_email_id). */
  inboundEmailId: string;
  /** delete every row this suite created, then close the connection. */
  teardown: () => Promise<void>;
}

/**
 * Open a connection, seed a user + an ACTIVE slack connector_account, and return a
 * handle + teardown. `provider` chooses the seeded connector_account provider so the
 * calendar fixtures (E5) seed a google_calendar account.
 */
export async function setupE2eDb(opts?: {
  provider?: "slack" | "google_calendar";
  timezone?: string;
}): Promise<E2eDb> {
  // biome-ignore lint: guarded by the skipIf at the call site.
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });

  const [u] = await db
    .insert(users)
    .values({
      email: `test-e2e-connector-${randomUUID()}@test.invalid`,
      timezone: opts?.timezone ?? "UTC",
    })
    .returning();
  const userId = u.id;

  const [acct] = await db
    .insert(connectorAccounts)
    .values({
      id: randomUUID(),
      userId,
      provider: opts?.provider ?? "slack",
      composioConnectedAccountId: `ca_e2e_${randomUUID()}`,
      composioEntityId: userId,
      status: "active",
    })
    .returning();

  // Seed a real thread + inbound email so connector_actions.inbound_email_id (a uuid
  // FK to inbound_emails) is satisfiable — the flow genuinely originates from a stored
  // inbound email, as in production.
  const [thread] = await db
    .insert(emailThreads)
    .values({ id: randomUUID(), userId, threadKey: `thread_${randomUUID()}` })
    .returning();

  const [inbound] = await db
    .insert(inboundEmails)
    .values({
      id: randomUUID(),
      userId,
      emailThreadId: thread.id,
      provider: "postmark",
      providerMessageId: `pm_${randomUUID()}`,
      senderEmail: u.email,
      normalizedPayload: {},
      rawPayload: {},
    })
    .returning();

  return {
    sql,
    db,
    userId,
    connectorAccountId: acct.id,
    account: acct as ConnectorAccount,
    inboundEmailId: inbound.id,
    teardown: async () => {
      await db.delete(connectorActions).where(eq(connectorActions.userId, userId));
      await db.delete(approvalRequests).where(eq(approvalRequests.userId, userId));
      await db.delete(drafts).where(eq(drafts.userId, userId));
      await db.delete(connectorAccounts).where(eq(connectorAccounts.userId, userId));
      await db.delete(inboundEmails).where(eq(inboundEmails.userId, userId));
      await db.delete(emailThreads).where(eq(emailThreads.userId, userId));
      await db.delete(auditLog).where(eq(auditLog.userId, userId));
      await db.delete(users).where(inArray(users.id, [userId]));
      await sql.end();
    },
  };
}

/** Count audit rows of a given action for a user (E6's policy.authorize_denied check). */
export async function countAudit(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db handle.
  db: any,
  userId: string,
  action: string,
): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id, action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.userId, userId));
  return rows.filter((r: { action: string }) => r.action === action).length;
}

/** Read a connector_actions row by id. */
export async function getConnectorAction(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db handle.
  db: any,
  id: string,
) {
  const [row] = await db
    .select()
    .from(connectorActions)
    .where(eq(connectorActions.id, id))
    .limit(1);
  return row ?? null;
}

/** Count connector_actions rows in 'completed' status for a user (E2 single-row check). */
export async function countCompletedActions(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db handle.
  db: any,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ status: connectorActions.status })
    .from(connectorActions)
    .where(eq(connectorActions.userId, userId));
  return rows.filter((r: { status: string }) => r.status === "completed").length;
}
