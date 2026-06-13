/**
 * DB-gated integration tests for runDataDeletion (deliverable 7).
 *
 * Requires a live Postgres at TEST_DATABASE_URL
 * (postgres://postgres:postgres@localhost:55433/keeps). Skipped otherwise.
 *
 * This is the HIGHEST-RISK, irreversible workflow, so the assertions are
 * exhaustive:
 *   1. Cascade: every user-scoped table is empty for user A after deletion,
 *      including model_calls, connector_actions, generated_reports, and A's
 *      audit_log rows (which are explicitly purged, NOT orphaned).
 *   2. pending_inbound_emails for A's sender is gone (purged by sender_email).
 *   3. Exactly one audit_log row with user_id NULL + action 'user.deleted'
 *      + an emailHash exists.
 *   4. The injected fake Clerk deleter was called with A's clerk id.
 *   5. User B and EVERY one of B's rows are completely untouched.
 *   6. Replaying the SAME dataDeletionRequestId is a no-op: status stays
 *      'completed' and data.delete_completed is NOT emitted a second time.
 *
 * No Clerk and no Inngest are ever contacted — deleteClerkUser and emitEvent
 * are injected fakes.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  userIdentities,
  auditLog,
  emailThreads,
  inboundEmails,
  emailMessages,
  sourceEvidence,
  loops,
  loopEvents,
  nudges,
  drafts,
  approvalRequests,
  connectorAccounts,
  connectorActions,
  generatedReports,
  modelCalls,
  pendingInboundEmails,
  dataDeletionRequests,
} from "@/db/schema";
import { runDataDeletion } from "@/workflows/functions/process-data-deletion";
import type { EventMap } from "@/workflows/events";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// biome-ignore lint/suspicious/noExplicitAny: drizzle db handle from postgres-js
type AnyDb = any;

// ---------------------------------------------------------------------------
// Seed: a full account graph for one user. Returns every id we need to assert.
// ---------------------------------------------------------------------------

interface SeededGraph {
  userId: string;
  clerkUserId: string;
  email: string;
  senderEmail: string;
  threadId: string;
  inboundIds: string[];
  loopIds: string[];
  evidenceIds: string[];
  loopEventIds: string[];
  nudgeIds: string[];
  draftId: string;
  approvalRequestId: string;
  connectorAccountId: string;
  connectorActionId: string;
  generatedReportId: string;
  modelCallId: string;
  auditIds: string[];
  pendingInboundId: string;
}

async function seedFullGraph(db: AnyDb, label: string): Promise<SeededGraph> {
  const userId = randomUUID();
  const clerkUserId = `user_clerk_${label}_${randomUUID().slice(0, 8)}`;
  const email = `owner-${label}-${randomUUID().slice(0, 8)}@test.invalid`;
  const senderEmail = `sender-${label}-${randomUUID().slice(0, 8)}@test.invalid`;

  await db.insert(users).values({
    id: userId,
    email,
    timezone: "UTC",
  });

  await db.insert(userIdentities).values({
    id: randomUUID(),
    userId,
    provider: "clerk",
    providerAccountId: clerkUserId,
    email,
    isPrimary: true,
  });

  // Thread
  const threadId = randomUUID();
  await db.insert(emailThreads).values({
    id: threadId,
    userId,
    threadKey: `thread_${randomUUID()}`,
  });

  // 3 inbound emails, each with message + evidence + loop + loop_event(s) + nudge.
  const inboundIds: string[] = [];
  const evidenceIds: string[] = [];
  const loopIds: string[] = [];
  const loopEventIds: string[] = [];
  const nudgeIds: string[] = [];

  for (let i = 0; i < 3; i++) {
    const inboundId = randomUUID();
    inboundIds.push(inboundId);
    await db.insert(inboundEmails).values({
      id: inboundId,
      userId,
      emailThreadId: threadId,
      provider: "postmark",
      providerMessageId: `pm_${label}_${randomUUID()}`,
      senderEmail,
      textBody: `Body ${i}`,
      normalizedPayload: { from: senderEmail },
      rawPayload: { raw: `raw ${i}` },
    });

    await db.insert(emailMessages).values({
      id: randomUUID(),
      userId,
      emailThreadId: threadId,
      inboundEmailId: inboundId,
      providerMessageId: `pm_msg_${label}_${randomUUID()}`,
      fromEmail: senderEmail,
      textBody: `Message ${i}`,
    });

    const evidenceId = randomUUID();
    evidenceIds.push(evidenceId);
    await db.insert(sourceEvidence).values({
      id: evidenceId,
      userId,
      inboundEmailId: inboundId,
      providerMessageId: `pm_${label}_${i}`,
      quote: `Quote ${i}`,
      normalizedBody: `Body ${i}`,
    });

    const loopId = randomUUID();
    loopIds.push(loopId);
    await db.insert(loops).values({
      id: loopId,
      userId,
      emailThreadId: threadId,
      inboundEmailId: inboundId,
      sourceEvidenceId: evidenceId,
      status: "open",
      kind: "commitment",
      basis: "explicit_commitment",
      summary: `Loop ${i}`,
      confidence: 0.9,
    });

    const loopEventId = randomUUID();
    loopEventIds.push(loopEventId);
    await db.insert(loopEvents).values({
      id: loopEventId,
      userId,
      loopId,
      eventType: "created",
    });

    // One pending and one sent nudge across the loops.
    const nudgeId = randomUUID();
    nudgeIds.push(nudgeId);
    await db.insert(nudges).values({
      id: nudgeId,
      userId,
      loopId,
      inboundEmailId: inboundId,
      status: i === 0 ? "pending" : "sent",
      body: `Nudge ${i}`,
      sentAt: i === 0 ? null : new Date(),
    });
  }

  // Draft + approval request (approval references draft).
  const draftId = randomUUID();
  await db.insert(drafts).values({
    id: draftId,
    userId,
    actionKind: "slack_dm",
    payload: { text: "hi" },
    sourceLoopId: loopIds[0],
  });

  const approvalRequestId = randomUUID();
  await db.insert(approvalRequests).values({
    id: approvalRequestId,
    userId,
    draftId,
    actionKind: "slack_dm",
    tokenHash: createHash("sha256").update(`tok_${label}_${randomUUID()}`).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  // Connector account + connector action (action -> account is ON DELETE RESTRICT).
  const connectorAccountId = randomUUID();
  await db.insert(connectorAccounts).values({
    id: connectorAccountId,
    userId,
    provider: "slack",
    composioConnectedAccountId: `cca_${label}_${randomUUID()}`,
    composioEntityId: `ent_${label}_${randomUUID()}`,
    status: "active",
  });

  const connectorActionId = randomUUID();
  await db.insert(connectorActions).values({
    id: connectorActionId,
    userId,
    connectorAccountId,
    draftId,
    approvalRequestId,
    loopId: loopIds[0],
    inboundEmailId: inboundIds[0],
    kind: "slack_dm",
    payload: { text: "hi" },
    idempotencyKey: `idem_${label}_${randomUUID()}`,
    status: "completed",
  });

  // Generated report.
  const generatedReportId = randomUUID();
  await db.insert(generatedReports).values({
    id: generatedReportId,
    userId,
    kind: "insights",
    tokenHash: createHash("sha256").update(`rpt_${label}_${randomUUID()}`).digest("hex"),
    requestedVia: "manual",
  });

  // Model call.
  const modelCallId = randomUUID();
  await db.insert(modelCalls).values({
    id: modelCallId,
    userId,
    inboundEmailId: inboundIds[0],
    purpose: "extract_loops",
    modelId: "test-model",
  });

  // A couple of audit_log rows for this user.
  const auditIds = [randomUUID(), randomUUID()];
  await db.insert(auditLog).values([
    { id: auditIds[0], userId, action: "loop.created", metadata: {} },
    { id: auditIds[1], userId, action: "nudge.sent", metadata: {} },
  ]);

  // Pending inbound email keyed by the user's OWN account email — this is how
  // production keys a user's unclaimed inbound (sender-verification claims by the
  // sender's own address). The deletion purges pending_inbound_emails by the
  // request email, so this row must disappear for A (no user FK on this table).
  const pendingInboundId = randomUUID();
  await db.insert(pendingInboundEmails).values({
    id: pendingInboundId,
    provider: "postmark",
    providerMessageId: `pm_pending_${label}_${randomUUID()}`,
    senderEmail: email,
    normalizedPayload: { from: email },
    rawPayload: { raw: "pending" },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  return {
    userId,
    clerkUserId,
    email,
    senderEmail,
    threadId,
    inboundIds,
    loopIds,
    evidenceIds,
    loopEventIds,
    nudgeIds,
    draftId,
    approvalRequestId,
    connectorAccountId,
    connectorActionId,
    generatedReportId,
    modelCallId,
    auditIds,
    pendingInboundId,
  };
}

// Count helper — rows in a table for a given user. The `users` table keys on
// `id`; every other user-scoped table keys on `user_id`.
async function countByUser(db: AnyDb, table: string, userId: string): Promise<number> {
  const column = table === "users" ? "id" : "user_id";
  const res = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS cnt FROM ${table} WHERE ${column} = '${userId}'`),
  );
  return Number((res[0] as { cnt: number } | undefined)?.cnt ?? 0);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)("runDataDeletion (DB-gated)", () => {
  // biome-ignore lint: non-null assertion safe inside skipIf guard
  const pgClient = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(pgClient, { schema });

  let graphA: SeededGraph;
  let graphB: SeededGraph;
  let requestId: string;

  // Records of injected side-effects.
  const clerkCalls: string[] = [];
  const emittedEvents: Array<{ name: keyof EventMap; data: unknown }> = [];

  const fakeDeleteClerkUser = async (clerkUserId: string) => {
    clerkCalls.push(clerkUserId);
  };
  const fakeEmit = async <K extends keyof EventMap>(name: K, data: EventMap[K]) => {
    emittedEvents.push({ name, data });
  };

  beforeAll(async () => {
    graphA = await seedFullGraph(db, "A");
    graphB = await seedFullGraph(db, "B");

    // Deletion request row for user A.
    const [req] = await db
      .insert(dataDeletionRequests)
      .values({ userId: graphA.userId, email: graphA.email, status: "pending" })
      .returning({ id: dataDeletionRequests.id });
    requestId = req.id;
  });

  afterAll(async () => {
    // Best-effort teardown of B (A is already gone). Children before parents.
    const uid = graphB.userId;
    for (const t of [
      "connector_actions",
      "loop_events",
      "nudges",
      "loops",
      "source_evidence",
      "email_messages",
      "inbound_emails",
      "generated_reports",
      "model_calls",
      "drafts",
      "approval_requests",
      "connector_accounts",
      "email_threads",
      "audit_log",
      "user_identities",
    ]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id = '${uid}'`)).catch(() => {});
    }
    await db.delete(users).where(eq(users.id, uid)).catch(() => {});
    await db
      .delete(pendingInboundEmails)
      .where(eq(pendingInboundEmails.senderEmail, graphB.email))
      .catch(() => {});
    await db
      .delete(dataDeletionRequests)
      .where(eq(dataDeletionRequests.id, requestId))
      .catch(() => {});
    // Tombstone row for A — clean it up by dataDeletionRequestId in metadata.
    await db
      .execute(
        sql`DELETE FROM audit_log WHERE action = 'user.deleted' AND metadata->>'dataDeletionRequestId' = ${requestId}`,
      )
      .catch(() => {});
    await pgClient.end({ timeout: 5 });
  });

  it("first run: cascades A's entire graph, purges audit + pending, deletes Clerk user, leaves B intact", async () => {
    const result = await runDataDeletion({
      dataDeletionRequestId: requestId,
      db,
      deleteClerkUser: fakeDeleteClerkUser,
      emitEvent: fakeEmit,
      now: new Date("2026-06-13T12:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect("alreadyCompleted" in result && result.alreadyCompleted).toBe(false);

    // --- 4. Clerk deleter called with A's clerk id ---------------------------
    expect(clerkCalls).toEqual([graphA.clerkUserId]);

    // --- 1. Every user-scoped table empty for A ------------------------------
    for (const table of [
      "users",
      "user_identities",
      "email_threads",
      "inbound_emails",
      "email_messages",
      "source_evidence",
      "loops",
      "loop_events",
      "nudges",
      "drafts",
      "approval_requests",
      "connector_accounts",
      "connector_actions",
      "generated_reports",
      "model_calls",
      "audit_log",
    ]) {
      const cnt = await countByUser(db, table, graphA.userId);
      expect(cnt, `${table} should be empty for user A`).toBe(0);
    }

    // --- 2. pending_inbound_emails for A's account email gone ----------------
    const pendingA = await db
      .select({ id: pendingInboundEmails.id })
      .from(pendingInboundEmails)
      .where(eq(pendingInboundEmails.senderEmail, graphA.email));
    expect(pendingA.length).toBe(0);

    // --- 3. Exactly one tombstone audit row, user_id NULL + emailHash --------
    const tombstones = await db
      .select({ id: auditLog.id, userId: auditLog.userId, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "user.deleted"),
          sql`${auditLog.metadata}->>'dataDeletionRequestId' = ${requestId}`,
        ),
      );
    expect(tombstones.length).toBe(1);
    expect(tombstones[0].userId).toBeNull();
    const expectedHash = createHash("sha256").update(graphA.email).digest("hex");
    expect((tombstones[0].metadata as Record<string, unknown>).emailHash).toBe(expectedHash);

    // --- request row completed ----------------------------------------------
    const [reqRow] = await db
      .select({ status: dataDeletionRequests.status, completedAt: dataDeletionRequests.completedAt })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.id, requestId));
    expect(reqRow.status).toBe("completed");
    expect(reqRow.completedAt).not.toBeNull();

    // --- exactly one completion event emitted -------------------------------
    const completedEvents = emittedEvents.filter((e) => e.name === "data.delete_completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].data).toMatchObject({
      dataDeletionRequestId: requestId,
      userId: graphA.userId,
      email: graphA.email,
    });

    // --- 5. User B and ALL of B's rows untouched ----------------------------
    const [bUser] = await db.select({ id: users.id }).from(users).where(eq(users.id, graphB.userId));
    expect(bUser?.id).toBe(graphB.userId);

    for (const table of [
      "user_identities",
      "email_threads",
      "inbound_emails",
      "email_messages",
      "source_evidence",
      "loops",
      "loop_events",
      "nudges",
      "drafts",
      "approval_requests",
      "connector_accounts",
      "connector_actions",
      "generated_reports",
      "model_calls",
      "audit_log",
    ]) {
      const cnt = await countByUser(db, table, graphB.userId);
      expect(cnt, `${table} should be preserved for user B`).toBeGreaterThan(0);
    }

    // Specific counts for B (3 inbound, 3 loops, 3 nudges, 1 connector action, etc.)
    expect(await countByUser(db, "inbound_emails", graphB.userId)).toBe(3);
    expect(await countByUser(db, "loops", graphB.userId)).toBe(3);
    expect(await countByUser(db, "nudges", graphB.userId)).toBe(3);
    expect(await countByUser(db, "connector_actions", graphB.userId)).toBe(1);
    expect(await countByUser(db, "model_calls", graphB.userId)).toBe(1);
    expect(await countByUser(db, "generated_reports", graphB.userId)).toBe(1);
    expect(await countByUser(db, "audit_log", graphB.userId)).toBe(2);

    // B's pending inbound (keyed on B's account email) still present.
    const pendingB = await db
      .select({ id: pendingInboundEmails.id })
      .from(pendingInboundEmails)
      .where(eq(pendingInboundEmails.senderEmail, graphB.email));
    expect(pendingB.length).toBe(1);
  });

  it("replay with same request id: no-op, status stays completed, NO second completion event", async () => {
    const clerkCallsBefore = clerkCalls.length;
    const emittedBefore = emittedEvents.length;

    const result = await runDataDeletion({
      dataDeletionRequestId: requestId,
      db,
      deleteClerkUser: fakeDeleteClerkUser,
      emitEvent: fakeEmit,
      now: new Date("2026-06-13T13:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect("alreadyCompleted" in result && result.alreadyCompleted).toBe(true);

    // No new Clerk call, no new event emitted.
    expect(clerkCalls.length).toBe(clerkCallsBefore);
    expect(emittedEvents.length).toBe(emittedBefore);

    // Still exactly one completion event total.
    const completedEvents = emittedEvents.filter((e) => e.name === "data.delete_completed");
    expect(completedEvents.length).toBe(1);

    // Still exactly one tombstone (no duplicate).
    const tombstones = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "user.deleted"),
          sql`${auditLog.metadata}->>'dataDeletionRequestId' = ${requestId}`,
        ),
      );
    expect(tombstones.length).toBe(1);

    // Status unchanged.
    const [reqRow] = await db
      .select({ status: dataDeletionRequests.status })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.id, requestId));
    expect(reqRow.status).toBe("completed");
  });
});
