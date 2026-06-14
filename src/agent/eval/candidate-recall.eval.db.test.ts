/**
 * Phase 7 D1 — CANDIDATE-RECALL eval (DB-gated).
 *
 * Measures the candidate loader's RECALL: given a "new email" for which a KNOWN
 * true loop exists, does `loadExtractionContext` surface that loop in
 * `openLoops`? A recall MISS here drops the true loop from the candidate set,
 * which forces the decider into an unwanted create-new (a duplicate loop). This
 * is the loader's characteristic failure mode.
 *
 * We seed one small graph (a user + loops across threads/entities) and pose a
 * set of recall scenarios, each naming the true loop that MUST be retrieved.
 * The audit's key cases are included explicitly:
 *   - a cross-thread SAME-ENTITY follow-up (entity generator), and
 *   - a topically-similar cross-thread loop (trigram generator).
 *
 * Reports a candidate-recall number = (# scenarios where the true loop was in
 * the returned candidate set) / (# scenarios). HARD asserts every true loop is
 * retrieved (recall === 1.0 on this seeded set).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/agent/eval/candidate-recall.eval.db.test.ts
 *
 * SKIPPED unless TEST_DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
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
import {
  loadExtractionContext,
  type LoadExtractionContextInput,
} from "@/agent/extraction-context";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("candidate-recall eval (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sql, { schema }) as any;

  const RUN_ID = Date.now();
  let userId: string;

  // Threads
  let threadCurrentId: string; // the inbound email's thread
  let threadOtherId: string; // a different thread (cross-thread cases)

  // Inbound emails / evidence (one set per thread)
  let inboundCurId: string;
  let inboundOtherId: string;
  let evidenceCurId: string;
  let evidenceOtherId: string;

  // Entities
  let acmeEntityId: string; // a participant entity shared across threads

  // True loops the scenarios reference
  let loopSameThread: string; // same-thread follow-up
  let loopSameEntityCrossThread: string; // cross-thread, same entity (AUDIT case)
  let loopTrigramCrossThread: string; // cross-thread, topically similar (AUDIT case)

  const acmeEmail = `acme-${RUN_ID}@corp.example`;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `test-recall-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });
    userId = u.id;

    const [tc] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `recall-cur-${RUN_ID}`, subject: "Current thread" })
      .returning({ id: emailThreads.id });
    threadCurrentId = tc.id;

    const [to] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `recall-other-${RUN_ID}`, subject: "Other thread" })
      .returning({ id: emailThreads.id });
    threadOtherId = to.id;

    const [ieC] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: threadCurrentId,
        provider: "postmark",
        providerMessageId: `recall-cur-${RUN_ID}`,
        senderEmail: acmeEmail,
        subject: "Current",
        textBody: "body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundCurId = ieC.id;

    const [ieO] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId: threadOtherId,
        provider: "postmark",
        providerMessageId: `recall-other-${RUN_ID}`,
        senderEmail: acmeEmail,
        subject: "Other",
        textBody: "body",
        recipients: [],
        ccRecipients: [],
        headers: {},
        attachmentMetadata: [],
        normalizedPayload: {},
        rawPayload: {},
      })
      .returning({ id: inboundEmails.id });
    inboundOtherId = ieO.id;

    const [evC] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inboundCurId, providerMessageId: `recall-cur-${RUN_ID}`, quote: "q", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });
    evidenceCurId = evC.id;

    const [evO] = await db
      .insert(sourceEvidence)
      .values({ userId, inboundEmailId: inboundOtherId, providerMessageId: `recall-other-${RUN_ID}`, quote: "q", normalizedBody: "" })
      .returning({ id: sourceEvidence.id });
    evidenceOtherId = evO.id;

    const [ae] = await db
      .insert(entities)
      .values({
        userId,
        kind: "person" as const,
        displayName: `Acme Rep ${RUN_ID}`,
        canonicalEmail: acmeEmail,
        aliases: [],
        metadata: {},
      })
      .returning({ id: entities.id });
    acmeEntityId = ae.id;

    // ── True loop 1: same-thread follow-up (thread generator). ──────────────
    const [l1] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: threadCurrentId,
        inboundEmailId: inboundCurId,
        sourceEvidenceId: evidenceCurId,
        status: "open" as const,
        kind: "commitment" as const,
        basis: "explicit_commitment" as const,
        summary: `Send Acme the Q2 renewal contract by Friday ${RUN_ID}`,
        confidence: 0.9,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopSameThread = l1.id;

    // ── True loop 2: cross-thread, SAME ENTITY follow-up (AUDIT case). ──────
    // Lives on the OTHER thread, but is linked to the Acme entity who is a
    // participant on the new email → must be recalled via the entity generator.
    const [l2] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: threadOtherId,
        inboundEmailId: inboundOtherId,
        sourceEvidenceId: evidenceOtherId,
        status: "waiting_on_other" as const,
        kind: "ask" as const,
        basis: "inferred_next_step" as const,
        summary: `Get the signed MSA back from the Acme legal team ${RUN_ID}`,
        confidence: 0.7,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopSameEntityCrossThread = l2.id;

    await db
      .insert(loopEntities)
      .values({ loopId: loopSameEntityCrossThread, entityId: acmeEntityId, role: "participant" as const })
      .onConflictDoNothing();

    // ── True loop 3: cross-thread, TOPICALLY SIMILAR (AUDIT trigram case). ──
    // No thread overlap, NOT linked to the participant entity — can only be
    // recalled by trigram similarity on the summary vs. the query text.
    const [l3] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId: threadOtherId,
        inboundEmailId: inboundOtherId,
        sourceEvidenceId: evidenceOtherId,
        status: "candidate" as const,
        kind: "reminder" as const,
        basis: "inferred_next_step" as const,
        summary: `Prepare the quarterly budget forecast spreadsheet for finance ${RUN_ID}`,
        confidence: 0.6,
        participants: [],
        ambiguityFlags: [],
      })
      .returning({ id: loops.id });
    loopTrigramCrossThread = l3.id;
  });

  afterAll(async () => {
    const allLoopIds = [loopSameThread, loopSameEntityCrossThread, loopTrigramCrossThread].filter(Boolean);
    if (allLoopIds.length > 0) {
      await db.delete(loopEntities).where(inArray(loopEntities.loopId, allLoopIds));
      await db.delete(loops).where(inArray(loops.id, allLoopIds));
    }
    const allEvidenceIds = [evidenceCurId, evidenceOtherId].filter(Boolean);
    if (allEvidenceIds.length > 0) {
      await db.delete(sourceEvidence).where(inArray(sourceEvidence.id, allEvidenceIds));
    }
    const allInboundIds = [inboundCurId, inboundOtherId].filter(Boolean);
    if (allInboundIds.length > 0) {
      await db.delete(inboundEmails).where(inArray(inboundEmails.id, allInboundIds));
    }
    const allThreadIds = [threadCurrentId, threadOtherId].filter(Boolean);
    if (allThreadIds.length > 0) {
      await db.delete(emailThreads).where(inArray(emailThreads.id, allThreadIds));
    }
    if (acmeEntityId) {
      await db.delete(entities).where(eq(entities.id, acmeEntityId));
    }
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  // ── Recall scenario set. Each names the true loop that MUST be retrieved. ──
  type RecallScenario = {
    name: string;
    input: () => LoadExtractionContextInput;
    trueLoop: () => string;
    /** Which generator path is expected to recall it (asserted as a label). */
    expectGenerator: "thread" | "entity" | "trigram";
  };

  function scenarios(): RecallScenario[] {
    return [
      {
        name: "same-thread follow-up is recalled (thread generator)",
        input: () => ({
          userId,
          threadId: threadCurrentId,
          participants: [{ name: `Acme Rep ${RUN_ID}`, email: acmeEmail }],
          queryText: "renewal contract",
          limit: 20,
        }),
        trueLoop: () => loopSameThread,
        expectGenerator: "thread",
      },
      {
        name: "AUDIT: cross-thread SAME-ENTITY follow-up is recalled (entity generator)",
        input: () => ({
          userId,
          // New email is on the CURRENT thread; the true loop is on the OTHER
          // thread but with the same Acme participant.
          threadId: threadCurrentId,
          participants: [{ name: `Acme Rep ${RUN_ID}`, email: acmeEmail }],
          queryText: "any unrelated subject text",
          limit: 20,
        }),
        trueLoop: () => loopSameEntityCrossThread,
        expectGenerator: "entity",
      },
      {
        name: "AUDIT: cross-thread TOPICALLY-SIMILAR loop is recalled (trigram generator)",
        input: () => ({
          userId,
          // No thread overlap and NO participant entity link to this loop —
          // recall must come purely from trigram similarity.
          threadId: threadCurrentId,
          participants: [],
          queryText: `quarterly budget forecast spreadsheet for finance ${RUN_ID}`,
          limit: 20,
        }),
        trueLoop: () => loopTrigramCrossThread,
        expectGenerator: "trigram",
      },
    ];
  }

  it("recalls every true loop and reports candidate-recall === 1.0", async () => {
    const set = scenarios();
    let hits = 0;
    const misses: string[] = [];

    for (const s of set) {
      const ctx = await loadExtractionContext(s.input(), db);
      const ids = ctx.openLoops.map((l) => l.id);
      const found = ctx.openLoops.find((l) => l.id === s.trueLoop());
      if (found) {
        hits += 1;
        // The intended generator path should be among those that surfaced it.
        expect(
          found.generators,
          `[${s.name}] expected generator "${s.expectGenerator}" in ${JSON.stringify(found.generators)}`,
        ).toContain(s.expectGenerator);
      } else {
        misses.push(`  MISS: [${s.name}] true loop ${s.trueLoop()} not in candidate set ${JSON.stringify(ids)}`);
      }
    }

    const recall = set.length === 0 ? 1 : hits / set.length;

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "── Candidate-recall eval ─────────────────────────────────────",
        `  scenarios:        ${set.length}`,
        `  recalled:         ${hits}`,
        `  candidate-recall: ${(recall * 100).toFixed(1)}%`,
        ...(misses.length ? ["  misses:", ...misses] : []),
        "──────────────────────────────────────────────────────────────",
      ].join("\n"),
    );

    expect(misses, `recall misses:\n${misses.join("\n")}`).toEqual([]);
    expect(recall).toBe(1);
  });

  it("AUDIT: same-entity cross-thread AND trigram cross-thread loops are BOTH retrieved together", async () => {
    // Pose a single new email whose participants include Acme AND whose query
    // text is topically similar to the trigram loop. Both audit loops must come
    // back in one call.
    const ctx = await loadExtractionContext(
      {
        userId,
        threadId: threadCurrentId,
        participants: [{ name: `Acme Rep ${RUN_ID}`, email: acmeEmail }],
        queryText: `quarterly budget forecast spreadsheet for finance ${RUN_ID}`,
        limit: 20,
      },
      db,
    );

    const ids = ctx.openLoops.map((l) => l.id);
    expect(ids).toContain(loopSameEntityCrossThread);
    expect(ids).toContain(loopTrigramCrossThread);

    const entityLoop = ctx.openLoops.find((l) => l.id === loopSameEntityCrossThread)!;
    expect(entityLoop.generators).toContain("entity");

    const trigramLoop = ctx.openLoops.find((l) => l.id === loopTrigramCrossThread)!;
    expect(trigramLoop.generators).toContain("trigram");
  });
});
