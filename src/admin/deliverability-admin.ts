/**
 * src/admin/deliverability-admin.ts
 *
 * Helpers for the /admin/deliverability page.
 *
 *   listSuppressedUsers({ db? })   — returns users whose outboundEmailState != 'active'
 *   reactivateUser({ userId, adminUserId }, db?) — resets state to 'active' and writes
 *                                                  an audit_log row for 'email.outbound.reactivated'
 *
 * All DB-injectable for testing.
 */

import { eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, auditLog } from "@/db/schema";

type DbArg = ReturnType<typeof getDb>;

export type SuppressedUser = {
  id: string;
  email: string;
  outboundEmailState: string;
  updatedAt: Date;
};

export async function listSuppressedUsers({
  db,
}: {
  db?: DbArg;
} = {}): Promise<SuppressedUser[]> {
  const database = db ?? getDb();

  const rows = await database
    .select({
      id: users.id,
      email: users.email,
      outboundEmailState: users.outboundEmailState,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(ne(users.outboundEmailState, "active"))
    .orderBy(users.updatedAt);

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    outboundEmailState: r.outboundEmailState,
    updatedAt: r.updatedAt,
  }));
}

export type ReactivateResult =
  | { ok: true; priorState: string }
  | { ok: false; error: "not_found" | "already_active" };

export async function reactivateUser(
  { userId, adminUserId }: { userId: string; adminUserId: string },
  db?: DbArg,
): Promise<ReactivateResult> {
  const database = db ?? getDb();

  // Fetch current state first so we can include it in the audit metadata.
  const [existing] = await database
    .select({ outboundEmailState: users.outboundEmailState })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!existing) {
    return { ok: false, error: "not_found" };
  }

  const priorState = existing.outboundEmailState;

  if (priorState === "active") {
    return { ok: false, error: "already_active" };
  }

  // Reset to active.
  await database
    .update(users)
    .set({ outboundEmailState: "active", updatedAt: new Date() })
    .where(eq(users.id, userId));

  // Write audit row.
  await database.insert(auditLog).values({
    userId,
    action: "email.outbound.reactivated",
    actorType: "admin",
    metadata: {
      priorState,
      adminUserId,
    },
  });

  return { ok: true, priorState };
}
