/**
 * require-admin.ts
 *
 * Reusable server-side admin gate. Resolves the Clerk session → the local
 * users row (via user_identities provider='clerk') → users.isAdmin.
 *
 * Returns { userId } when the caller is an authenticated admin. For an
 * unauthenticated request it redirects to /sign-in. For an authenticated but
 * non-admin (or unresolved) user it returns a { forbidden: true } sentinel the
 * page can render as a 403 — we deliberately do NOT redirect non-admins so a
 * signed-in user isn't bounced to sign-in.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userIdentities } from "@/db/schema";

export type RequireAdminResult = { userId: string } | { forbidden: true };

export async function requireAdmin(): Promise<RequireAdminResult> {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in" as Route);
  }

  // getDb() throws if DATABASE_URL is unset; without a DB we cannot verify
  // admin status, so fail closed (403) rather than crash the route.
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return { forbidden: true };
  }

  const [row] = await db
    .select({ userId: users.id, isAdmin: users.isAdmin })
    .from(users)
    .innerJoin(
      userIdentities,
      and(
        eq(userIdentities.userId, users.id),
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  if (!row || !row.isAdmin) {
    return { forbidden: true };
  }

  return { userId: row.userId };
}
