/**
 * replay-failed-processing.ts — the shared replay/resolve core for the dead-letter
 * queue (deliverable 13/14). Backs BOTH the admin API route and the headless CLI so
 * the behavior is identical regardless of entry point.
 *
 * Replay re-emits the EXACT stored event (eventName + eventPayload). Idempotency is
 * preserved by the original function's idempotency key — process-email keys on
 * `event.data.inboundEmailId`, so a replay of a row whose underlying inbound email
 * was already processed is deduped by Inngest and cannot double-create loops.
 *
 * The event emitter is injectable (`emit`) so tests can assert the re-emitted name +
 * payload without a live Inngest connection, and the CLI/route can pass the real send.
 *
 * DB-injectable: accepts a `db` param (default getDb()).
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { failedProcessing, auditLog } from "@/db/schema";
import { inngest } from "@/workflows/client";

export type ReplayDb = PostgresJsDatabase<typeof schema>;

/** Minimal event emitter shape — satisfied by inngest.send and by test fakes. */
export type EventEmitter = (event: { name: string; data: unknown }) => Promise<unknown>;

/** Default emitter: send the stored event through the real Inngest client. */
export const inngestEmitter: EventEmitter = (event) =>
  inngest.send(event as { name: string; data: Record<string, unknown> });

export type ReplayAction = "replay" | "resolve";

export interface ReplayFailedProcessingInput {
  id: string;
  action: ReplayAction;
  /** Optional admin user id recorded on the audit row for a replay. */
  actorUserId?: string | null;
  /** Optional notes recorded when resolving (or replaying). */
  notes?: string | null;
}

export interface ReplayDeps {
  db?: ReplayDb;
  emit?: EventEmitter;
}

export type ReplayFailedProcessingResult =
  | { ok: true; action: "replay"; id: string; eventName: string; inboundEmailId: string | null }
  | { ok: true; action: "resolve"; id: string }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "already_resolved" };

/**
 * Replay or resolve a single failed_processing row.
 *
 *  - replay:  re-emit the stored event (name + payload), stamp replayedAt = now, and
 *             write a `failed_processing.replayed` audit row. Idempotency on the
 *             original function (event.data.inboundEmailId) prevents a double-create.
 *  - resolve: stamp resolvedAt = now (+ optional notes). No event is emitted.
 */
export async function replayFailedProcessing(
  input: ReplayFailedProcessingInput,
  deps: ReplayDeps = {},
): Promise<ReplayFailedProcessingResult> {
  const db = deps.db ?? getDb();
  const emit = deps.emit ?? inngestEmitter;

  const [row] = await db
    .select()
    .from(failedProcessing)
    .where(eq(failedProcessing.id, input.id))
    .limit(1);

  if (!row) {
    return { ok: false, error: "not_found" };
  }

  const now = new Date();

  if (input.action === "resolve") {
    if (row.resolvedAt) {
      return { ok: false, error: "already_resolved" };
    }
    await db
      .update(failedProcessing)
      .set({ resolvedAt: now, ...(input.notes != null ? { notes: input.notes } : {}) })
      .where(eq(failedProcessing.id, row.id));
    return { ok: true, action: "resolve", id: row.id };
  }

  // --- replay ---------------------------------------------------------------
  // Re-emit the original event verbatim. The payload is the stored jsonb, so the
  // inboundEmailId (and therefore the idempotency key) is identical to the run
  // that originally failed.
  const payload = (row.eventPayload ?? {}) as Record<string, unknown>;
  await emit({ name: row.eventName, data: payload });

  await db
    .update(failedProcessing)
    .set({ replayedAt: now, ...(input.notes != null ? { notes: input.notes } : {}) })
    .where(eq(failedProcessing.id, row.id));

  await db.insert(auditLog).values({
    userId: input.actorUserId ?? null,
    action: "failed_processing.replayed",
    actorType: input.actorUserId ? "user" : "system",
    metadata: {
      failedProcessingId: row.id,
      eventName: row.eventName,
      inboundEmailId: row.inboundEmailId,
    },
  });

  return {
    ok: true,
    action: "replay",
    id: row.id,
    eventName: row.eventName,
    inboundEmailId: row.inboundEmailId,
  };
}
