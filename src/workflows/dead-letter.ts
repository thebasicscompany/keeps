/**
 * dead-letter.ts — the dead-letter / failed-processing write path (deliverable 14).
 *
 * `recordDeadLetter` inserts one `failed_processing` row capturing a workflow run
 * that exhausted its retries: the original event name + payload (jsonb), plus the
 * error message/stack. It is the single chokepoint every `onFailure` handler calls.
 *
 * DB-injectable: accepts a `db` param (default getDb()) so DB-gated tests can target
 * the local Postgres without touching the production connection.
 *
 * Note: failed_processing.inboundEmailId is a plain nullable uuid with NO FK — a
 * failure may pre-date persistence — so a null inboundEmailId is a first-class case.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { failedProcessing } from "@/db/schema";

export type DeadLetterDb = PostgresJsDatabase<typeof schema>;

export interface RecordDeadLetterInput {
  /** Inbound email this failure relates to, if known. Null when it pre-dates persistence. */
  inboundEmailId?: string | null;
  /** The wire name of the event whose run failed (e.g. "email.received"). */
  eventName: string;
  /**
   * The original triggering event's `data` payload, stored verbatim in jsonb so a
   * replay can re-emit the exact same event. Must be JSON-serializable.
   */
  eventPayload: unknown;
  /** The final error that caused the run to exhaust its retries. */
  error: unknown;
}

/**
 * Coerce an arbitrary value into a JSON-serialization-safe object for the jsonb
 * column. Inngest hands the original event payload across the wire as plain JSON,
 * but onFailure handlers and CLIs may pass anything; we defend the insert.
 */
function toSerializablePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    try {
      return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    } catch {
      return { unserializable: String(payload) };
    }
  }
  // Non-object payloads are wrapped so the column always holds an object.
  return { value: payload ?? null };
}

/** Pull a message + stack from an unknown thrown value (Error or Inngest JsonError). */
function describeError(error: unknown): { message: string | null; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null };
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    const stack = (error as { stack?: unknown }).stack;
    return {
      message: typeof message === "string" ? message : JSON.stringify(error),
      stack: typeof stack === "string" ? stack : null,
    };
  }
  if (error == null) return { message: null, stack: null };
  return { message: String(error), stack: null };
}

export interface RecordedDeadLetter {
  id: string;
}

/**
 * Insert a failed_processing row. Returns the new row id so callers (replay tooling,
 * tests) can reference it. failedAt defaults to now() in the DB.
 */
export async function recordDeadLetter(
  input: RecordDeadLetterInput,
  db: DeadLetterDb = getDb(),
): Promise<RecordedDeadLetter> {
  const { message, stack } = describeError(input.error);

  const [row] = await db
    .insert(failedProcessing)
    .values({
      inboundEmailId: input.inboundEmailId ?? null,
      eventName: input.eventName,
      eventPayload: toSerializablePayload(input.eventPayload),
      errorMessage: message,
      errorStack: stack,
    })
    .returning({ id: failedProcessing.id });

  return { id: row.id };
}
