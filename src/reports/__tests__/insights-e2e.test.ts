/**
 * D1 — insights e2e test
 *
 * End-to-end: an "what are my insights?" inbound email → router emits report.requested
 * → generate-report produces the report + reply → the token in the reply resolves to
 * a LIVE report via loadReportByToken.
 *
 * All in-memory: no DB, no model, no Inngest. useModel: false throughout.
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
import type { EmailSender, OutboundEmail, OutboundEmailStore } from "@/email/outbound";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import { directPostmarkFixture } from "@/email/fixtures/postmark";
import type {
  LoopProcessingRepository,
  LoopToPersist,
  PersistedLoop,
  PersistedNudge,
  PrivateReplyNudgeMetadata,
  ProcessableInboundEmail,
} from "@/loops/service";
import type { ReplyTargetStore, ResolvableNudge } from "@/loops/resolve-reply-target";
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";
import type { NudgeRepository } from "@/nudges/repository";
import type { ReportLoop, ReportLoopActivity } from "@/reports/query";
import type {
  InsertReportInput,
  InsertedReport,
  ReportsRepository,
  StoredReport,
} from "@/reports/repository";
import { generateReport, type GenerateReportPorts } from "@/workflows/functions/generate-report";
import { loadReportByToken } from "@/reports/service";
import { hashReportToken } from "@/reports/token";

// ---------------------------------------------------------------------------
// InMemoryRouterStore — copied verbatim from route-email.c4.test.ts pattern
// ---------------------------------------------------------------------------

class InMemoryRouterStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly loops = new Map<string, PersistedLoop>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  readonly timezones = new Map<string, string>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  // --- LoopProcessingRepository ---
  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }
  async findLoopsByInboundEmailId(id: string): Promise<PersistedLoop[]> {
    return [...this.loops.values()].filter((l) => l.inboundEmailId === id);
  }
  async persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    return input.loops.map((candidate) => {
      const loop: PersistedLoop = {
        id: this.allocateId("loop"),
        userId: input.email.userId,
        emailThreadId: input.email.emailThreadId,
        inboundEmailId: input.email.id,
        sourceEvidenceId: this.allocateId("evidence"),
        status: candidate.status,
        summary: candidate.summary,
        sourceQuote: candidate.source.quote,
        confidence: candidate.confidence,
        nextCheckAt: candidate.nextCheckAt ? new Date(candidate.nextCheckAt) : null,
      };
      this.loops.set(loop.id, loop);
      return loop;
    });
  }
  async createPrivateReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge> {
    return this.storeNudge(input.userId, input.inboundEmailId, input.body, input.metadata);
  }
  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    return this.storeNudge(input.userId, input.inboundEmailId, input.body, {
      kind: "private_reply",
      intent: input.intent,
      loopCount: 0,
      lowConfidence: false,
      ordinalMap: {},
    });
  }
  async listCommandableLoops(): Promise<PersistedLoop[]> {
    throw new Error("listCommandableLoops must not be called by the router");
  }
  async updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
  }): Promise<PersistedLoop> {
    const existing = this.loops.get(input.loopId);
    if (!existing) throw new Error(`Missing loop ${input.loopId}`);
    const updated: PersistedLoop = {
      ...existing,
      status: input.status,
      nextCheckAt: input.nextCheckAt ?? existing.nextCheckAt,
    };
    this.loops.set(updated.id, updated);
    return updated;
  }
  async recordLoopCorrection(): Promise<void> {}
  async findUserTimezone(userId: string): Promise<string | null> {
    return this.timezones.get(userId) ?? null;
  }

  // --- ReplyTargetStore ---
  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata } : null;
  }
  async findNudgeByOutboundInReplyTo(): Promise<ResolvableNudge | null> {
    return null;
  }
  async findLoopsByIds(loopIds: string[]): Promise<PersistedLoop[]> {
    return loopIds.flatMap((id) => {
      const loop = this.loops.get(id);
      return loop ? [loop] : [];
    });
  }

  private storeNudge(
    userId: string,
    inboundEmailId: string,
    body: string,
    metadata: PrivateReplyNudgeMetadata,
  ): PersistedNudge {
    const nudge: PersistedNudge = { id: randomUUID(), userId, inboundEmailId, body };
    this.nudges.set(nudge.id, { nudge, metadata });
    return nudge;
  }
  private allocateId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }
}

function makeEmail(id: string, overrides: Partial<NormalizedEmail>): ProcessableInboundEmail {
  return {
    id,
    userId: "user-1",
    emailThreadId: "thread-1",
    emailMessageId: `message-${id}`,
    normalized: { ...normalizePostmarkInbound(directPostmarkFixture), ...overrides },
  };
}

function makeDeps(store: InMemoryRouterStore, sent: string[], extra: Partial<RouterDeps> = {}): RouterDeps {
  return {
    repository: store,
    replyTargetStore: store,
    sendReply: async (nudgeId: string) => {
      sent.push(nudgeId);
    },
    useModel: false,
    now: new Date("2026-06-13T12:00:00.000Z"),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// In-memory fakes for generateReport — copied from generate-report.test.ts pattern
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-13T12:00:00.000Z");

function makeReportLoop(overrides: Partial<ReportLoop> & { id: string }): ReportLoop {
  return {
    id: overrides.id,
    status: overrides.status ?? "open",
    summary: overrides.summary ?? `Summary ${overrides.id}`,
    ownerText: overrides.ownerText ?? null,
    requesterText: overrides.requesterText ?? null,
    dueAt: overrides.dueAt ?? null,
    confidence: overrides.confidence ?? 0.8,
    participants: overrides.participants ?? [],
    sourceQuote: overrides.sourceQuote ?? `quote-${overrides.id}`,
    sourceEvidenceId: overrides.sourceEvidenceId ?? `ev-${overrides.id}`,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-06-01T00:00:00.000Z"),
  };
}

// Mix of statuses to populate multiple sections:
//   - L1: waiting_on_me        → needs_you
//   - L2: open + due in 3 days → due_soon
//   - L3: waiting_on_other     → waiting_on_others
const FIXTURE_LOOPS: ReportLoop[] = [
  makeReportLoop({ id: "L1", status: "waiting_on_me", summary: "Reply to Alice re: contract" }),
  makeReportLoop({
    id: "L2",
    status: "open",
    summary: "Finish the proposal deck",
    dueAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
  }),
  makeReportLoop({ id: "L3", status: "waiting_on_other", summary: "Awaiting Bob's review" }),
];

const FIXTURE_ACTIVITY: ReportLoopActivity[] = FIXTURE_LOOPS.map((l) => ({
  loopId: l.id,
  lastActivityAt: null,
}));

/**
 * E2E-aware ReportsRepository:
 * - insertReport stores the row keyed by tokenHash so findReportByTokenHash resolves it.
 * - loadLoopsForScope always returns the fixture (live-query pattern).
 * - touchReportViewed is a no-op (not tested here).
 */
class E2EReportsRepository implements ReportsRepository {
  private readonly stored = new Map<string, StoredReport>();

  async insertReport(input: InsertReportInput): Promise<InsertedReport> {
    const id = `report-${this.stored.size + 1}`;
    const expiresAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    const row: StoredReport = {
      id,
      userId: input.userId,
      kind: input.kind,
      scope: input.scope,
      summary: input.summary,
      tokenHash: input.tokenHash,
      expiresAt,
      createdAt: NOW,
      lastViewedAt: null,
      viewCount: 0,
    };
    // Key by tokenHash so findReportByTokenHash can retrieve it
    this.stored.set(input.tokenHash, row);
    return { id, expiresAt, createdAt: NOW };
  }

  async findReportByTokenHash(tokenHash: string): Promise<StoredReport | null> {
    return this.stored.get(tokenHash) ?? null;
  }

  async touchReportViewed(): Promise<boolean> {
    return false;
  }

  async loadLoopsForScope(): Promise<{ loops: ReportLoop[]; loopActivity: ReportLoopActivity[] }> {
    return { loops: FIXTURE_LOOPS, loopActivity: FIXTURE_ACTIVITY };
  }
}

class FakeNudgeRepository implements NudgeRepository {
  created: unknown[] = [];
  audits: unknown[] = [];

  async createNudgeRow(input: {
    userId: string;
    loopId: string | null;
    inboundEmailId: string | null;
    subject: string;
    body: string;
    type: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }> {
    this.created.push(input);
    return { id: `nudge-${this.created.length}` };
  }

  async writeAudit(input: {
    userId: string;
    action: "nudge.sent" | "digest.sent" | "report.generated";
    metadata: Record<string, unknown>;
  }): Promise<void> {
    this.audits.push(input);
  }

  async writeLoopEvent(): Promise<void> {}
  async findNudgeCandidates(): Promise<never[]> { return []; }
  async countNudgesSentSince(): Promise<number> { return 0; }
  async markLoopNudged(): Promise<void> {}
  async deferLoopNextCheck(): Promise<void> {}
  async findCandidateById(): Promise<null> { return null; }
  async findUserEmail(): Promise<string | null> { return null; }
}

class FakeEmailSender implements EmailSender {
  readonly provider = "fake";
  sends: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<{ providerMessageId: string }> {
    this.sends.push(email);
    return { providerMessageId: `pm-${this.sends.length}` };
  }
}

class FakeOutboundEmailStore implements OutboundEmailStore {
  recorded: unknown[] = [];
  marked: { nudgeId: string; sentAt: Date }[] = [];

  async recordSend(input: unknown): Promise<void> {
    this.recorded.push(input);
  }
  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    this.marked.push(input);
  }
}

// ---------------------------------------------------------------------------
// D1: Full e2e test
// ---------------------------------------------------------------------------

describe("D1 — insights e2e (router → generate-report → loadReportByToken)", () => {
  it("routes 'what are my insights?' → emits report.requested → generates report → resolves live via token", async () => {
    // ── STEP 1: ROUTER ─────────────────────────────────────────────────────────

    const routerStore = new InMemoryRouterStore();
    const sent: string[] = [];

    routerStore.addEmail(
      makeEmail("inbound-insights", {
        textBody: "what are my insights?",
        strippedTextReply: "what are my insights?",
      }),
    );

    const result = await routeEmail("inbound-insights", makeDeps(routerStore, sent));

    // Router should route to insight_command branch and emit no inline reply
    expect(result.branch).toBe("insight_command");
    expect(result.nudgeId).toBeNull();
    expect(sent).toEqual([]);

    // Events: email.classified then report.requested
    expect(result.events.map((e) => e.name)).toEqual(["email.classified", "report.requested"]);

    const reportRequestedEvent = result.events.find((e) => e.name === "report.requested");
    expect(reportRequestedEvent).toBeDefined();
    expect(reportRequestedEvent?.data).toMatchObject({
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      inboundEmailId: "inbound-insights",
    });

    // Extract reqData for the next step
    const reqData = reportRequestedEvent!.data as {
      userId: string;
      kind: "insights";
      scope: Record<string, unknown>;
      requestedVia: string;
      inboundEmailId: string;
    };

    expect(reqData.userId).toBe("user-1");

    // ── STEP 2: GENERATE-REPORT ─────────────────────────────────────────────────

    const reportsRepository = new E2EReportsRepository();
    const nudgeRepository = new FakeNudgeRepository();
    const sender = new FakeEmailSender();
    const store = new FakeOutboundEmailStore();

    const ports: GenerateReportPorts = {
      reportsRepository,
      nudgeRepository,
      sender,
      store,
      loadOwnerEmail: async () => "owner@example.com",
    };

    const generateResult = await generateReport({
      userId: reqData.userId,
      kind: reqData.kind,
      scope: reqData.scope,
      requestedVia: reqData.requestedVia,
      inboundEmailId: reqData.inboundEmailId,
      now: NOW,
      useModel: false,
      appBaseUrl: "https://keeps.email",
      replyToBase: "agent@keeps.ai",
      ports,
    });

    // Exactly one email sent to owner
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]!.to).toBe("owner@example.com");

    const textBody = sender.sends[0]!.textBody;

    // Email body shape: headline + "Private view: https://keeps.email/r/<token>" + commandable footer
    expect(textBody).toContain("open loop");
    expect(textBody).toMatch(/Private view: https:\/\/keeps\.email\/r\//);
    expect(textBody).toContain(
      "Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.",
    );

    // Extract token from the /r/<token> link
    const tokenMatch = textBody.match(/\/r\/([A-Za-z0-9_-]+)/);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1]!;

    // generateReport returns a tokenHash that is the sha256 of the raw token
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(generateResult.tokenHash).toBe(expectedHash);

    // ── STEP 3: RESOLVE via loadReportByToken ──────────────────────────────────

    // Same reportsRepository instance — it holds the inserted row keyed by tokenHash
    const liveResult = await loadReportByToken({
      token,
      now: NOW,
      repository: reportsRepository,
    });

    expect(liveResult.status).toBe("live");

    if (liveResult.status !== "live") throw new Error("expected live");

    // sections is a full ReportSections with 6 fixed sections
    expect(liveResult.sections.sections).toHaveLength(6);
    expect(liveResult.sections.sections.map((s) => s.key)).toEqual([
      "needs_you",
      "due_soon",
      "overdue",
      "waiting_on_others",
      "stale",
      "recently_done",
    ]);

    // summary is the persisted headline
    expect(liveResult.summary).toBe(generateResult.summaryHeadline);

    // Forged token (flip last char) → not_found
    const lastChar = token[token.length - 1]!;
    const forgedToken =
      token.slice(0, -1) + (lastChar === "A" ? "B" : "A");
    const forgedResult = await loadReportByToken({
      token: forgedToken,
      now: NOW,
      repository: reportsRepository,
    });
    expect(forgedResult.status).toBe("not_found");
  });
});
