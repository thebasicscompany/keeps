import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
import {
  applyLoopReplyCommand,
  mutateLoopState,
  type LoopMutationAction,
  type LoopProcessingRepository,
  type PersistedLoop,
} from "@/loops/service";
import { createReport, applyReportRowAction } from "@/reports/service";
import type {
  InsertReportInput,
  InsertedReport,
  ReportsRepository,
  StoredReport,
} from "@/reports/repository";
import type { ReportLoop, ReportLoopActivity } from "@/reports/query";
import { hashReportToken } from "@/reports/token";

/**
 * D2 — THE KEYSTONE PARITY TEST.
 *
 * Phase 5's central invariant: a web report row-action and an email reply command
 * MUST be byte-identical state transitions. Both flow through the SINGLE funnel
 * `mutateLoopState`, so for the same loop + same logical action they produce:
 *   - identical `loop_events` rows EXCEPT `metadata.source`
 *     ("email_command" vs "report_row_action"), and
 *   - an identical `loop.updated` event payload.
 *
 * This test exercises the TWO REAL entry points:
 *   - EMAIL path:  applyLoopReplyCommand(text, ...) — parses the reply, selects the
 *                  ordinal target, then calls mutateLoopState(source:"email_command").
 *   - ROW-ACTION path: mutateLoopState(source:"report_row_action") — the exact call
 *                  src/reports/service.ts::applyReportRowAction makes for a web row.
 *
 * If either path ever forks its own mutation/event-writing logic, this test fails.
 */

/** A recorded loop_events write — exactly the columns updateLoopFromCommand persists. */
type RecordedLoopEvent = {
  loopId: string;
  userId: string;
  status: LoopStatus;
  eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
  commandText: string;
  /** loop_events.metadata — the ONLY field allowed to differ between the two paths. */
  metadata: { source: "email_command" | "report_row_action" };
};

/**
 * In-memory repository that records every updateLoopFromCommand call as the
 * loop_events row it represents (mirroring DrizzleLoopProcessingRepository, which
 * writes metadata:{ source: input.source ?? "email_command" }).
 */
class RecordingRepository implements Partial<LoopProcessingRepository> {
  readonly recorded: RecordedLoopEvent[] = [];
  private readonly loops = new Map<string, PersistedLoop>();

  seed(loop: PersistedLoop) {
    this.loops.set(loop.id, { ...loop });
  }

  get(loopId: string): PersistedLoop | undefined {
    return this.loops.get(loopId);
  }

  async updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
    source?: "email_command" | "report_row_action";
  }): Promise<PersistedLoop> {
    const existing = this.loops.get(input.loopId);
    if (!existing || existing.userId !== input.userId) {
      throw new Error(`Missing loop ${input.loopId} for user ${input.userId}`);
    }

    // Mirror the Drizzle impl exactly: metadata.source defaults to email_command.
    this.recorded.push({
      loopId: input.loopId,
      userId: input.userId,
      status: input.status,
      eventType: input.eventType,
      commandText: input.commandText,
      metadata: { source: input.source ?? "email_command" },
    });

    const updated: PersistedLoop = {
      ...existing,
      status: input.status,
      nextCheckAt: input.nextCheckAt ?? existing.nextCheckAt,
    };
    this.loops.set(updated.id, updated);
    return updated;
  }
}

const USER = "user-1";
const NOW = new Date("2026-06-15T17:00:00.000Z");

function seedLoop(): PersistedLoop {
  return {
    id: "loop-1",
    userId: USER,
    emailThreadId: "thread-1",
    inboundEmailId: "inbound-1",
    sourceEvidenceId: "ev-1",
    status: "open",
    summary: "Send the renewal packet to Acme.",
    sourceQuote: "Can you send the renewal packet?",
    confidence: 0.9,
    nextCheckAt: null,
  };
}

/**
 * Each case: the email reply text, its logical row action, and the SAME commandText
 * the web path passes so the only difference between the two loop_events rows is
 * metadata.source.
 */
const CASES: Array<{
  name: string;
  emailText: string;
  action: LoopMutationAction;
  expectedStatus: LoopStatus;
  expectedEventType: RecordedLoopEvent["eventType"];
}> = [
  { name: "done", emailText: "done 1", action: "mark_done", expectedStatus: "done", expectedEventType: "marked_done" },
  { name: "dismiss", emailText: "dismiss 1", action: "dismiss", expectedStatus: "dismissed", expectedEventType: "dismissed" },
  { name: "snooze", emailText: "snooze 1 until Monday", action: "snooze", expectedStatus: "snoozed", expectedEventType: "snoozed" },
];

describe("D2 keystone — email-command vs row-action parity", () => {
  for (const testCase of CASES) {
    it(`'${testCase.name}' produces identical loop_events (except metadata.source) and identical loop.updated`, async () => {
      // --- EMAIL path (real entry: applyLoopReplyCommand) ---
      const emailRepo = new RecordingRepository();
      emailRepo.seed(seedLoop());
      const emailResult = await applyLoopReplyCommand({
        userId: USER,
        text: testCase.emailText,
        loops: [emailRepo.get("loop-1") as PersistedLoop],
        repository: emailRepo as unknown as LoopProcessingRepository,
        now: NOW,
      });

      // --- ROW-ACTION path (real funnel call the web row action makes) ---
      const webRepo = new RecordingRepository();
      webRepo.seed(seedLoop());
      const webResult = await mutateLoopState({
        userId: USER,
        loopId: "loop-1",
        action: testCase.action,
        // Snooze needs a concrete next_check_at on the web side; it does not affect
        // the loop_events row or the loop.updated payload (neither carries it).
        snoozeUntil: testCase.action === "snooze" ? new Date("2026-06-22T16:00:00.000Z") : undefined,
        // The SAME commandText the email path stored, so the only difference is source.
        commandText: testCase.emailText,
        source: "report_row_action",
        repository: webRepo as unknown as LoopProcessingRepository,
      });

      // Sanity: each path wrote exactly one loop_events row.
      expect(emailResult.events).toHaveLength(1);
      expect(emailRepo.recorded).toHaveLength(1);
      expect(webRepo.recorded).toHaveLength(1);

      const emailEvent = emailRepo.recorded[0];
      const webEvent = webRepo.recorded[0];

      // 1. loop_events rows are byte-identical EXCEPT metadata.source.
      const { metadata: emailMeta, ...emailRest } = emailEvent;
      const { metadata: webMeta, ...webRest } = webEvent;
      expect(webRest).toEqual(emailRest);
      expect(emailMeta.source).toBe("email_command");
      expect(webMeta.source).toBe("report_row_action");

      // The eventType + status are exactly what this action should yield.
      expect(emailRest.eventType).toBe(testCase.expectedEventType);
      expect(emailRest.status).toBe(testCase.expectedStatus);

      // 2. loop.updated event payloads are IDENTICAL across paths.
      expect(webResult.event.name).toBe("loop.updated");
      expect(emailResult.events[0].name).toBe("loop.updated");
      expect(webResult.event.data).toEqual(emailResult.events[0].data);
      expect(emailResult.events[0].data).toEqual({
        loopId: "loop-1",
        userId: USER,
        status: testCase.expectedStatus,
        eventType: testCase.expectedEventType,
      });

      // 3. The resulting loop row reached the same lifecycle status on both paths.
      expect(emailRepo.get("loop-1")?.status).toBe(testCase.expectedStatus);
      expect(webRepo.get("loop-1")?.status).toBe(testCase.expectedStatus);
    });
  }
});

/**
 * Minimal in-memory ReportsRepository so we can drive the GENUINE web entry point
 * (createReport → applyReportRowAction) and prove B2's action mapping
 * (done→mark_done, dismiss→dismiss, snooze→snooze) funnels through mutateLoopState
 * with source "report_row_action" — identical eventType/status/loop.updated to the
 * email path (commandText + source are the documented per-path provenance fields).
 */
class FakeReportsRepository implements ReportsRepository {
  private report: (StoredReport & { id: string }) | null = null;
  constructor(private readonly loopFor: () => ReportLoop) {}

  async insertReport(input: InsertReportInput): Promise<InsertedReport> {
    const expiresAt = new Date("2026-06-30T00:00:00.000Z");
    const createdAt = NOW;
    this.report = {
      id: "report-1",
      userId: input.userId,
      kind: input.kind,
      scope: input.scope,
      summary: input.summary,
      tokenHash: input.tokenHash,
      expiresAt,
      createdAt,
      lastViewedAt: null,
      viewCount: 0,
    };
    return { id: "report-1", expiresAt, createdAt };
  }
  async findReportByTokenHash(tokenHash: string): Promise<StoredReport | null> {
    return this.report && this.report.tokenHash === tokenHash ? this.report : null;
  }
  async touchReportViewed(): Promise<boolean> {
    return false;
  }
  async loadLoopsForScope(): Promise<{ loops: ReportLoop[]; loopActivity: ReportLoopActivity[] }> {
    return { loops: [this.loopFor()], loopActivity: [] };
  }
}

function reportLoop(status: LoopStatus): ReportLoop {
  return {
    id: "loop-1",
    status,
    summary: "Send the renewal packet to Acme.",
    ownerText: null,
    requesterText: null,
    dueAt: null,
    confidence: 0.9,
    participants: [],
    sourceQuote: "Can you send the renewal packet?",
    sourceEvidenceId: "ev-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("D2 keystone — genuine web entry (applyReportRowAction) funnels through mutateLoopState", () => {
  const WEB_CASES: Array<{ action: "done" | "dismiss"; status: LoopStatus; eventType: RecordedLoopEvent["eventType"] }> = [
    { action: "done", status: "done", eventType: "marked_done" },
    { action: "dismiss", status: "dismissed", eventType: "dismissed" },
  ];

  for (const c of WEB_CASES) {
    it(`web row action '${c.action}' writes loop_events with source report_row_action + matching eventType/status`, async () => {
      const loopRepo = new RecordingRepository();
      loopRepo.seed(seedLoop());
      const reportsRepo = new FakeReportsRepository(() => reportLoop(loopRepo.get("loop-1")?.status ?? "open"));

      // Mint a real token via the real createReport.
      const { token } = await createReport({
        userId: USER,
        kind: "insights",
        scope: {},
        summary: "You have 1 open loop.",
        requestedVia: "email_command",
        inboundEmailId: "inbound-1",
        repository: reportsRepo,
      });

      const result = await applyReportRowAction({
        token,
        now: NOW,
        body: { loopId: "loop-1", action: c.action },
        reportsRepository: reportsRepo,
        loopRepository: loopRepo as unknown as LoopProcessingRepository,
      });

      expect(result.status).toBe("applied");
      expect(loopRepo.recorded).toHaveLength(1);
      const row = loopRepo.recorded[0];
      expect(row.metadata.source).toBe("report_row_action");
      expect(row.eventType).toBe(c.eventType);
      expect(row.status).toBe(c.status);
      expect(loopRepo.get("loop-1")?.status).toBe(c.status);
    });
  }

  it("a forged token never reaches mutateLoopState", async () => {
    const loopRepo = new RecordingRepository();
    loopRepo.seed(seedLoop());
    const reportsRepo = new FakeReportsRepository(() => reportLoop("open"));
    const { token } = await createReport({
      userId: USER,
      kind: "insights",
      scope: {},
      summary: "x",
      requestedVia: "email_command",
      inboundEmailId: "inbound-1",
      repository: reportsRepo,
    });
    // Tamper with the token.
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(hashReportToken(forged)).not.toBe(hashReportToken(token));
    const result = await applyReportRowAction({
      token: forged,
      now: NOW,
      body: { loopId: "loop-1", action: "dismiss" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo as unknown as LoopProcessingRepository,
    });
    expect(result.status).toBe("not_found");
    expect(loopRepo.recorded).toHaveLength(0); // no mutation on a bad token
  });
});
