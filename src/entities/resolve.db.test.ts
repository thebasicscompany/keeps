/**
 * DB-gated integration tests for the conservative entity resolver (Phase 7 A1).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/entities/resolve.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, isNull, and } from "drizzle-orm";
import * as schema from "@/db/schema";
import { entities, users } from "@/db/schema";
import { resolveCompany, resolveCompanyFromEmail, resolveEntity } from "@/entities/resolve";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("entity resolver (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN_ID = Date.now(); // unique per test run
  let userId: string;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `test-entities-resolve-${RUN_ID}@test.invalid`,
        timezone: "UTC",
      })
      .returning({ id: users.id });
    userId = u.id;
  });

  afterAll(async () => {
    // Clean up all entities created during this test run for our test user,
    // then the user row itself (cascades will handle anything else).
    await db.delete(entities).where(eq(entities.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  // -------------------------------------------------------------------------
  // find-or-create by exact email
  // -------------------------------------------------------------------------

  describe("find-or-create by exact email", () => {
    it("creates a new entity on first call", async () => {
      const entity = await resolveEntity(
        { userId, name: "Alice Smith", email: "alice@acme.com" },
        db,
      );
      expect(entity.id).toBeTruthy();
      expect(entity.canonicalEmail).toBe("alice@acme.com");
      expect(entity.displayName).toBe("Alice Smith");
      expect(entity.kind).toBe("person");
    });

    it("returns the SAME entity on a second call with the same email", async () => {
      const first = await resolveEntity(
        { userId, name: "Alice Smith", email: "alice@acme.com" },
        db,
      );
      const second = await resolveEntity(
        { userId, name: "Alice Smith", email: "alice@acme.com" },
        db,
      );
      expect(first.id).toBe(second.id);
    });

    it("appends a new alias when a different name is given on a subsequent call", async () => {
      // Use separate email so this test is isolated
      const first = await resolveEntity(
        { userId, name: "Bob Jones", email: "bob@acme.com" },
        db,
      );
      const second = await resolveEntity(
        { userId, name: "Robert Jones", email: "bob@acme.com" },
        db,
      );
      expect(second.id).toBe(first.id);
      const aliases = second.aliases as string[];
      expect(aliases).toContain("Robert Jones");
    });

    it("does NOT append duplicate alias when same name is given again", async () => {
      const first = await resolveEntity(
        { userId, name: "Carol White", email: "carol@acme.com" },
        db,
      );
      const second = await resolveEntity(
        { userId, name: "Carol White", email: "carol@acme.com" },
        db,
      );
      const aliases = second.aliases as string[];
      // "Carol White" is already the displayName, should not appear as extra alias
      const carolCount = aliases.filter((a) => a.toLowerCase() === "carol white").length;
      expect(carolCount).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // +tag stripping — headline guarantee
  // -------------------------------------------------------------------------

  describe("+tag stripping", () => {
    it("jane+x@acme.com and jane@acme.com resolve to the SAME entity", async () => {
      const withTag = await resolveEntity(
        { userId, name: "Jane Doe", email: "jane+x@acme.com" },
        db,
      );
      const withoutTag = await resolveEntity(
        { userId, name: "Jane Doe", email: "jane@acme.com" },
        db,
      );
      expect(withTag.id).toBe(withoutTag.id);
      // Both should map to canonicalEmail without the tag
      expect(withTag.canonicalEmail).toBe("jane@acme.com");
      expect(withoutTag.canonicalEmail).toBe("jane@acme.com");
    });
  });

  // -------------------------------------------------------------------------
  // NO FALSE MERGE — the headline guarantee
  // -------------------------------------------------------------------------

  describe("NO FALSE MERGE", () => {
    it("two distinct emails with the same name produce TWO distinct entities", async () => {
      const entity1 = await resolveEntity(
        { userId, name: "J. Doe", email: "jane@corp-a.com" },
        db,
      );
      const entity2 = await resolveEntity(
        { userId, name: "J. Doe", email: "john@corp-b.com" },
        db,
      );
      // MUST be different entities — name is an alias, not a join key
      expect(entity1.id).not.toBe(entity2.id);
    });
  });

  // -------------------------------------------------------------------------
  // mergedIntoEntityId pointer following
  // -------------------------------------------------------------------------

  describe("merge chain following", () => {
    it("follows mergedIntoEntityId to return the canonical entity", async () => {
      // Create entity A and B
      const entityA = await resolveEntity(
        { userId, name: "Entity A", email: `merge-a-${RUN_ID}@chain-test.com` },
        db,
      );
      const entityB = await resolveEntity(
        { userId, name: "Entity B", email: `merge-b-${RUN_ID}@chain-test.com` },
        db,
      );

      // Manually set B.mergedIntoEntityId = A (simulating an admin merge)
      await db
        .update(entities)
        .set({ mergedIntoEntityId: entityA.id, updatedAt: new Date() })
        .where(eq(entities.id, entityB.id));

      // Resolving by B's email should return A
      const resolved = await resolveEntity(
        { userId, name: "Entity B", email: `merge-b-${RUN_ID}@chain-test.com` },
        db,
      );

      expect(resolved.id).toBe(entityA.id);
    });
  });

  // -------------------------------------------------------------------------
  // Name-only ambiguity — conservative fallback
  // -------------------------------------------------------------------------

  describe("name-only resolution", () => {
    it("resolves to a single existing name-only entity when exactly one matches", async () => {
      const unique_name = `UniquePersonNameOnly-${RUN_ID}`;
      const created = await resolveEntity(
        { userId, name: unique_name, email: null },
        db,
      );
      const resolved = await resolveEntity(
        { userId, name: unique_name, email: null },
        db,
      );
      expect(resolved.id).toBe(created.id);
    });

    it("creates a THIRD entity when 'Sam' is ambiguous (two existing Sams)", async () => {
      const samName = `Sam-${RUN_ID}`;

      // Create two name-only "Sam" entities (directly to bypass the resolver's own logic)
      await db.insert(entities).values([
        {
          userId,
          kind: "person" as const,
          displayName: samName,
          canonicalEmail: null,
          aliases: [samName],
          metadata: {},
        },
        {
          userId,
          kind: "person" as const,
          displayName: samName,
          canonicalEmail: null,
          aliases: [samName],
          metadata: {},
        },
      ]);

      // Now attempt to resolve "Sam" — there are now 2 matching rows → ambiguous
      const resolved = await resolveEntity({ userId, name: samName, email: null }, db);

      // Should have created a THIRD entity, not returned one of the existing two
      const allSams = await db
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.userId, userId),
            eq(entities.kind, "person"),
            isNull(entities.canonicalEmail),
            eq(entities.displayName, samName),
          ),
        );

      expect(allSams.length).toBeGreaterThanOrEqual(3);
      // The returned entity should be the newly created one (different from the pre-existing two)
      const preExistingIds = allSams
        .map((e: schema.Entity) => e.id)
        .filter((id: string) => id !== resolved.id);
      expect(preExistingIds.length).toBeGreaterThanOrEqual(2);
    });

    it("does NOT attach a name-only resolve to an entity that has an email", async () => {
      // Entities with email must never be matched by name-only resolution
      const emailEntity = await resolveEntity(
        { userId, name: "Named Person", email: `named-${RUN_ID}@company.com` },
        db,
      );

      // Resolve by name only — should NOT return the email entity
      const nameOnly = await resolveEntity(
        { userId, name: "Named Person", email: null },
        db,
      );

      expect(nameOnly.id).not.toBe(emailEntity.id);
      expect(nameOnly.canonicalEmail).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveCompany
  // -------------------------------------------------------------------------

  describe("resolveCompany", () => {
    it("creates a company entity for a corporate domain", async () => {
      const company = await resolveCompany({ userId, domain: "acme-corp.com" }, db);
      expect(company.kind).toBe("company");
      expect(company.displayName).toBe("acme-corp.com");
      expect((company.metadata as Record<string, unknown>).domain).toBe("acme-corp.com");
      expect(company.canonicalEmail).toBeNull();
    });

    it("returns the SAME company entity on second call (find-or-create)", async () => {
      const first = await resolveCompany({ userId, domain: "deduped-corp.com" }, db);
      const second = await resolveCompany({ userId, domain: "deduped-corp.com" }, db);
      expect(first.id).toBe(second.id);
    });

    it("lowercases the domain", async () => {
      const company = await resolveCompany({ userId, domain: "UPPER-CORP.COM" }, db);
      expect(company.displayName).toBe("upper-corp.com");
    });
  });

  // -------------------------------------------------------------------------
  // resolveCompanyFromEmail
  // -------------------------------------------------------------------------

  describe("resolveCompanyFromEmail", () => {
    it("returns null for a freemail domain (gmail.com)", async () => {
      const result = await resolveCompanyFromEmail(
        { userId, email: "someone@gmail.com" },
        db,
      );
      expect(result).toBeNull();
    });

    it("returns null for yahoo.com (freemail)", async () => {
      const result = await resolveCompanyFromEmail(
        { userId, email: "someone@yahoo.com" },
        db,
      );
      expect(result).toBeNull();
    });

    it("creates/reuses a single company entity for a corporate email", async () => {
      const first = await resolveCompanyFromEmail(
        { userId, email: "alice@startup.io" },
        db,
      );
      const second = await resolveCompanyFromEmail(
        { userId, email: "bob@startup.io" },
        db,
      );
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.id).toBe(second!.id);
      expect(first!.kind).toBe("company");
    });

    it("returns null for null email", async () => {
      const result = await resolveCompanyFromEmail({ userId, email: null }, db);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Hardening (audit findings C2 / H4 / M7) — false-merge guards on the edges
  // -------------------------------------------------------------------------
  describe("supplied-but-unnormalizable email (C2)", () => {
    it("does NOT name-merge two distinct un-normalizable addresses with the same name", async () => {
      // Both normalize to null (empty local after +strip) but were SUPPLIED — they must NOT
      // fall into name-only matching and collapse.
      const a = await resolveEntity({ userId, name: "Sales Team", email: "+sales@acme.com" }, db);
      const b = await resolveEntity({ userId, name: "Sales Team", email: "+support@acme.com" }, db);
      expect(a.id).not.toBe(b.id);
      expect(a.canonicalEmail).toBeNull();
      expect(b.canonicalEmail).toBeNull();
    });

    it("dedupes repeats of the SAME un-normalizable address", async () => {
      const a = await resolveEntity({ userId, name: null, email: '"q@x"@weird.test' }, db);
      const b = await resolveEntity({ userId, name: "Later Name", email: '"q@x"@weird.test' }, db);
      expect(a.id).toBe(b.id);
    });

    it("keeps an un-normalizable-email entity email-less", async () => {
      const u = await resolveEntity({ userId, name: "Weird Sender", email: "+x@weird2.test" }, db);
      expect(u.canonicalEmail).toBeNull();
    });
  });

  describe("name-only never attaches to an email-bearing entity via a tombstone (H4)", () => {
    it("creates a new name-only entity instead of following a merge pointer into an email row", async () => {
      // Email-bearing canonical B.
      const b = await resolveEntity({ userId, name: "Alex Kim", email: "alex@corp-h4.test" }, db);
      // Email-less tombstone A that points at B (simulating an admin merge).
      const [a] = await db
        .insert(entities)
        .values({
          userId,
          kind: "person",
          displayName: "Alex Kim",
          canonicalEmail: null,
          aliases: ["Alex Kim"],
          metadata: {},
          mergedIntoEntityId: b.id,
        })
        .returning();
      expect(a.mergedIntoEntityId).toBe(b.id);

      // Name-only resolve for "Alex Kim" must NOT return B (an email entity).
      const resolved = await resolveEntity({ userId, name: "Alex Kim", email: null }, db);
      expect(resolved.id).not.toBe(b.id);
      expect(resolved.canonicalEmail).toBeNull();
    });
  });

  describe("company domain uniqueness under concurrency (M7)", () => {
    it("collapses concurrent inserts of the same domain to a single row", async () => {
      const [c1, c2, c3] = await Promise.all([
        resolveCompany({ userId, domain: "concurrent-co.test" }, db),
        resolveCompany({ userId, domain: "concurrent-co.test" }, db),
        resolveCompany({ userId, domain: "concurrent-co.test" }, db),
      ]);
      expect(c1.id).toBe(c2.id);
      expect(c2.id).toBe(c3.id);
      const rows = await db
        .select()
        .from(entities)
        .where(and(eq(entities.userId, userId), eq(entities.kind, "company")));
      const matching = rows.filter(
        (r: { metadata: Record<string, unknown> }) => r.metadata?.domain === "concurrent-co.test",
      );
      expect(matching.length).toBe(1);
    });
  });
});
