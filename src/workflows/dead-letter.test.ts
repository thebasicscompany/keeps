/**
 * DB-gated integration tests for recordDeadLetter (dead-letter write path) and the
 * replayFailedProcessing core (replay re-emit + replayedAt + audit row, and resolve).
 *
 * Requires a live Postgres at TEST_DATABASE_URL
 * (postgres://postgres:postgres@localhost:55433/keeps).
 * Skipped automatically when that env var is absent.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "@/db/schema";
import { failedProcessing, auditLog } from "@/db/schema";
import { recordDeadLetter } from "@/workflows/dead-letter";
import { replayFailedProcessing, type EventEmitter } from "@/workflows/replay-failed-processing";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("dead-letter queue (DB-gated)", () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
  const pgClient = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(pgClient, { schema });

  afterAll(async () => {
    await pgClient.end({ timeout: 5 });
  });

  it("writes a row with errorMessage + errorStack + serialized payload", async () => {
    const inboundEmailId = randomUUID();
    const error = new Error("boom: route-email blew up");

    const { id } = await recordDeadLetter(
      {
        inboundEmailId,
        eventName: "email.received",
        eventPayload: { inboundEmailId, emailThreadId: "t1", subject: "Hi" },
        error,
      },
      db,
    );

    const [row] = await db
      .select()
      .from(failedProcessing)
      .where(eq(failedProcessing.id, id))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.inboundEmailId).toBe(inboundEmailId);
    expect(row.eventName).toBe("email.received");
    expect(row.eventPayload).toMatchObject({ inboundEmailId, subject: "Hi" });
    expect(row.errorMessage).toBe("boom: route-email blew up");
    expect(row.errorStack).toContain("boom: route-email blew up");
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.replayedAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it("tolerates a null inboundEmailId (failure pre-dates persistence)", async () => {
    const { id } = await recordDeadLetter(
      {
        inboundEmailId: null,
        eventName: "email.received",
        eventPayload: { subject: "no inbound id yet" },
        error: new Error("pre-persistence failure"),
      },
      db,
    );

    const [row] = await db
      .select()
      .from(failedProcessing)
      .where(eq(failedProcessing.id, id))
      .limit(1);

    expect(row.inboundEmailId).toBeNull();
    expect(row.errorMessage).toBe("pre-persistence failure");
  });

  it("replay re-emits the original event with the SAME inboundEmailId and stamps replayedAt + audit", async () => {
    const inboundEmailId = randomUUID();
    const originalPayload = { inboundEmailId, emailThreadId: "thread-9", subject: "Replay me" };

    const { id } = await recordDeadLetter(
      {
        inboundEmailId,
        eventName: "email.received",
        eventPayload: originalPayload,
        error: new Error("transient"),
      },
      db,
    );

    // Fake emitter captures the re-emitted event so we can assert idempotency-key fidelity.
    const emitted: { name: string; data: unknown }[] = [];
    const emit: EventEmitter = async (event) => {
      emitted.push(event);
      return undefined;
    };

    const result = await replayFailedProcessing(
      { id, action: "replay", actorUserId: null },
      { db, emit },
    );

    expect(result).toMatchObject({ ok: true, action: "replay", id, inboundEmailId });

    // The re-emitted event is byte-for-byte the stored one — same idempotency key.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe("email.received");
    expect((emitted[0].data as Record<string, unknown>).inboundEmailId).toBe(inboundEmailId);
    expect(emitted[0].data).toMatchObject(originalPayload);

    // replayedAt stamped.
    const [row] = await db
      .select()
      .from(failedProcessing)
      .where(eq(failedProcessing.id, id))
      .limit(1);
    expect(row.replayedAt).toBeInstanceOf(Date);
    expect(row.resolvedAt).toBeNull();

    // audit row written.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "failed_processing.replayed"));
    const match = auditRows.find(
      (r) => (r.metadata as { failedProcessingId?: string }).failedProcessingId === id,
    );
    expect(match).toBeDefined();
    expect((match!.metadata as { inboundEmailId?: string }).inboundEmailId).toBe(inboundEmailId);
  });

  it("resolve stamps resolvedAt and does NOT emit", async () => {
    const { id } = await recordDeadLetter(
      {
        inboundEmailId: randomUUID(),
        eventName: "email.received",
        eventPayload: { subject: "resolve me" },
        error: new Error("won't replay"),
      },
      db,
    );

    const emitted: unknown[] = [];
    const emit: EventEmitter = async (event) => {
      emitted.push(event);
      return undefined;
    };

    const result = await replayFailedProcessing(
      { id, action: "resolve", notes: "handled manually" },
      { db, emit },
    );

    expect(result).toMatchObject({ ok: true, action: "resolve", id });
    expect(emitted).toHaveLength(0);

    const [row] = await db
      .select()
      .from(failedProcessing)
      .where(eq(failedProcessing.id, id))
      .limit(1);
    expect(row.resolvedAt).toBeInstanceOf(Date);
    expect(row.notes).toBe("handled manually");
  });

  it("returns not_found for an unknown id", async () => {
    const result = await replayFailedProcessing(
      { id: randomUUID(), action: "replay" },
      { db, emit: async () => undefined },
    );
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("returns already_resolved when resolving a resolved row", async () => {
    const { id } = await recordDeadLetter(
      {
        eventName: "email.received",
        eventPayload: {},
        error: new Error("e"),
      },
      db,
    );
    await replayFailedProcessing({ id, action: "resolve" }, { db, emit: async () => undefined });
    const second = await replayFailedProcessing(
      { id, action: "resolve" },
      { db, emit: async () => undefined },
    );
    expect(second).toEqual({ ok: false, error: "already_resolved" });
  });
});
