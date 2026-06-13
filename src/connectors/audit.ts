/**
 * Shared connector-lifecycle audit + event-emit ports.
 *
 * Both the Composio webhook route and the status sweep write the same
 * connector.account_* audit rows and emit the same connector.* events, so the
 * ports live here (importable from `src/` and `app/` alike) instead of inside a
 * route file.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { auditLog } from "@/db/schema";
import type { EventMap } from "@/workflows/events";

/** Event emitter port — defaults to the real typed sendEvent; tests inject a fake. */
export type EmitEvent = <K extends keyof EventMap>(
  name: K,
  data: EventMap[K],
) => Promise<void>;

/** The connector.account_* lifecycle audit actions owned by the webhook + sweep. */
export interface ConnectorAuditWriter {
  writeAudit(input: {
    action:
      | "connector.account_connected"
      | "connector.account_revoked"
      | "connector.account_auth_error";
    userId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a canonical UUID (a valid users.id / audit_log.user_id FK). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export class DrizzleConnectorAuditWriter implements ConnectorAuditWriter {
  private readonly db = getDb();
  async writeAudit(input: {
    action:
      | "connector.account_connected"
      | "connector.account_revoked"
      | "connector.account_auth_error";
    userId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    // audit_log.user_id is a uuid FK (ON DELETE SET NULL). If the webhook arrived
    // with only a composio entity id (no local row), userId may not be a uuid —
    // null it rather than risk a parse/FK error.
    let userId = input.userId;
    if (userId && !isUuid(userId)) userId = null;

    await this.db.insert(auditLog).values({
      id: randomUUID(),
      userId,
      action: input.action,
      actorType: "system",
      metadata: input.metadata,
    });
  }
}
