/**
 * DB-gated integration tests for assembleEntityReport (Phase 7 C1).
 *
 * Exercises the REAL entity-graph SQL against a live Postgres instance.
 * SKIPPED unless TEST_DATABASE_URL is set:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/reports/entity-report.db.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  emailThreads,
  entities,
  inboundEmails,
  loopEntities,
  loopEvents,
  loops,
  sourceEvidence,
  users,
} from "@/db/schema";
import { assembleEntityReport } from "@/reports/query";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("assembleEntityReport (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });

  const RUN_ID = Date.now();

  let userId: string;
  let entityId: string;
  let thread1Id: string;
  let thread2Id: string;
  let inbound1Id: string;
  let inbound2Id: string;

  // Loop ids (captured for event seeding + assertions)
  let openOwnerId: string; // linked via loops.ownerEntityId, status open, thread 1
  let openJoinId: string; // linked via loop_entities (participant), waiting_on_other, thread 2
  let closedId: string; // linked via loop_entities (owner), done, thread 1
  let suppressedId: string; // linked via loops.ownerEntityId, status suppressed → EXCLUDED

  const ENTITY_FIRST_SEEN = new Date("2026-05-01T08:00:00.000Z");
  const ENTITY_LAST_SEEN = new Date("2026-06-12T08:00:00.000Z");
  const OPEN_OWNER_UPDATED = new Date("2026-06-12T10:00:00.000Z");
  const OPEN_JOIN_UPDATED = new Date("2026-06-11T10:00:00.000Z");
  const CLOSED_UPDATED = new Date("2026-06-05T10:00:00.000Z");
  const EVENT_1_AT = new Date("2026-06-12T11:00:00.000Z");
  const EVENT_2_AT = new Date("2026-06-10T11:00:00.000Z");

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-entity-report-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    const [ent] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person",
        displayName: "Dana Client",
        canonicalEmail: `dana-${RUN_ID}@example.com`,
        firstSeenAt: ENTITY_FIRST_SEEN,
        lastSeenAt: ENTITY_LAST_SEEN,
      })
      .returning({ id: entities.id });
    entityId = ent.id;

    const [t1] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `thread-entity-1-${RUN_ID}` })
      .returning({ id: emailThreads.id });
    thread1Id = t1.id;
    const [t2] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `thread-entity-2-${RUN_ID}` })
      .returning({ id: emailThreads.id });
    thread2Id = t2.id;

    const [ie1] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: thread1Id,
        provider: "test",
        providerMessageId: `msg-entity-1-${RUN_ID}`,
        senderEmail: "dana@example.com",
        normalizedPayload: {},
        rawPayload: {},
        providerReceivedAt: ENTITY_FIRST_SEEN,
      })
      .returning({ id: inboundEmails.id });
    inbound1Id = ie1.id;
    const [ie2] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: thread2Id,
        provider: "test",
        providerMessageId: `msg-entity-2-${RUN_ID}`,
        senderEmail: "dana@example.com",
        normalizedPayload: {},
        rawPayload: {},
        providerReceivedAt: ENTITY_FIRST_SEEN,
      })
      .returning({ id: inboundEmails.id });
    inbound2Id = ie2.id;

    // Each loop needs its own source_evidence row.
    const mkEvidence = async (inboundEmailId: string, suffix: string): Promise<string> => {
      const [se] = await db
        .insert(sourceEvidence)
        .values({
          userId,
          inboundEmailId,
          providerMessageId: `msg-entity-${suffix}-${RUN_ID}`,
          quote: `quote ${suffix}`,
        })
        .returning({ id: sourceEvidence.id });
      return se.id;
    };

    const ev1 = await mkEvidence(inbound1Id, "open-owner");
    const ev2 = await mkEvidence(inbound2Id, "open-join");
    const ev3 = await mkEvidence(inbound1Id, "closed");
    const ev4 = await mkEvidence(inbound1Id, "suppressed");

    const mkLoop = async (input: {
      threadId: string;
      inboundEmailId: string;
      evidenceId: string;
      status: "open" | "waiting_on_other" | "done" | "suppressed";
      summary: string;
      updatedAt: Date;
      ownerEntityId?: string;
    }): Promise<string> => {
      const [l] = await db
        .insert(loops)
        .values({
          userId,
          emailThreadId: input.threadId,
          inboundEmailId: input.inboundEmailId,
          sourceEvidenceId: input.evidenceId,
          status: input.status,
          summary: input.summary,
          confidence: 0.8,
          participants: [],
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
          ownerEntityId: input.ownerEntityId ?? null,
        })
        .returning({ id: loops.id });
      return l.id;
    };

    openOwnerId = await mkLoop({
      threadId: thread1Id,
      inboundEmailId: inbound1Id,
      evidenceId: ev1,
      status: "open",
      summary: "Send Dana the revised proposal",
      updatedAt: OPEN_OWNER_UPDATED,
      ownerEntityId: entityId,
    });
    openJoinId = await mkLoop({
      threadId: thread2Id,
      inboundEmailId: inbound2Id,
      evidenceId: ev2,
      status: "waiting_on_other",
      summary: "Awaiting Dana's signed contract",
      updatedAt: OPEN_JOIN_UPDATED,
    });
    closedId = await mkLoop({
      threadId: thread1Id,
      inboundEmailId: inbound1Id,
      evidenceId: ev3,
      status: "done",
      summary: "Kickoff call with Dana completed",
      updatedAt: CLOSED_UPDATED,
    });
    suppressedId = await mkLoop({
      threadId: thread1Id,
      inboundEmailId: inbound1Id,
      evidenceId: ev4,
      status: "suppressed",
      summary: "Duplicate of the proposal loop (suppressed)",
      updatedAt: OPEN_OWNER_UPDATED,
      ownerEntityId: entityId,
    });

    // loop_entities join rows: openJoin (participant) + closed (owner).
    await db.insert(loopEntities).values([
      { loopId: openJoinId, entityId, role: "participant" },
      { loopId: closedId, entityId, role: "owner" },
    ]);

    // loop events (timeline) on two of the visible loops.
    await db.insert(loopEvents).values([
      { userId, loopId: openOwnerId, eventType: "confirmed", createdAt: EVENT_1_AT },
      { userId, loopId: closedId, eventType: "marked_done", createdAt: EVENT_2_AT },
    ]);
  });

  afterAll(async () => {
    await db.delete(loopEvents).where(eq(loopEvents.userId, userId));
    await db.delete(loopEntities).where(eq(loopEntities.entityId, entityId));
    await db.delete(loops).where(eq(loops.userId, userId));
    await db.delete(sourceEvidence).where(eq(sourceEvidence.userId, userId));
    await db.delete(inboundEmails).where(eq(inboundEmails.userId, userId));
    await db.delete(emailThreads).where(eq(emailThreads.userId, userId));
    await db.delete(entities).where(eq(entities.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  it("returns the entity row with display fields + ISO timestamps", async () => {
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId, db: db as any });
    expect(slice).not.toBeNull();
    expect(slice!.entity.id).toBe(entityId);
    expect(slice!.entity.displayName).toBe("Dana Client");
    expect(slice!.entity.kind).toBe("person");
    expect(slice!.entity.canonicalEmail).toBe(`dana-${RUN_ID}@example.com`);
    expect(slice!.entity.firstSeenAtIso).toBe(ENTITY_FIRST_SEEN.toISOString());
    expect(slice!.entity.lastSeenAtIso).toBe(ENTITY_LAST_SEEN.toISOString());
  });

  it("groups open vs closed correctly and EXCLUDES suppressed loops", async () => {
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId, db: db as any });

    const openIds = slice!.openLoops.map((l) => l.id);
    const closedIds = slice!.closedLoops.map((l) => l.id);

    // open: openOwner (loops.ownerEntityId) + openJoin (loop_entities participant)
    expect(openIds).toContain(openOwnerId);
    expect(openIds).toContain(openJoinId);
    expect(slice!.openCount).toBe(2);

    // closed: the done loop linked via loop_entities owner role
    expect(closedIds).toContain(closedId);
    expect(slice!.closedCount).toBe(1);

    // suppressed loop is excluded entirely from both buckets
    expect(openIds).not.toContain(suppressedId);
    expect(closedIds).not.toContain(suppressedId);

    // open loops ordered by recency (most-recent updatedAt first)
    expect(openIds[0]).toBe(openOwnerId);
  });

  it("attaches the entity's roles per loop (owner + participant)", async () => {
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId, db: db as any });
    const owner = slice!.openLoops.find((l) => l.id === openOwnerId);
    const join = slice!.openLoops.find((l) => l.id === openJoinId);
    const closed = slice!.closedLoops.find((l) => l.id === closedId);
    expect(owner!.roles).toEqual(["owner"]); // from loops.ownerEntityId
    expect(join!.roles).toEqual(["participant"]); // from loop_entities
    expect(closed!.roles).toEqual(["owner"]); // from loop_entities
  });

  it("counts distinct linked threads and the most-recent thread", async () => {
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId, db: db as any });
    // thread1 (openOwner + closed) and thread2 (openJoin) = 2 distinct visible threads
    expect(slice!.threadCount).toBe(2);
    // most-recent thread is thread1 (openOwner updated 2026-06-12, the newest)
    expect(slice!.mostRecentThreadId).toBe(thread1Id);
  });

  it("returns the recent loop_events timeline newest-first, only for visible loops", async () => {
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId, db: db as any });
    expect(slice!.recentEvents.length).toBe(2);
    // newest first: EVENT_1_AT (Jun 12) before EVENT_2_AT (Jun 10)
    expect(slice!.recentEvents[0].loopId).toBe(openOwnerId);
    expect(slice!.recentEvents[0].eventType).toBe("confirmed");
    expect(slice!.recentEvents[1].loopId).toBe(closedId);
    expect(slice!.recentEvents[0].createdAtIso).toBe(EVENT_1_AT.toISOString());
  });

  it("is serialization-safe (round-trips through JSON unchanged)", async () => {
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId, db: db as any });
    const roundTripped = JSON.parse(JSON.stringify(slice));
    expect(roundTripped).toEqual(slice);
  });

  it("returns null for an unknown entity id", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    // biome-ignore lint: test db handle
    const slice = await assembleEntityReport({ userId, entityId: missing, db: db as any });
    expect(slice).toBeNull();
  });
});
