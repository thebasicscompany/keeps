/**
 * DB-gated integration tests for findEntityByQuery (Phase 7 C2).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/entities/lookup.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { entities, users } from "@/db/schema";
import { findEntityByQuery } from "@/entities/lookup";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("findEntityByQuery (DB integration)", () => {
  // biome-ignore lint: non-null assertion safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // biome-ignore lint/suspicious/noExplicitAny: structural Drizzle handle
  const db = drizzle(sql, { schema }) as any;

  const RUN_ID = Date.now();
  let userId: string;

  // Seeded entity ids
  let personId: string;    // person with email + alias: lookup-person-<RUN_ID>@example.com
  let personTagId: string; // person seeded for +tag test: lookuptag-<RUN_ID>@example.com
  let companyId: string;   // company with domain acmelookup<RUN_ID>.com
  let person2Id: string;   // ambiguity test (shared display name)
  let person3Id: string;   // ambiguity test (shared display name)

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-lookup-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    // Primary person: canonicalEmail + alias
    const [p] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person",
        displayName: `Lookup Person ${RUN_ID}`,
        canonicalEmail: `lookup-person-${RUN_ID}@example.com`,
        aliases: [`LP Alias ${RUN_ID}`],
        metadata: {},
      })
      .returning({ id: entities.id });
    personId = p.id;

    // Person seeded specifically for the +tag stripping test.
    // canonical: lookuptag-<RUN_ID>@example.com
    // query:     lookuptag-<RUN_ID>+newsletter@example.com → strips to lookuptag-<RUN_ID>@example.com
    const [pt] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person",
        displayName: `Tag Person ${RUN_ID}`,
        canonicalEmail: `lookuptag-${RUN_ID}@example.com`,
        aliases: [],
        metadata: {},
      })
      .returning({ id: entities.id });
    personTagId = pt.id;

    // Company: metadata.domain
    const domain = `acmelookup${RUN_ID}.com`;
    const [c] = await db
      .insert(entities)
      .values({
        userId,
        kind: "company",
        displayName: domain,
        canonicalEmail: null,
        aliases: [],
        metadata: { domain },
      })
      .returning({ id: entities.id });
    companyId = c.id;

    // Two people sharing the SAME display name (ambiguity test)
    const ambigName = `AmbigName ${RUN_ID}`;
    const [p2] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person",
        displayName: ambigName,
        canonicalEmail: `ambig-a-${RUN_ID}@example.com`,
        aliases: [],
        metadata: {},
      })
      .returning({ id: entities.id });
    person2Id = p2.id;

    const [p3] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person",
        displayName: ambigName,
        canonicalEmail: `ambig-b-${RUN_ID}@example.com`,
        aliases: [],
        metadata: {},
      })
      .returning({ id: entities.id });
    person3Id = p3.id;
  });

  afterAll(async () => {
    await db.delete(entities).where(eq(entities.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  it("resolves by exact canonical email", async () => {
    const result = await findEntityByQuery(
      { userId, query: `lookup-person-${RUN_ID}@example.com` },
      db,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(personId);
    expect(result!.displayName).toBe(`Lookup Person ${RUN_ID}`);
  });

  it("resolves by email with +tag stripped", async () => {
    // normalizeEmail strips the +tag: lookuptag-<RUN_ID>+newsletter@example.com
    // → lookuptag-<RUN_ID>@example.com which matches personTagId
    const result = await findEntityByQuery(
      { userId, query: `lookuptag-${RUN_ID}+newsletter@example.com` },
      db,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(personTagId);
  });

  it("resolves a company by exact domain", async () => {
    const domain = `acmelookup${RUN_ID}.com`;
    const result = await findEntityByQuery({ userId, query: domain }, db);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(companyId);
    expect(result!.kind).toBe("company");
  });

  it("resolves by exact display name (case-insensitive)", async () => {
    // Query in lower-case to test case-insensitivity
    const result = await findEntityByQuery(
      { userId, query: `lookup person ${RUN_ID}`.toLowerCase() },
      db,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(personId);
  });

  it("resolves by alias (case-insensitive)", async () => {
    const result = await findEntityByQuery(
      { userId, query: `lp alias ${RUN_ID}` },
      db,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(personId);
  });

  it("resolves a company by domain-contains (partial term without TLD)", async () => {
    // "acmelookup<RUN_ID>" is contained in "acmelookup<RUN_ID>.com"
    const result = await findEntityByQuery(
      { userId, query: `acmelookup${RUN_ID}` },
      db,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(companyId);
  });

  it("returns null when no entity matches", async () => {
    const result = await findEntityByQuery(
      { userId, query: "totally-unknown-xyz-no-match" },
      db,
    );
    expect(result).toBeNull();
  });

  it("returns null for an AMBIGUOUS display-name term (multiple distinct entities match)", async () => {
    const ambigName = `AmbigName ${RUN_ID}`;
    const result = await findEntityByQuery({ userId, query: ambigName }, db);
    // Two entities share this display name → ambiguous → null
    expect(result).toBeNull();
    // Confirm both seeded entities actually exist
    expect(person2Id).toBeTruthy();
    expect(person3Id).toBeTruthy();
  });

  it("returns null for an empty query", async () => {
    const result = await findEntityByQuery({ userId, query: "" }, db);
    expect(result).toBeNull();
  });

  it("does NOT return entities belonging to a different user", async () => {
    const result = await findEntityByQuery(
      { userId: "00000000-0000-0000-0000-000000000000", query: `lookup-person-${RUN_ID}@example.com` },
      db,
    );
    expect(result).toBeNull();
  });
});
