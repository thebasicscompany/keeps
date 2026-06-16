/**
 * DB-gated test for ensurePersonalOrg (Wave 3 / deploy prerequisite).
 * Run: TEST_DATABASE_URL=... pnpm exec vitest run src/visibility/personal-org.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { users, organizations, orgMemberships, scopes, visibilityEdges } from "@/db/schema";
import { ensurePersonalOrg } from "@/visibility/personal-org";
import { loadViewerScope } from "@/visibility/load-scope";
import { canView } from "@/visibility/can-view";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("ensurePersonalOrg (DB integration)", () => {
  // biome-ignore lint: safe inside skipIf
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN = Date.now();
  let userId: string;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `epo-${RUN}@x.invalid`, displayName: "EPO" })
      .returning({ id: users.id });
    userId = u.id;
  });

  afterAll(async () => {
    const mems = await db.select({ orgId: orgMemberships.orgId }).from(orgMemberships).where(eq(orgMemberships.userId, userId));
    for (const m of mems) await db.delete(organizations).where(eq(organizations.id, m.orgId));
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  it("creates org + owner membership + org_root scope + org_admin edge, and is idempotent", async () => {
    const r1 = await ensurePersonalOrg({ userId, db });
    expect(r1.created).toBe(true);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, r1.orgId));
    expect(org.isPersonal).toBe(true);
    const [mem] = await db.select().from(orgMemberships).where(eq(orgMemberships.orgId, r1.orgId));
    expect(mem.role).toBe("owner");
    const sc = await db.select().from(scopes).where(eq(scopes.orgId, r1.orgId));
    expect(sc.some((s: { kind: string }) => s.kind === "org_root")).toBe(true);
    const edges = await db.select().from(visibilityEdges).where(eq(visibilityEdges.orgId, r1.orgId));
    expect(edges.some((e: { relation: string }) => e.relation === "org_admin")).toBe(true);

    // idempotent
    const r2 = await ensurePersonalOrg({ userId, db });
    expect(r2.created).toBe(false);
    expect(r2.orgId).toBe(r1.orgId);

    // end-to-end: the new user is org-admin of their personal org → canView true for their own data
    const viewer = await loadViewerScope({ userId, orgId: r1.orgId, db });
    expect(viewer).not.toBeNull();
    expect(viewer!.isOrgAdmin).toBe(true);
    expect(canView(viewer!, { orgId: r1.orgId, ownerUserId: userId, scopeIds: [], resourceId: "x" })).toBe(true);
  });
});
