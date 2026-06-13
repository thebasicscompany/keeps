import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "@/db/client";
import { auditLog, nudges, users } from "@/db/schema";
import type * as schema from "@/db/schema";

/**
 * Classifies an incoming Postmark bounce/complaint/delivery webhook payload into a
 * normalised event kind.  The Postmark webhook docs call these `RecordType` values:
 *   - "Bounce"         → a hard or soft bounce
 *   - "SpamComplaint"  → the recipient marked the message as spam
 *   - "Delivery"       → successful delivery confirmation
 *
 * @see https://postmarkapp.com/developer/webhooks/bounce-webhook
 * @see https://postmarkapp.com/developer/webhooks/spam-complaint-webhook
 * @see https://postmarkapp.com/developer/webhooks/delivery-webhook
 */
export type DeliverabilityEventKind = "bounce" | "complaint" | "delivery" | "ignored";

export type ClassifiedEvent = {
  kind: DeliverabilityEventKind;
  /** The recipient email address extracted from the payload, or null when unavailable. */
  recipient: string | null;
  /** The outboundEmailState value to apply, or null when no update is needed. */
  newState: "bounced" | "complained" | null;
  /** Provider record id (Postmark's ID field) for the audit log, or null. */
  providerRecordId: number | null;
};

/**
 * Classifies a raw Postmark webhook payload.  Pure, no I/O.
 */
export function classifyPostmarkEvent(payload: unknown): ClassifiedEvent {
  if (!payload || typeof payload !== "object") {
    return { kind: "ignored", recipient: null, newState: null, providerRecordId: null };
  }

  const p = payload as Record<string, unknown>;
  const recordType = p.RecordType as string | undefined;

  // Postmark bounces expose the recipient in `Email` (bounce) or `Recipient` (complaint/delivery).
  const email =
    typeof p.Email === "string" ? p.Email :
    typeof p.Recipient === "string" ? p.Recipient :
    null;

  const recordId =
    typeof p.ID === "number" ? p.ID :
    typeof p.ID === "string" ? Number(p.ID) :
    null;

  switch (recordType) {
    case "Bounce":
      return {
        kind: "bounce",
        recipient: email,
        newState: "bounced",
        providerRecordId: recordId,
      };

    case "SpamComplaint":
      return {
        kind: "complaint",
        recipient: email,
        newState: "complained",
        providerRecordId: recordId,
      };

    case "Delivery":
      return {
        kind: "delivery",
        recipient: email,
        newState: null,
        providerRecordId: recordId,
      };

    default:
      return {
        kind: "ignored",
        recipient: email,
        newState: null,
        providerRecordId: recordId,
      };
  }
}

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Applies a classified deliverability event to the database:
 *   1. Finds the user by `recipient` email.
 *   2. Updates `users.outboundEmailState` to `newState`.
 *   3. Inserts an `audit_log` row with action `email.outbound.suppressed`.
 *
 * DB-injectable: pass a `db` instance (useful in tests); defaults to `getDb()`.
 *
 * Returns `{ updated: true, userId }` when a user was found and updated, or
 * `{ updated: false }` when no matching user was found.
 */
export async function applyDeliverabilityEvent(
  event: {
    kind: DeliverabilityEventKind;
    recipient: string | null;
    newState: "bounced" | "complained" | null;
    providerRecordId: number | null;
  },
  db?: Db,
): Promise<{ updated: true; userId: string } | { updated: false }> {
  if (!event.newState || !event.recipient) {
    return { updated: false };
  }

  const resolvedDb = db ?? (getDb() as Db);

  const [user] = await resolvedDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, event.recipient))
    .limit(1);

  if (!user) {
    return { updated: false };
  }

  await resolvedDb
    .update(users)
    .set({ outboundEmailState: event.newState })
    .where(eq(users.id, user.id));

  await resolvedDb.insert(auditLog).values({
    id: randomUUID(),
    userId: user.id,
    action: "email.outbound.suppressed",
    actorType: "system",
    metadata: {
      recipient: event.recipient,
      type: event.kind,
      postmarkRecordId: event.providerRecordId,
    },
  });

  // TODO: Sentry breadcrumb (Phase 6 A3)
  // TODO: daily bounce/complaint metric (Phase 6 Wave B/D)

  return { updated: true, userId: user.id };
}
