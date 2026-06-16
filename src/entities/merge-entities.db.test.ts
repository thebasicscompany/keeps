/**
 * DB-gated test for the SOFT entity merge (Wave 0.3). Constructs a real cross-user duplicate
 * (two users in one org, same canonical_email) and verifies mergeEntitiesInOrg points the later
 * row at the earlier canonical via merged_into_entity_id (never deletes) and re-points loop FKs.
 *
 * Run: TEST_DATABASE_URL=... pnpm exec vitest run src/entities/merge-entities.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { users, organizations, orgMemberships, entities } from "@/db/schema";
import { mergeEntitiesInOrg } from "../../scripts/backfill-merge-entities";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("mergeEntitiesInOrg (soft-merge, DB integration)", () => {
  // biome-ignore lint: safe inside skipIf
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN = Date.now();
  let orgId: string;
  let userA: string;
  let userB: string;
  let earlyEntity: string;
  let lateEntity: string;

  beforeAll(async () => {
    const [a] = await db.insert(users).values({ email: `a-${RUN}@x.com`, displayName: "A" }).returning({ id: users.id });
    userA = a.id;
    const [b] = await db.insert(users).values({ email: `b-${RUN}@x.com`, displayName: "B" }).returning({ id: users.id });
    userB = b.id;
    const [org] = await db.insert(organizations).values({ name: `Org ${RUN}` }).returning({ id: organizations.id });
    orgId = org.id;
    await db.insert(orgMemberships).values({ orgId, userId: userA, role: "owner" });
    await db.insert(orgMemberships).values({ orgId, userId: userB, role: "member" });

    // Two person entities that NORMALIZE to the same email but differ by case in the raw column —
    // so both are "active" (the case-sensitive per-org unique index permits them) yet the planner
    // (which normalizes) groups them. This models legacy duplicate data WITHOUT touching the shared
    // index, keeping the test parallel-safe.
    const [e1] = await db
      .insert(entities)
      .values({
        userId: userA,
        orgId,
        kind: "person",
        displayName: "Jane (A)",
        canonicalEmail: `jane-${RUN}@acme.com`,
        firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({ id: entities.id });
    earlyEntity = e1.id;
    const [e2] = await db
      .insert(entities)
      .values({
        userId: userB,
        orgId,
        kind: "person",
        displayName: "Jane (B)",
        canonicalEmail: `JANE-${RUN}@acme.com`,
        firstSeenAt: new Date("2026-02-01T00:00:00Z"),
      })
      .returning({ id: entities.id });
    lateEntity = e2.id;
  });

  afterAll(async () => {
    await db.delete(entities).where(eq(entities.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userA));
    await db.delete(users).where(eq(users.id, userB));
    await sql.end();
  });

  it("points the later duplicate at the earliest-seen canonical (never deletes)", async () => {
    const merges = await mergeEntitiesInOrg({ db, orgId });
    expect(merges).toBe(1);

    const [early] = await db.select().from(entities).where(eq(entities.id, earlyEntity));
    const [late] = await db.select().from(entities).where(eq(entities.id, lateEntity));

    expect(early.mergedIntoEntityId).toBeNull(); // canonical stays active
    expect(late.mergedIntoEntityId).toBe(earlyEntity); // duplicate tombstoned, reversible
    expect(late.id).toBeTruthy(); // row NOT deleted (soft-merge)
    // canonical absorbed the duplicate's identifiers into aliases (recall preserved).
    expect(JSON.stringify(early.aliases)).toContain("Jane (B)");
  });

  it("is idempotent — a second run finds nothing new", async () => {
    expect(await mergeEntitiesInOrg({ db, orgId })).toBe(0);
  });
});
