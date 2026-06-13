import { describe, expect, it } from "vitest";

import {
  applyReportRowAction,
  createReport,
  loadReportByToken,
  recordReportView,
} from "@/reports/service";
import { hashReportToken } from "@/reports/token";
import type {
  InsertReportInput,
  InsertedReport,
  ReportsRepository,
  StoredReport,
} from "@/reports/repository";
import type { ReportLoop, ReportLoopActivity } from "@/reports/query";
import type { LoopProcessingRepository, PersistedLoop } from "@/loops/service";
import type { LoopStatus } from "@/agent/schemas";

// ---------------------------------------------------------------------------
// In-memory ReportsRepository fake
// ---------------------------------------------------------------------------

type StoredRow = StoredReport & {
  requestedVia: string;
  requestInboundEmailId: string | null;
  requestNudgeId: string | null;
};

class InMemoryReportsRepository implements ReportsRepository {
  readonly rows = new Map<string, StoredRow>();
  /** The live loop set this report's scope resolves to — mutable to prove live-query. */
  loops: ReportLoop[] = [];
  loopActivity: ReportLoopActivity[] = [];
  private nextId = 1;

  constructor(opts?: { expiresAt?: Date }) {
    this.defaultExpiresAt = opts?.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  private readonly defaultExpiresAt: Date;

  async insertReport(input: InsertReportInput): Promise<InsertedReport> {
    const id = `report-${this.nextId++}`;
    const createdAt = new Date();
    const row: StoredRow = {
      id,
      userId: input.userId,
      kind: input.kind,
      scope: input.scope,
      summary: input.summary,
      tokenHash: input.tokenHash,
      expiresAt: this.defaultExpiresAt,
      createdAt,
      lastViewedAt: null,
      viewCount: 0,
      requestedVia: input.requestedVia,
      requestInboundEmailId: input.requestInboundEmailId ?? null,
      requestNudgeId: input.requestNudgeId ?? null,
    };
    this.rows.set(id, row);
    return { id, expiresAt: row.expiresAt, createdAt };
  }

  async findReportByTokenHash(tokenHash: string): Promise<StoredReport | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash) return row;
    }
    return null;
  }

  /** Debounce: bump unless viewed within the window. Returns true when bumped. */
  async touchReportViewed(
    reportId: string,
    now: Date,
    debounceMs = 5 * 60 * 1000,
  ): Promise<boolean> {
    const row = this.rows.get(reportId);
    if (!row) return false;
    const threshold = new Date(now.getTime() - debounceMs);
    if (row.lastViewedAt !== null && row.lastViewedAt > threshold) {
      return false;
    }
    row.viewCount += 1;
    row.lastViewedAt = now;
    return true;
  }

  async loadLoopsForScope(
    _userId: string,
    _scope: Record<string, unknown>,
  ): Promise<{ loops: ReportLoop[]; loopActivity: ReportLoopActivity[] }> {
    return { loops: this.loops, loopActivity: this.loopActivity };
  }

  // Test helper: install a single loop in the live set.
  setLoops(loops: ReportLoop[], activity?: ReportLoopActivity[]) {
    this.loops = loops;
    this.loopActivity = activity ?? loops.map((l) => ({ loopId: l.id, lastActivityAt: null }));
  }
}

function makeReportLoop(overrides: Partial<ReportLoop> & { id: string }): ReportLoop {
  const now = new Date();
  return {
    id: overrides.id,
    status: overrides.status ?? "open",
    summary: overrides.summary ?? "A loop",
    ownerText: overrides.ownerText ?? null,
    requesterText: overrides.requesterText ?? null,
    dueAt: overrides.dueAt ?? null,
    confidence: overrides.confidence ?? 0.9,
    participants: overrides.participants ?? [],
    sourceQuote: overrides.sourceQuote ?? "quote",
    sourceEvidenceId: overrides.sourceEvidenceId ?? "evidence-1",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

// ---------------------------------------------------------------------------
// In-memory LoopProcessingRepository fake — only updateLoopFromCommand needed
// ---------------------------------------------------------------------------

type RecordedMutation = {
  loopId: string;
  userId: string;
  status: string;
  commandText: string;
  eventType: string;
  source?: string;
};

class InMemoryLoopRepo implements LoopProcessingRepository {
  /** loopId → owning userId + current status. Used to scope writes by (loopId, userId). */
  private readonly owned = new Map<string, { userId: string; status: string }>();
  readonly mutations: RecordedMutation[] = [];

  addLoop(loopId: string, userId: string, status = "open") {
    this.owned.set(loopId, { userId, status });
  }

  statusOf(loopId: string): string | undefined {
    return this.owned.get(loopId)?.status;
  }

  // Only updateLoopFromCommand is exercised by the reports service; the rest throw.
  async updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
    source?: "email_command" | "report_row_action";
  }): Promise<PersistedLoop> {
    const existing = this.owned.get(input.loopId);
    if (!existing || existing.userId !== input.userId) {
      throw new Error(`Missing loop ${input.loopId}`);
    }
    existing.status = input.status;
    this.mutations.push({
      loopId: input.loopId,
      userId: input.userId,
      status: input.status,
      commandText: input.commandText,
      eventType: input.eventType,
      source: input.source,
    });
    return {
      id: input.loopId,
      userId: input.userId,
      emailThreadId: "thread-1",
      inboundEmailId: "inbound-1",
      sourceEvidenceId: "evidence-1",
      status: input.status,
      summary: "loop",
      sourceQuote: "quote",
      confidence: 0.9,
      nextCheckAt: input.nextCheckAt ?? null,
    };
  }

  // Unused methods — the reports service never calls these.
  async findInboundEmailById(): Promise<never> {
    throw new Error("not implemented");
  }
  async findLoopsByInboundEmailId(): Promise<never> {
    throw new Error("not implemented");
  }
  async persistExtractedLoops(): Promise<never> {
    throw new Error("not implemented");
  }
  async createPrivateReplyNudge(): Promise<never> {
    throw new Error("not implemented");
  }
  async createReplyNudge(): Promise<never> {
    throw new Error("not implemented");
  }
  async listCommandableLoops(): Promise<never> {
    throw new Error("not implemented");
  }
  async recordLoopCorrection(): Promise<void> {
    throw new Error("not implemented");
  }
}

// ---------------------------------------------------------------------------
// createReport
// ---------------------------------------------------------------------------

describe("createReport", () => {
  it("returns a token + reportId + expiresAt and stores ONLY the sha256 hash", async () => {
    const repo = new InMemoryReportsRepository();

    const result = await createReport({
      userId: "user-1",
      kind: "weekly",
      scope: { foo: "bar" },
      summary: "Your week",
      requestedVia: "manual",
      repository: repo,
    });

    expect(result.token).toBeTruthy();
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.reportId).toBe("report-1");
    expect(result.expiresAt).toBeInstanceOf(Date);

    const row = repo.rows.get(result.reportId)!;
    // Stored hash matches the hash of the returned plaintext token...
    expect(row.tokenHash).toBe(hashReportToken(result.token));
    // ...and the raw token is NOT stored anywhere on the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(result.token);
  });
});

// ---------------------------------------------------------------------------
// loadReportByToken
// ---------------------------------------------------------------------------

describe("loadReportByToken", () => {
  it("returns live status with sections + echoed summary for a valid future-expiry report", async () => {
    const repo = new InMemoryReportsRepository();
    repo.setLoops([makeReportLoop({ id: "loop-1", status: "waiting_on_me" })]);

    const { token } = await createReport({
      userId: "user-1",
      kind: "waiting_on",
      scope: {},
      summary: "What you owe",
      requestedVia: "manual",
      repository: repo,
    });

    const loaded = await loadReportByToken({ token, now: new Date(), repository: repo });

    expect(loaded.status).toBe("live");
    if (loaded.status !== "live") return;
    expect(loaded.summary).toBe("What you owe");
    // assembleReport ran → sections present with the fixed section order.
    expect(loaded.sections.sections.length).toBeGreaterThan(0);
    const needsYou = loaded.sections.sections.find((s) => s.key === "needs_you");
    expect(needsYou?.rows.map((r) => r.loop.id)).toContain("loop-1");
  });

  it("returns not_found for a tampered token", async () => {
    const repo = new InMemoryReportsRepository();
    const { token } = await createReport({
      userId: "user-1",
      kind: "weekly",
      scope: {},
      summary: "x",
      requestedVia: "manual",
      repository: repo,
    });

    const last = token.at(-1);
    const flipped = token.slice(0, -1) + (last === "A" ? "B" : "A");

    const loaded = await loadReportByToken({ token: flipped, now: new Date(), repository: repo });
    expect(loaded.status).toBe("not_found");
  });

  it("returns expired for a report whose expiresAt is in the past", async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const repo = new InMemoryReportsRepository({ expiresAt: past });
    const { token } = await createReport({
      userId: "user-1",
      kind: "weekly",
      scope: {},
      summary: "x",
      requestedVia: "manual",
      repository: repo,
    });

    const loaded = await loadReportByToken({ token, now: new Date(), repository: repo });
    expect(loaded.status).toBe("expired");
  });

  it("LIVE-QUERY: a second load reflects mutations to the underlying loop set (no snapshot)", async () => {
    const repo = new InMemoryReportsRepository();
    repo.setLoops([makeReportLoop({ id: "loop-1", status: "waiting_on_me" })]);

    const { token } = await createReport({
      userId: "user-1",
      kind: "waiting_on",
      scope: {},
      summary: "live",
      requestedVia: "manual",
      repository: repo,
    });

    const first = await loadReportByToken({ token, now: new Date(), repository: repo });
    expect(first.status).toBe("live");
    if (first.status !== "live") return;
    const firstNeedsYou = first.sections.sections.find((s) => s.key === "needs_you");
    expect(firstNeedsYou?.rows.map((r) => r.loop.id)).toContain("loop-1");

    // Mutate the underlying loop set: mark the loop done (drops out of needs_you,
    // lands in recently_done). If the report snapshotted, the second load would be
    // identical to the first.
    repo.setLoops([
      makeReportLoop({ id: "loop-1", status: "done", updatedAt: new Date() }),
    ]);

    const second = await loadReportByToken({ token, now: new Date(), repository: repo });
    expect(second.status).toBe("live");
    if (second.status !== "live") return;
    const secondNeedsYou = second.sections.sections.find((s) => s.key === "needs_you");
    const recentlyDone = second.sections.sections.find((s) => s.key === "recently_done");
    expect(secondNeedsYou?.rows.map((r) => r.loop.id)).not.toContain("loop-1");
    expect(recentlyDone?.rows.map((r) => r.loop.id)).toContain("loop-1");
  });
});

// ---------------------------------------------------------------------------
// applyReportRowAction
// ---------------------------------------------------------------------------

describe("applyReportRowAction", () => {
  async function setup() {
    const reportsRepo = new InMemoryReportsRepository();
    reportsRepo.setLoops([makeReportLoop({ id: "loop-1", status: "open" })]);
    const loopRepo = new InMemoryLoopRepo();
    loopRepo.addLoop("loop-1", "user-1", "open");

    const { token } = await createReport({
      userId: "user-1",
      kind: "weekly",
      scope: {},
      summary: "x",
      requestedVia: "manual",
      repository: reportsRepo,
    });
    return { reportsRepo, loopRepo, token };
  }

  it("dismiss → mutateLoopState with source report_row_action, status dismissed, applied + refreshed sections", async () => {
    const { reportsRepo, loopRepo, token } = await setup();

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-1", action: "dismiss" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.sections.sections.length).toBeGreaterThan(0);

    // Loop fake recorded the funnel call with the report-row-action provenance.
    expect(loopRepo.mutations).toHaveLength(1);
    const m = loopRepo.mutations[0]!;
    expect(m.source).toBe("report_row_action");
    expect(m.status).toBe("dismissed");
    expect(m.commandText).toBe("dismiss");
    expect(loopRepo.statusOf("loop-1")).toBe("dismissed");
  });

  it("done → mark_done via the funnel", async () => {
    const { reportsRepo, loopRepo, token } = await setup();

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-1", action: "done" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("applied");
    expect(loopRepo.mutations[0]!.eventType).toBe("marked_done");
    expect(loopRepo.statusOf("loop-1")).toBe("done");
  });

  it("snooze without snoozeUntil → invalid", async () => {
    const { reportsRepo, loopRepo, token } = await setup();

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-1", action: "snooze" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.error).toContain("snoozeUntil");
    expect(loopRepo.mutations).toHaveLength(0);
  });

  it("snooze with valid snoozeUntil → applied, status snoozed", async () => {
    const { reportsRepo, loopRepo, token } = await setup();

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-1", action: "snooze", snoozeUntil: new Date(Date.now() + 86400000).toISOString() },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("applied");
    expect(loopRepo.statusOf("loop-1")).toBe("snoozed");
  });

  it("draft_nudge WITH enqueueDraftNudge → drafted and loop NOT mutated", async () => {
    const { reportsRepo, loopRepo, token } = await setup();
    const enqueued: Array<{ userId: string; loopId: string }> = [];

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-1", action: "draft_nudge" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
      enqueueDraftNudge: async (i) => {
        enqueued.push(i);
      },
    });

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") return;
    expect(result.sections.sections.length).toBeGreaterThan(0);
    expect(enqueued).toEqual([{ userId: "user-1", loopId: "loop-1" }]);
    // No loop state mutation.
    expect(loopRepo.mutations).toHaveLength(0);
    expect(loopRepo.statusOf("loop-1")).toBe("open");
  });

  it("draft_nudge WITHOUT enqueueDraftNudge → invalid", async () => {
    const { reportsRepo, loopRepo, token } = await setup();

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-1", action: "draft_nudge" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("invalid");
    expect(loopRepo.mutations).toHaveLength(0);
  });

  it("a loopId not owned by the report user → invalid", async () => {
    const { reportsRepo, loopRepo, token } = await setup();
    // loop-2 belongs to a different user.
    loopRepo.addLoop("loop-2", "other-user", "open");

    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: { loopId: "loop-2", action: "dismiss" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.error).toBe("loop not found");
  });

  it("bad token → not_found (no mutation)", async () => {
    const { reportsRepo, loopRepo } = await setup();

    const result = await applyReportRowAction({
      token: "not-a-real-token",
      now: new Date(),
      body: { loopId: "loop-1", action: "dismiss" },
      reportsRepository: reportsRepo,
      loopRepository: loopRepo,
    });

    expect(result.status).toBe("not_found");
    expect(loopRepo.mutations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// recordReportView
// ---------------------------------------------------------------------------

describe("recordReportView", () => {
  it("emits report.viewed when the repo bump returns true", async () => {
    const repo = new InMemoryReportsRepository();
    const { reportId } = await createReport({
      userId: "user-1",
      kind: "weekly",
      scope: {},
      summary: "x",
      requestedVia: "manual",
      repository: repo,
    });

    const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
    const now = new Date();

    await recordReportView({
      reportId,
      userId: "user-1",
      now,
      repository: repo,
      viewerKind: "anonymous_link",
      emit: async (e) => {
        emitted.push(e);
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.name).toBe("report.viewed");
    expect(emitted[0]!.data).toMatchObject({
      userId: "user-1",
      reportId,
      viewedAt: now.toISOString(),
      viewerKind: "anonymous_link",
    });
  });

  it("does not emit when the repo bump returns false (debounced)", async () => {
    const repo = new InMemoryReportsRepository();
    const { reportId } = await createReport({
      userId: "user-1",
      kind: "weekly",
      scope: {},
      summary: "x",
      requestedVia: "manual",
      repository: repo,
    });

    const emitted: unknown[] = [];
    const first = new Date();
    // First view bumps (and emits).
    await recordReportView({
      reportId,
      userId: "user-1",
      now: first,
      repository: repo,
      viewerKind: "clerk_session",
      emit: async (e) => {
        emitted.push(e);
      },
    });
    // Immediate second view is within the debounce window → no bump, no emit.
    await recordReportView({
      reportId,
      userId: "user-1",
      now: new Date(first.getTime() + 1000),
      repository: repo,
      viewerKind: "clerk_session",
      emit: async (e) => {
        emitted.push(e);
      },
    });

    expect(emitted).toHaveLength(1);
  });
});
