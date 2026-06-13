/**
 * DB-gated integration tests for DrizzleReportsRepository.
 *
 * These exercise the REAL Drizzle SQL against a live Postgres instance.
 * SKIPPED unless TEST_DATABASE_URL is set:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm exec vitest run src/reports/repository.db.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  emailThreads,
  generatedReports,
  inboundEmails,
  loopEvents,
  loops,
  sourceEvidence,
  users,
} from "@/db/schema";
import { DrizzleReportsRepository } from "@/reports/repository";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("DrizzleReportsRepository (DB integration)", () => {
  // biome-ignore lint: non-null assertion is safe inside skipIf guard
  const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
  const db = drizzle(sql, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrizzleReportsRepository(db as any);

  // Shared fixture IDs — populated in beforeAll, cleaned up in afterAll
  let userId: string;
  let emailThreadId: string;
  let inboundEmailId: string;   // originating inbound email for loop
  let inboundEmailId2: string;  // later inbound email on the same thread
  let sourceEvidenceId: string;
  let loopId: string;
  let loopId2: string;
  let reportId: string; // set by insertReport test, used by touch tests

  const RUN_ID = Date.now(); // unique per test run — prevents cross-run collisions
  const NOW = new Date("2026-06-13T12:00:00.000Z");
  const LOOP_CREATED = new Date("2026-06-08T10:00:00.000Z");
  const EVENT_AT = new Date("2026-06-10T09:00:00.000Z");   // non-created loop event time
  const EMAIL2_AT = new Date("2026-06-11T15:00:00.000Z");  // later inbound email time

  beforeAll(async () => {
    // ── User ──────────────────────────────────────────────────────────────────
    const [u] = await db
      .insert(users)
      .values({
        email: `test-reports-repo-${RUN_ID}@test.invalid`,
        timezone: "UTC",
      })
      .returning({ id: users.id });
    userId = u.id;

    // ── Email thread ──────────────────────────────────────────────────────────
    const [t] = await db
      .insert(emailThreads)
      .values({ userId, threadKey: `thread-reports-repo-${RUN_ID}` })
      .returning({ id: emailThreads.id });
    emailThreadId = t.id;

    // ── Originating inbound email ─────────────────────────────────────────────
    const [ie] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId,
        provider: "test",
        providerMessageId: `msg-reports-repo-orig-${RUN_ID}`,
        senderEmail: "sender@test.invalid",
        normalizedPayload: {},
        rawPayload: {},
        providerReceivedAt: LOOP_CREATED,
      })
      .returning({ id: inboundEmails.id });
    inboundEmailId = ie.id;

    // ── Later inbound email on the same thread ────────────────────────────────
    const [ie2] = await db
      .insert(inboundEmails)
      .values({
        userId,
        emailThreadId,
        provider: "test",
        providerMessageId: `msg-reports-repo-later-${RUN_ID}`,
        senderEmail: "reply@test.invalid",
        normalizedPayload: {},
        rawPayload: {},
        providerReceivedAt: EMAIL2_AT,
      })
      .returning({ id: inboundEmails.id });
    inboundEmailId2 = ie2.id;

    // ── Source evidence ───────────────────────────────────────────────────────
    const [se] = await db
      .insert(sourceEvidence)
      .values({
        userId,
        inboundEmailId,
        providerMessageId: `msg-reports-repo-orig-${RUN_ID}`,
        quote: "Please send over the proposal by Friday",
      })
      .returning({ id: sourceEvidence.id });
    sourceEvidenceId = se.id;

    // ── Loop 1 — open, will have both a loop event and a later inbound email ──
    const [l] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId,
        status: "open",
        summary: "Send the proposal by Friday",
        ownerText: "Arav",
        requesterText: "Client",
        confidence: 0.85,
        participants: [{ name: "Client", email: "client@example.com" }],
        createdAt: LOOP_CREATED,
        updatedAt: LOOP_CREATED,
        nextCheckAt: new Date("2026-06-20T12:00:00.000Z"),
      })
      .returning({ id: loops.id });
    loopId = l.id;

    // ── Loop event (non-'created') for loop 1 ────────────────────────────────
    await db.insert(loopEvents).values({
      userId,
      loopId,
      eventType: "confirmed",
      createdAt: EVENT_AT,
    });

    // ── Loop 2 — waiting_on_other (no events, no later emails) ───────────────
    // Use a second source evidence with the same inbound email for simplicity
    const [se2] = await db
      .insert(sourceEvidence)
      .values({
        userId,
        inboundEmailId,
        providerMessageId: `msg-reports-repo-orig-${RUN_ID}-2`,
        quote: "Awaiting sign-off from legal",
      })
      .returning({ id: sourceEvidence.id });

    const [l2] = await db
      .insert(loops)
      .values({
        userId,
        emailThreadId,
        inboundEmailId,
        sourceEvidenceId: se2.id,
        status: "waiting_on_other",
        summary: "Awaiting legal sign-off",
        confidence: 0.7,
        participants: [],
        createdAt: LOOP_CREATED,
        updatedAt: LOOP_CREATED,
        nextCheckAt: new Date("2026-06-25T12:00:00.000Z"),
      })
      .returning({ id: loops.id });
    loopId2 = l2.id;
  });

  afterAll(async () => {
    // Clean up in reverse FK order
    await db.delete(loopEvents).where(eq(loopEvents.loopId, loopId));
    await db.delete(generatedReports).where(eq(generatedReports.userId, userId));
    await db.delete(loops).where(inArray(loops.id, [loopId, loopId2]));
    // source evidence for loop 2 — delete separately since loopId2's se.id isn't
    // captured in a top-level variable; cascade from loops handles it if FK is set,
    // but source_evidence has cascade from inboundEmails, not loops, so clean up user rows
    await db.delete(sourceEvidence).where(eq(sourceEvidence.userId, userId));
    await db.delete(inboundEmails).where(inArray(inboundEmails.id, [inboundEmailId, inboundEmailId2]));
    await db.delete(emailThreads).where(eq(emailThreads.id, emailThreadId));
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // insertReport / findReportByTokenHash
  // ---------------------------------------------------------------------------

  it("insertReport returns id + expiresAt ~7 days out + createdAt", async () => {
    const result = await repo.insertReport({
      userId,
      kind: "insights",
      scope: {},
      summary: "You have 2 open loops.",
      tokenHash: `tok-${RUN_ID}-a`,
      requestedVia: "email",
      requestInboundEmailId: null,
      requestNudgeId: null,
    });

    reportId = result.id;
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);

    // createdAt should be recent (within the last minute)
    const ageSec = (Date.now() - result.createdAt.getTime()) / 1000;
    expect(ageSec).toBeGreaterThanOrEqual(0);
    expect(ageSec).toBeLessThan(60);

    // expiresAt should be ~7 days from createdAt
    const diffDays = (result.expiresAt.getTime() - result.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("findReportByTokenHash returns the inserted row", async () => {
    const row = await repo.findReportByTokenHash(`tok-${RUN_ID}-a`);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(reportId);
    expect(row!.userId).toBe(userId);
    expect(row!.kind).toBe("insights");
    expect(row!.summary).toBe("You have 2 open loops.");
    expect(row!.viewCount).toBe(0);
    expect(row!.lastViewedAt).toBeNull();
  });

  it("findReportByTokenHash returns null for an unknown token", async () => {
    const row = await repo.findReportByTokenHash("totally-unknown-token-hash");
    expect(row).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // touchReportViewed — debounce logic
  // ---------------------------------------------------------------------------

  it("first touchReportViewed call returns true and sets view_count=1", async () => {
    const bumped = await repo.touchReportViewed(reportId, NOW);
    expect(bumped).toBe(true);

    const row = await repo.findReportByTokenHash(`tok-${RUN_ID}-a`);
    expect(row!.viewCount).toBe(1);
    expect(row!.lastViewedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("immediate second touchReportViewed (same now) returns false — debounced", async () => {
    const bumped = await repo.touchReportViewed(reportId, NOW);
    expect(bumped).toBe(false);

    // view_count must NOT have incremented
    const row = await repo.findReportByTokenHash(`tok-${RUN_ID}-a`);
    expect(row!.viewCount).toBe(1);
  });

  it("touchReportViewed with now advanced past debounceMs returns true and view_count=2", async () => {
    const debounceMs = 5 * 60 * 1000; // default 5 minutes
    const laterNow = new Date(NOW.getTime() + debounceMs + 1000); // 1s past threshold

    const bumped = await repo.touchReportViewed(reportId, laterNow, debounceMs);
    expect(bumped).toBe(true);

    const row = await repo.findReportByTokenHash(`tok-${RUN_ID}-a`);
    expect(row!.viewCount).toBe(2);
    expect(row!.lastViewedAt?.toISOString()).toBe(laterNow.toISOString());
  });

  // ---------------------------------------------------------------------------
  // loadLoopsForScope
  // ---------------------------------------------------------------------------

  it("loadLoopsForScope returns both loops with correct ReportLoop fields", async () => {
    const { loops: reportLoops } = await repo.loadLoopsForScope(userId, {});

    expect(reportLoops.length).toBe(2);

    const loop1 = reportLoops.find((l) => l.id === loopId);
    expect(loop1).toBeDefined();
    expect(loop1!.status).toBe("open");
    expect(loop1!.summary).toBe("Send the proposal by Friday");
    expect(loop1!.ownerText).toBe("Arav");
    expect(loop1!.requesterText).toBe("Client");
    expect(loop1!.confidence).toBeCloseTo(0.85);
    expect(loop1!.sourceQuote).toBe("Please send over the proposal by Friday");
    expect(loop1!.sourceEvidenceId).toBe(sourceEvidenceId);
    expect(loop1!.participants).toEqual([{ name: "Client", email: "client@example.com" }]);
    expect(loop1!.createdAt.toISOString()).toBe(LOOP_CREATED.toISOString());

    const loop2 = reportLoops.find((l) => l.id === loopId2);
    expect(loop2).toBeDefined();
    expect(loop2!.status).toBe("waiting_on_other");
    expect(loop2!.summary).toBe("Awaiting legal sign-off");
    expect(loop2!.participants).toEqual([]);
  });

  it("loadLoopsForScope computes lastActivityAt as max(loopEvent, laterInboundEmail)", async () => {
    const { loopActivity } = await repo.loadLoopsForScope(userId, {});

    const activity1 = loopActivity.find((a) => a.loopId === loopId);
    expect(activity1).toBeDefined();
    // lastActivityAt should be max(EVENT_AT=Jun 10, EMAIL2_AT=Jun 11) = EMAIL2_AT
    expect(activity1!.lastActivityAt?.toISOString()).toBe(EMAIL2_AT.toISOString());

    const activity2 = loopActivity.find((a) => a.loopId === loopId2);
    expect(activity2).toBeDefined();
    // loop2 has no non-created events; the later inbound email is on the same thread,
    // but loop2's originating inboundEmailId is the SAME as loop1's (inboundEmailId),
    // so the later email (inboundEmailId2) is still a valid activity signal.
    // lastActivityAt = EMAIL2_AT (from the later inbound email on the thread)
    expect(activity2!.lastActivityAt?.toISOString()).toBe(EMAIL2_AT.toISOString());
  });

  it("loadLoopsForScope excludes dismissed loops", async () => {
    // Temporarily dismiss loop 1
    await db.update(loops).set({ status: "dismissed" }).where(eq(loops.id, loopId));

    const { loops: reportLoops } = await repo.loadLoopsForScope(userId, {});
    expect(reportLoops.find((l) => l.id === loopId)).toBeUndefined();

    // Restore
    await db.update(loops).set({ status: "open" }).where(eq(loops.id, loopId));
  });

  it("loadLoopsForScope returns empty arrays for a user with no loops", async () => {
    // Create a second user with no loops
    const [u2] = await db
      .insert(users)
      .values({ email: `test-reports-noop-${RUN_ID}@test.invalid`, timezone: "UTC" })
      .returning({ id: users.id });

    const { loops: l, loopActivity: la } = await repo.loadLoopsForScope(u2.id, {});
    expect(l).toHaveLength(0);
    expect(la).toHaveLength(0);

    await db.delete(users).where(eq(users.id, u2.id));
  });
});
