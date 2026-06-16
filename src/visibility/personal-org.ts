/**
 * ensurePersonalOrg (Wave 3 / deploy prerequisite) — idempotently give a user a personal org so
 * they're org-visibility-ready: organization (is_personal) + owner membership + org_root scope +
 * an org_admin visibility edge (so canView returns true for all their own data — the degenerate
 * solo case). Called on signup (Clerk webhook) and reused by the backfill. Safe to call repeatedly:
 * a user who already has ANY membership is skipped.
 *
 * Without this, a new signup after org-visibility is enabled would have no org_id on their data and
 * no scope → reads would return nothing. This closes that gap.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { organizations, orgMemberships, scopes, users, visibilityEdges } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export async function ensurePersonalOrg(input: {
  userId: string;
  db?: AnyDb;
}): Promise<{ orgId: string; created: boolean }> {
  const db: AnyDb = input.db ?? getDb();

  const [existing] = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, input.userId))
    .limit(1);
  if (existing) return { orgId: existing.orgId, created: false };

  const [u] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const name = u?.displayName ?? u?.email ?? "Personal";

  return db.transaction(async (tx: AnyDb) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name, isPersonal: true })
      .returning({ id: organizations.id });
    await tx.insert(orgMemberships).values({ orgId: org.id, userId: input.userId, role: "owner" });
    await tx.insert(scopes).values({ orgId: org.id, kind: "org_root", name: "All" });
    await tx.insert(visibilityEdges).values({
      orgId: org.id,
      subjectUserId: input.userId,
      relation: "org_admin",
      objectType: "org",
      objectId: org.id,
    });
    return { orgId: org.id, created: true };
  });
}
