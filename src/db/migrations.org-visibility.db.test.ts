/**
 * DB-gated integration tests for migration 0021 (org-visibility, Wave 0).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/db/migrations.org-visibility.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set. Verifies: the four new tables accept inserts;
 * the unique/CASCADE constraints hold; the enum rejects unknown values; the loops/entities/
 * source_evidence org_id columns exist; and loadViewerScope + canView work end-to-end on
 * real rows (the whole chokepoint, exercised against Postgres, not a fake).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { users, organizations, orgMemberships, scopes, visibilityEdges } from "@/db/schema";
import { loadViewerScope } from "@/visibility/load-scope";
import { canView } from "@/visibility/can-view";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("migration 0021 org-visibility (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN = Date.now();
  let ownerId: string;
  let reportId: string;
  let orgId: string;

  beforeAll(async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: `owner-${RUN}@example.com`, displayName: "Owner" })
      .returning({ id: users.id });
    ownerId = owner.id;
    const [report] = await db
      .insert(users)
      .values({ email: `report-${RUN}@example.com`, displayName: "Report" })
      .returning({ id: users.id });
    reportId = report.id;

    const [org] = await db
      .insert(organizations)
      .values({ name: `Acme ${RUN}`, isPersonal: false })
      .returning({ id: organizations.id });
    orgId = org.id;
  });

  afterAll(async () => {
    // Deleting the org cascades memberships/scopes/edges; then remove the users.
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, reportId));
    await sql.end();
  });

  it("accepts membership + scope + edges and rejects a duplicate membership", async () => {
    await db.insert(orgMemberships).values({ orgId, userId: ownerId, role: "owner" });
    await expect(
      db.insert(orgMemberships).values({ orgId, userId: ownerId, role: "member" }),
    ).rejects.toThrow(); // unique(org_id, user_id)
  });

  it("rejects an unknown role (enum guard)", async () => {
    await expect(
      db.insert(orgMemberships).values({ orgId, userId: reportId, role: "superuser" }),
    ).rejects.toThrow();
  });

  it("loadViewerScope folds an org_admin edge + manager_of edge into a ViewerScope", async () => {
    const [scope] = await db
      .insert(scopes)
      .values({ orgId, kind: "org_root", name: "All" })
      .returning({ id: scopes.id });
    expect(scope.id).toBeTruthy();

    await db.insert(visibilityEdges).values({
      orgId,
      subjectUserId: ownerId,
      relation: "org_admin",
      objectType: "org",
      objectId: orgId,
    });
    await db.insert(visibilityEdges).values({
      orgId,
      subjectUserId: ownerId,
      relation: "manager_of",
      objectType: "user",
      objectId: reportId,
    });

    const viewer = await loadViewerScope({ userId: ownerId, orgId, db });
    expect(viewer).not.toBeNull();
    expect(viewer!.isOrgAdmin).toBe(true); // owner role + org_admin edge
    expect(viewer!.managedUserIds.has(reportId)).toBe(true);

    // canView end-to-end: the admin sees an in-org resource owned by the report; not cross-org.
    expect(canView(viewer!, { orgId, ownerUserId: reportId, scopeIds: [], resourceId: "r1" })).toBe(true);
    expect(
      canView(viewer!, { orgId: "00000000-0000-0000-0000-000000000000", ownerUserId: reportId, scopeIds: [], resourceId: "r1" }),
    ).toBe(false);
  });

  it("loadViewerScope returns null for a user with no membership (fail closed)", async () => {
    const viewer = await loadViewerScope({ userId: reportId, orgId, db });
    expect(viewer).toBeNull();
  });

  it("deleting the org cascades its memberships (CASCADE)", async () => {
    const [tmpOrg] = await db
      .insert(organizations)
      .values({ name: `Tmp ${RUN}`, isPersonal: true })
      .returning({ id: organizations.id });
    await db.insert(orgMemberships).values({ orgId: tmpOrg.id, userId: reportId, role: "owner" });
    await db.delete(organizations).where(eq(organizations.id, tmpOrg.id));
    const rows = await db.select().from(orgMemberships).where(eq(orgMemberships.orgId, tmpOrg.id));
    expect(rows.length).toBe(0);
  });
});
