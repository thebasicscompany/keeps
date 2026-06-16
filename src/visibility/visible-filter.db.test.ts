/**
 * DB-gated cross-scope verification (Wave 5 core). Constructs a synthetic multi-member org and
 * proves visibleLoopFilter — the SQL twin of canView, used by the reconciliation candidate reads —
 * actually scopes the loops query: a colleague's loop is INVISIBLE to a viewer with no connecting
 * edge (the leak the whole re-founding prevents) and becomes visible ONLY through an explicit
 * relationship (admin / manager / shared scope / explicit share).
 *
 * This is the integration proof that a cross-scope false-merge cannot happen: an out-of-scope loop
 * never enters the candidate set, so it can never be a merge target.
 *
 * Run: TEST_DATABASE_URL=... pnpm exec vitest run src/visibility/visible-filter.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  users,
  organizations,
  scopes,
  emailThreads,
  inboundEmails,
  sourceEvidence,
  loops,
} from "@/db/schema";
import { visibleLoopFilter } from "@/visibility/visible-filter";
import { selfOnlyScope, type ViewerScope } from "@/visibility/can-view";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("visibleLoopFilter cross-scope (DB integration)", () => {
  // biome-ignore lint: safe inside skipIf
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN = Date.now();
  let orgId: string;
  let userA: string; // the viewer
  let userB: string; // owns the loop under test
  let scopeBeta: string; // the scope B's loop belongs to
  let bLoopId: string;
  let aLoopId: string;

  async function insertLoopFor(userId: string, scopeId: string | null): Promise<string> {
    const [t] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `vf-${RUN}-${Math.random()}`, subject: "T" })
      .returning({ id: emailThreads.id });
    const [ib] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: t.id,
        provider: "postmark",
        providerMessageId: `vf-${RUN}-${Math.random()}`,
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
      .values({
        userId,
        orgId,
        inboundEmailId: ib.id,
        providerMessageId: `vf-${RUN}-${Math.random()}`,
        quote: "q",
        normalizedBody: "b",
      })
      .returning({ id: sourceEvidence.id });
    const [loop] = await db
      .insert(loops)
      .values({
        userId,
        orgId,
        scopeId,
        emailThreadId: t.id,
        inboundEmailId: ib.id,
        sourceEvidenceId: ev.id,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `vf loop ${RUN}-${Math.random()}`,
        confidence: 0.9,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    return loop.id;
  }

  beforeAll(async () => {
    const [a] = await db.insert(users).values({ email: `va-${RUN}@x.invalid` }).returning({ id: users.id });
    userA = a.id;
    const [b] = await db.insert(users).values({ email: `vb-${RUN}@x.invalid` }).returning({ id: users.id });
    userB = b.id;
    const [org] = await db.insert(organizations).values({ name: `VF ${RUN}` }).returning({ id: organizations.id });
    orgId = org.id;
    const [beta] = await db.insert(scopes).values({ orgId, kind: "deal", name: "Beta" }).returning({ id: scopes.id });
    scopeBeta = beta.id;

    bLoopId = await insertLoopFor(userB, scopeBeta);
    aLoopId = await insertLoopFor(userA, null);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId)); // cascades loops/evidence/scopes
    await db.delete(users).where(eq(users.id, userA));
    await db.delete(users).where(eq(users.id, userB));
    await sql.end();
  });

  /** Is B's loop visible to this viewer (run the actual SQL predicate)? */
  async function bLoopVisibleTo(viewer: ViewerScope): Promise<boolean> {
    const rows = await db
      .select({ id: loops.id })
      .from(loops)
      .where(and(visibleLoopFilter(viewer), eq(loops.id, bLoopId)));
    return rows.length === 1;
  }

  const viewerA = (over: Partial<ViewerScope> = {}): ViewerScope => ({ ...selfOnlyScope(userA, orgId), ...over });

  it("a colleague's out-of-scope loop is INVISIBLE to a self-only viewer (leak prevented)", async () => {
    expect(await bLoopVisibleTo(viewerA())).toBe(false);
  });

  it("the viewer always sees their OWN loop", async () => {
    const rows = await db
      .select({ id: loops.id })
      .from(loops)
      .where(and(visibleLoopFilter(viewerA()), eq(loops.id, aLoopId)));
    expect(rows.length).toBe(1);
  });

  it("becomes visible via org-admin, manager-of-owner, shared scope, or explicit share", async () => {
    expect(await bLoopVisibleTo(viewerA({ isOrgAdmin: true }))).toBe(true);
    expect(await bLoopVisibleTo(viewerA({ managedUserIds: new Set([userB]) }))).toBe(true);
    expect(await bLoopVisibleTo(viewerA({ scopeIds: new Set([scopeBeta]) }))).toBe(true);
    expect(await bLoopVisibleTo(viewerA({ sharedResourceIds: new Set([bLoopId]) }))).toBe(true);
  });

  it("a DIFFERENT scope does NOT grant visibility (no over-broad match)", async () => {
    expect(await bLoopVisibleTo(viewerA({ scopeIds: new Set(["00000000-0000-0000-0000-000000000000"]) }))).toBe(
      false,
    );
  });
});
