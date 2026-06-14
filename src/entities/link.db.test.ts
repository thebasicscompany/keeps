/**
 * DB-gated integration tests for linkLoopEntities (Phase 7 A3).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/entities/link.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Test fixture chain (all FK-safe):
 *   users → email_threads → inbound_emails → source_evidence → loops
 *
 * Each test case gets its own loop row so tests are fully isolated.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, count } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  emailThreads,
  inboundEmails,
  sourceEvidence,
  loops,
  loopEntities,
  entities,
} from "@/db/schema";
import { linkLoopEntities } from "@/entities/link";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("linkLoopEntities (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN_ID = Date.now();
  let userId: string;
  let emailThreadId: string;
  let inboundEmailId: string;
  let sourceEvidenceId: string;

  // ---------------------------------------------------------------------------
  // Helper: insert a minimal loop row and return its id
  // ---------------------------------------------------------------------------
  async function insertLoop(): Promise<string> {
    const [loop] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `test loop ${RUN_ID}-${Math.random()}`,
        confidence: 0.9,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    return loop.id;
  }

  // Helper: count loop_entities rows for a given loop and role
  async function countLoopEntities(loopId: string, role?: string): Promise<number> {
    const rows = await db
      .select({ c: count() })
      .from(loopEntities)
      .where(
        role
          ? and(eq(loopEntities.loopId, loopId), eq(loopEntities.role, role as schema.LoopEntityRole))
          : eq(loopEntities.loopId, loopId),
      );
    return Number(rows[0]?.c ?? 0);
  }

  // Helper: get the loop row
  async function getLoop(loopId: string): Promise<schema.Loop | undefined> {
    const [row] = await db.select().from(loops).where(eq(loops.id, loopId)).limit(1);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Setup / Teardown
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    // Create user
    const [u] = await db
      .insert(users)
      .values({
        email: `test-link-${RUN_ID}@test.invalid`,
        timezone: "UTC",
      })
      .returning({ id: users.id });
    userId = u.id;

    // Create email thread
    const [thread] = await db
      .insert(emailThreads)
      .values({
        userId,
        threadKey: `link-test-thread-${RUN_ID}`,
        subject: "Test thread",
      })
      .returning({ id: emailThreads.id });
    emailThreadId = thread.id;

    // Create inbound email (minimal required fields)
    const [inbound] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId,
        provider: "postmark",
        providerMessageId: `link-test-msg-${RUN_ID}`,
        senderEmail: `sender-${RUN_ID}@test.invalid`,
        subject: "Test",
        textBody: "Test body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundEmailId = inbound.id;

    // Create source evidence
    const [evidence] = await db
      .insert(sourceEvidence)
      .values({
        userId,
        inboundEmailId,
        emailMessageId: null,
        providerMessageId: `link-test-msg-${RUN_ID}`,
        quote: "Test quote",
        normalizedBody: "Test body",
        startOffset: 0,
        endOffset: 10,
        metadata: {},
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId = evidence.id;
  });

  afterAll(async () => {
    // Cascade delete cleans up loop_entities, loops, source_evidence, inbound_emails, threads
    await db.delete(users).where(eq(users.id, userId));
    // Also clean up entities (they are scoped to userId but no cascade from user delete in entity table)
    await db.delete(entities).where(eq(entities.userId, userId));
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // (a) Corporate email participant → links BOTH person AND company
  // ---------------------------------------------------------------------------

  it("(a) a participant with a corporate email links BOTH a person AND a company entity as participant", async () => {
    const loopId = await insertLoop();

    await linkLoopEntities(
      {
        userId,
        loopId,
        ownerText: null,
        requesterText: null,
        participants: [{ name: "Jane Corp", email: `jane-${RUN_ID}@acme-link-test.com` }],
      },
      db,
    );

    // Should have at least 2 participant rows: one person, one company
    const participantCount = await countLoopEntities(loopId, "participant");
    expect(participantCount).toBeGreaterThanOrEqual(2);

    // Verify a company entity with that domain exists
    const companyRows = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.kind, "company"),
        ),
      );
    const hasAcme = companyRows.some(
      (e: schema.Entity) => (e.metadata as Record<string, unknown>)?.domain === "acme-link-test.com",
    );
    expect(hasAcme).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (b) Freemail participant → links ONLY the person, NO company
  // ---------------------------------------------------------------------------

  it("(b) freemail participant links only the person, no company", async () => {
    const loopId = await insertLoop();

    await linkLoopEntities(
      {
        userId,
        loopId,
        ownerText: null,
        requesterText: null,
        participants: [{ name: "Gmail User", email: `gmailuser-${RUN_ID}@gmail.com` }],
      },
      db,
    );

    const participantCount = await countLoopEntities(loopId, "participant");
    // Exactly 1: the person only, no company for freemail
    expect(participantCount).toBe(1);

    // The single linked entity should be a person
    const linkedRows = await db
      .select({ entityId: loopEntities.entityId })
      .from(loopEntities)
      .where(and(eq(loopEntities.loopId, loopId), eq(loopEntities.role, "participant")));
    const [linkedEntityRow] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, linkedRows[0].entityId))
      .limit(1);
    expect(linkedEntityRow.kind).toBe("person");
  });

  // ---------------------------------------------------------------------------
  // (c) ownerText matching a participant name reuses that entity + sets FK
  // ---------------------------------------------------------------------------

  it("(c) ownerText matching a participant name reuses that entity and sets loops.ownerEntityId + owner row", async () => {
    const loopId = await insertLoop();
    const participantEmail = `owner-test-${RUN_ID}@corp-link-test.com`;

    await linkLoopEntities(
      {
        userId,
        loopId,
        ownerText: "Alice Owner",
        requesterText: null,
        participants: [{ name: "Alice Owner", email: participantEmail }],
      },
      db,
    );

    // Should have an owner role row
    const ownerCount = await countLoopEntities(loopId, "owner");
    expect(ownerCount).toBe(1);

    // The loop's ownerEntityId should be set
    const loop = await getLoop(loopId);
    expect(loop?.ownerEntityId).not.toBeNull();

    // The owner entity should be the same as the person resolved for the participant email
    const ownerRow = await db
      .select()
      .from(loopEntities)
      .where(and(eq(loopEntities.loopId, loopId), eq(loopEntities.role, "owner")))
      .limit(1);
    const ownerEntityId = ownerRow[0]?.entityId;
    expect(ownerEntityId).toBe(loop?.ownerEntityId);

    // That entity should have the participant's canonical email
    const [ownerEntity] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, ownerEntityId))
      .limit(1);
    expect(ownerEntity.canonicalEmail).toBe(participantEmail);
  });

  // ---------------------------------------------------------------------------
  // (d) self (selfEmail or "me") is NOT linked
  // ---------------------------------------------------------------------------

  it('(d) participant matching selfEmail is NOT linked; "me" name-only participant is also skipped', async () => {
    const loopId = await insertLoop();
    const selfEmailAddr = `self-${RUN_ID}@self-test.invalid`;

    await linkLoopEntities(
      {
        userId,
        loopId,
        ownerText: null,
        requesterText: null,
        participants: [
          { name: "Self User", email: selfEmailAddr },   // matches selfEmail → skip
          { name: "me", email: null },                    // pronoun → skip
          { name: "Other Person", email: `other-${RUN_ID}@other-test.com` }, // should link
        ],
        selfEmail: selfEmailAddr,
      },
      db,
    );

    // Only "Other Person" should be linked (+ their company)
    const allRows = await db
      .select({ entityId: loopEntities.entityId })
      .from(loopEntities)
      .where(eq(loopEntities.loopId, loopId));

    // Gather all linked entity canonical emails
    const linkedEntityIds = allRows.map((r: { entityId: string }) => r.entityId);
    const linkedEntities: schema.Entity[] = await Promise.all(
      linkedEntityIds.map(async (id: string) => {
        const [e] = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
        return e;
      }),
    );

    // No linked entity should be the self email
    const selfLinked = linkedEntities.some(
      (e) => e.canonicalEmail === selfEmailAddr,
    );
    expect(selfLinked).toBe(false);

    // No linked entity should have displayName "me" (the pronoun)
    const meLinked = linkedEntities.some(
      (e) => e.displayName?.toLowerCase() === "me" && e.canonicalEmail === null,
    );
    expect(meLinked).toBe(false);

    // The other person (+ their company) should be linked
    const totalCount = await countLoopEntities(loopId);
    expect(totalCount).toBeGreaterThanOrEqual(2); // person + company for other-test.com
  });

  // ---------------------------------------------------------------------------
  // (e) Idempotency — calling linkLoopEntities twice gives stable row count
  // ---------------------------------------------------------------------------

  it("(e) calling linkLoopEntities twice is idempotent (no duplicate loop_entities rows)", async () => {
    const loopId = await insertLoop();

    const input = {
      userId,
      loopId,
      ownerText: "Bob Idempotent",
      requesterText: null,
      participants: [{ name: "Bob Idempotent", email: `bob-idem-${RUN_ID}@idem-test.com` }],
    };

    await linkLoopEntities(input, db);
    const countAfterFirst = await countLoopEntities(loopId);

    await linkLoopEntities(input, db);
    const countAfterSecond = await countLoopEntities(loopId);

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(countAfterSecond).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // (f) Name-only requester (no matching participant) creates a name-only entity
  // ---------------------------------------------------------------------------

  it("(f) a name-only requester (no matching participant) creates a name-only entity as requester", async () => {
    const loopId = await insertLoop();

    await linkLoopEntities(
      {
        userId,
        loopId,
        ownerText: null,
        requesterText: "Mystery Requester",
        participants: [], // empty — no pool match
      },
      db,
    );

    // Should have exactly one requester row
    const requesterCount = await countLoopEntities(loopId, "requester");
    expect(requesterCount).toBe(1);

    // The loop FK should be set
    const loop = await getLoop(loopId);
    expect(loop?.requesterEntityId).not.toBeNull();

    // That entity should be a name-only person (no canonicalEmail)
    const [requesterEntity] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, loop!.requesterEntityId!))
      .limit(1);
    expect(requesterEntity.kind).toBe("person");
    expect(requesterEntity.canonicalEmail).toBeNull();
    expect(requesterEntity.displayName).toBe("Mystery Requester");
  });
});
