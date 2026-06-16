/**
 * DB-gated test for org-canonical person resolution (Wave 1b). Two different members of the same
 * org resolving the SAME email must land on ONE entity row (the org-canonical one); without an
 * org (legacy), each user gets their own row.
 *
 * Run: TEST_DATABASE_URL=... pnpm exec vitest run src/entities/resolve.org.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { users, organizations, entities } from "@/db/schema";
import { resolveEntity } from "@/entities/resolve";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("resolveEntity org-canonical (DB integration)", () => {
  // biome-ignore lint: safe inside skipIf
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN = Date.now();
  const EMAIL = `jane-${RUN}@acme.com`;
  let orgId: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    const [a] = await db.insert(users).values({ email: `a-${RUN}@x.com`, displayName: "A" }).returning({ id: users.id });
    userA = a.id;
    const [b] = await db.insert(users).values({ email: `b-${RUN}@x.com`, displayName: "B" }).returning({ id: users.id });
    userB = b.id;
    const [org] = await db.insert(organizations).values({ name: `Org ${RUN}` }).returning({ id: organizations.id });
    orgId = org.id;
  });

  afterAll(async () => {
    await db.delete(entities).where(eq(entities.orgId, orgId));
    await db.delete(entities).where(inArray(entities.userId, [userA, userB]));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, [userA, userB]));
    await sql.end();
  });

  it("two members resolving the same email → ONE org-canonical entity (stamped org_id)", async () => {
    const e1 = await resolveEntity({ userId: userA, name: "Jane A", email: EMAIL, orgId }, db);
    const e2 = await resolveEntity({ userId: userB, name: "Jane B", email: EMAIL, orgId }, db);
    expect(e2.id).toBe(e1.id); // same canonical row
    expect(e1.orgId).toBe(orgId); // org_id stamped on create
    // B's display name was absorbed as an alias on the canonical row (recall preserved).
    const [row] = await db.select().from(entities).where(eq(entities.id, e1.id));
    expect(JSON.stringify(row.aliases)).toContain("Jane B");
  });

  it("without an org (legacy) two users get SEPARATE rows", async () => {
    const legacyEmail = `bob-${RUN}@acme.com`;
    const e1 = await resolveEntity({ userId: userA, name: "Bob", email: legacyEmail }, db);
    const e2 = await resolveEntity({ userId: userB, name: "Bob", email: legacyEmail }, db);
    expect(e2.id).not.toBe(e1.id); // per-user rows, unchanged legacy behavior
  });
});
