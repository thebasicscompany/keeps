/**
 * src/audit/list-for-user.ts
 *
 * Fetch the most-recent audit_log rows for a given user (most recent first,
 * capped at `limit`). DB-injectable so the caller can supply a test DB.
 *
 * Usage:
 *   const rows = await listAuditForUser({ userId });
 *   const rows = await listAuditForUser({ userId, limit: 50 }, testDb);
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditLog } from "@/db/schema";
import type { AuditLogEntry } from "@/db/schema";

export type { AuditLogEntry };

export interface ListAuditForUserInput {
  userId: string;
  limit?: number;
}

export async function listAuditForUser(
  input: ListAuditForUserInput,
  // DB is injectable for test isolation; defaults to the shared app DB.
  db?: ReturnType<typeof getDb>,
): Promise<AuditLogEntry[]> {
  const { userId, limit = 200 } = input;
  const database = db ?? getDb();

  return database
    .select()
    .from(auditLog)
    .where(eq(auditLog.userId, userId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}
