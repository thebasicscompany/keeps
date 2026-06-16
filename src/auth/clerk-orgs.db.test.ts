/**
 * DB-gated multi-member proof (Wave 6). Drives the REAL Clerk org-sync (syncClerkOrgMembership) and
 * proves the whole-org sharing guarantee end-to-end:
 *   - two members synced into the SAME Clerk org → each sees the other's loops (via the backfill +
 *     scope_member edge + visibleLoopFilter + getUserGraph), and
 *   - a user in a DIFFERENT org sees NOTHING of theirs (canView fails closed cross-org).
 *
 * This is the leak-prevention proof for the new sync path specifically.
 * Run: TEST_DATABASE_URL=... pnpm exec vitest run src/auth/clerk-orgs.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  userIdentities,
  organizations,
  emailThreads,
  inboundEmails,
  sourceEvidence,
  loops,
  entities,
  loopEntities,
} from "@/db/schema";
import { ensurePersonalOrg } from "@/visibility/personal-org";
import { syncClerkOrgMembership } from "@/auth/clerk-orgs";
import { loadViewerScope } from "@/visibility/load-scope";
import { visibleLoopFilter } from "@/visibility/visible-filter";
import { getUserGraph } from "@/entities/listing";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("Clerk org-sync multi-member sharing (DB integration)", () => {
  // biome-ignore lint: safe inside skipIf
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN = Date.now();
  const clerkOrgX = `org_x_${RUN}`;
  const clerkOrgY = `org_y_${RUN}`;
  let userA: string; // owns the loop; member of org X
  let userB: string; // teammate in org X — must SEE A's loop
  let userC: string; // in org Y — must NOT see A's loop
  let aLoopId: string;
  const clerkA = `cu_a_${RUN}`;
  const clerkB = `cu_b_${RUN}`;
  const clerkC = `cu_c_${RUN}`;
  const createdOrgIds: string[] = [];

  async function seedUser(email: string, clerkId: string): Promise<string> {
    const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
    await db
      .insert(userIdentities)
      .values({ userId: u.id, provider: "clerk", providerAccountId: clerkId, email, isPrimary: true });
    await ensurePersonalOrg({ userId: u.id, db });
    return u.id;
  }

  async function insertLoopFor(userId: string): Promise<string> {
    const [t] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `co-${RUN}-${Math.random()}`, subject: "T" })
      .returning({ id: emailThreads.id });
    const [ib] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: t.id,
        provider: "postmark",
        providerMessageId: `co-${RUN}-${Math.random()}`,
        senderEmail: `s-${RUN}@x.invalid`,
        subject: "T",
        textBody: "b",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    const [ev] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: ib.id, providerMessageId: `co-${RUN}-${Math.random()}`, quote: "q", normalizedBody: "b" })
      .returning({ id: sourceEvidence.id });
    const [loop] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: t.id,
        inboundEmailId: ib.id,
        sourceEvidenceId: ev.id,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `co loop ${RUN}`,
        confidence: 0.9,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    // Link an entity so the entity-graph read path (getUserGraph) has something to surface.
    const [ent] = await db
      .insert(entities)
      .values({ userId, kind: "person" as const, displayName: "Pat Test", canonicalEmail: `pat-${RUN}@acme.invalid` })
      .returning({ id: entities.id });
    await db.insert(loopEntities).values({ loopId: loop.id, entityId: ent.id, role: "participant" as const });
    return loop.id;
  }

  const priorFlag = process.env.ORG_VISIBILITY_ENABLED;
  beforeAll(async () => {
    // getUserGraph gates viewer-scoping on this flag; turn it on for the read-path assertions.
    process.env.ORG_VISIBILITY_ENABLED = "1";
    userA = await seedUser(`coa-${RUN}@x.invalid`, clerkA);
    userB = await seedUser(`cob-${RUN}@x.invalid`, clerkB);
    userC = await seedUser(`coc-${RUN}@x.invalid`, clerkC);
    aLoopId = await insertLoopFor(userA);

    // A + B join the SAME Clerk org; C joins a different one.
    const ra = await syncClerkOrgMembership({ clerkOrgId: clerkOrgX, orgName: "Org X", clerkUserId: clerkA, clerkRole: "org:admin", db });
    const rb = await syncClerkOrgMembership({ clerkOrgId: clerkOrgX, orgName: "Org X", clerkUserId: clerkB, clerkRole: "org:member", db });
    const rc = await syncClerkOrgMembership({ clerkOrgId: clerkOrgY, orgName: "Org Y", clerkUserId: clerkC, clerkRole: "org:admin", db });
    if (ra.status === "synced") createdOrgIds.push(ra.orgId);
    if (rc.status === "synced") createdOrgIds.push(rc.orgId);
    expect(ra.status).toBe("synced");
    expect(rb.status).toBe("synced");
  });

  afterAll(async () => {
    for (const id of createdOrgIds) await db.delete(organizations).where(eq(organizations.id, id));
    for (const uid of [userA, userB, userC]) await db.delete(users).where(eq(users.id, uid));
    await sql.end();
    if (priorFlag === undefined) delete process.env.ORG_VISIBILITY_ENABLED;
    else process.env.ORG_VISIBILITY_ENABLED = priorFlag;
  });

  async function aLoopVisibleVia(userId: string): Promise<boolean> {
    const scope = await loadViewerScope({ userId, db });
    if (!scope) return false;
    const rows = await db.select({ id: loops.id }).from(loops).where(and(visibleLoopFilter(scope), eq(loops.id, aLoopId)));
    return rows.length === 1;
  }

  it("a teammate in the SAME org sees the owner's loop (whole-org sharing)", async () => {
    expect(await aLoopVisibleVia(userB)).toBe(true);
  });

  it("the owner sees their own loop", async () => {
    expect(await aLoopVisibleVia(userA)).toBe(true);
  });

  it("a user in a DIFFERENT org does NOT see it (cross-org leak prevented)", async () => {
    expect(await aLoopVisibleVia(userC)).toBe(false);
  });

  it("the teammate's knowledge graph surfaces the shared loop; the outsider's does not", async () => {
    const bGraph = await getUserGraph(userB, db);
    expect(bGraph.totals.openLoops).toBeGreaterThanOrEqual(1);
    const cGraph = await getUserGraph(userC, db);
    expect(cGraph.totals.openLoops).toBe(0);
  });
});
