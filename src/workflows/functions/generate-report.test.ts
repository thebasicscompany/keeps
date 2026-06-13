import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EmailSender, OutboundEmail, OutboundEmailStore } from "@/email/outbound";
import type { NudgeRepository } from "@/nudges/repository";
import type { ReportLoop, ReportLoopActivity } from "@/reports/query";
import type {
  InsertReportInput,
  InsertedReport,
  ReportsRepository,
  StoredReport,
} from "@/reports/repository";
import { generateReport, type GenerateReportPorts } from "./generate-report";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-13T12:00:00.000Z");

function makeLoop(overrides: Partial<ReportLoop> & { id: string }): ReportLoop {
  return {
    id: overrides.id,
    status: overrides.status ?? "open",
    summary: overrides.summary ?? `Summary ${overrides.id}`,
    ownerText: overrides.ownerText ?? null,
    requesterText: overrides.requesterText ?? null,
    dueAt: overrides.dueAt ?? null,
    confidence: overrides.confidence ?? 0.8,
    participants: overrides.participants ?? [],
    sourceQuote: overrides.sourceQuote ?? "quote",
    sourceEvidenceId: overrides.sourceEvidenceId ?? `ev-${overrides.id}`,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-06-01T00:00:00.000Z"),
  };
}

// Three loops designed to land in distinct sections so ordinal order is deterministic:
//  - L1: waiting_on_me                  → "needs_you" (first section)
//  - L2: open, due in 3 days            → "due_soon"
//  - L3: waiting_on_other               → "waiting_on_others"
// Top-3 across sections in order ⇒ [L1, L2, L3].
const LOOPS: ReportLoop[] = [
  makeLoop({ id: "L1", status: "waiting_on_me", summary: "Reply to Alice" }),
  makeLoop({
    id: "L2",
    status: "open",
    summary: "Finish the deck",
    dueAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
  }),
  makeLoop({ id: "L3", status: "waiting_on_other", summary: "Awaiting Bob's review" }),
];

const LOOP_ACTIVITY: ReportLoopActivity[] = LOOPS.map((l) => ({
  loopId: l.id,
  lastActivityAt: null,
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeReportsRepository implements ReportsRepository {
  inserted: InsertReportInput[] = [];

  async insertReport(input: InsertReportInput): Promise<InsertedReport> {
    this.inserted.push(input);
    return {
      id: `report-${this.inserted.length}`,
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: NOW,
    };
  }

  async findReportByTokenHash(): Promise<StoredReport | null> {
    return null;
  }

  async touchReportViewed(): Promise<boolean> {
    return false;
  }

  async loadLoopsForScope(): Promise<{
    loops: ReportLoop[];
    loopActivity: ReportLoopActivity[];
  }> {
    return { loops: LOOPS, loopActivity: LOOP_ACTIVITY };
  }
}

type CreatedNudge = {
  userId: string;
  loopId: string | null;
  inboundEmailId: string | null;
  subject: string;
  body: string;
  type: string;
  metadata: Record<string, unknown>;
};

class FakeNudgeRepository implements NudgeRepository {
  created: CreatedNudge[] = [];
  audits: { action: string; metadata: Record<string, unknown> }[] = [];

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
    action: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    this.audits.push({ action: input.action, metadata: input.metadata });
  }

  async writeLoopEvent(): Promise<void> {}

  // Unused by generate-report — satisfy the port.
  async findNudgeCandidates(): Promise<never[]> {
    return [];
  }
  async countNudgesSentSince(): Promise<number> {
    return 0;
  }
  async markLoopNudged(): Promise<void> {}
  async deferLoopNextCheck(): Promise<void> {}
  async findCandidateById(): Promise<null> {
    return null;
  }
  async findUserEmail(): Promise<string | null> {
    return null;
  }

  async findLatestNudgeByRunId(_runId: string): Promise<{ id: string; userId: string } | null> {
    return null;
  }

  async findNudgeStatus(_nudgeId: string): Promise<string | null> {
    return null;
  }

  async markNudgeFailed(_input: { nudgeId: string; extraMetadata: Record<string, unknown> }): Promise<void> {}
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

function makePorts(ownerEmail: string | null = "owner@example.com"): {
  ports: GenerateReportPorts;
  reportsRepository: FakeReportsRepository;
  nudgeRepository: FakeNudgeRepository;
  sender: FakeEmailSender;
  store: FakeOutboundEmailStore;
} {
  const reportsRepository = new FakeReportsRepository();
  const nudgeRepository = new FakeNudgeRepository();
  const sender = new FakeEmailSender();
  const store = new FakeOutboundEmailStore();
  return {
    ports: {
      reportsRepository,
      nudgeRepository,
      sender,
      store,
      loadOwnerEmail: async () => ownerEmail,
    },
    reportsRepository,
    nudgeRepository,
    sender,
    store,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const APP_BASE_URL = "https://keeps.email";

describe("generateReport (pure core)", () => {
  it("persists one report, creates one nudge, and sends one email to the owner", async () => {
    const { ports, reportsRepository, nudgeRepository, sender } = makePorts();

    const result = await generateReport({
      userId: "user-1",
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      inboundEmailId: "inbound-1",
      now: NOW,
      useModel: false,
      appBaseUrl: APP_BASE_URL,
      replyToBase: "agent@keeps.ai",
      ports,
    });

    expect(reportsRepository.inserted).toHaveLength(1);
    expect(nudgeRepository.created).toHaveLength(1);
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0].to).toBe("owner@example.com");

    // Persisted summary is the model headline (frozen intent).
    expect(reportsRepository.inserted[0].summary).toBe(result.summaryHeadline);
  });

  it("embeds the /r/<token> link and the commandable footer in the email body", async () => {
    const { ports, sender } = makePorts();

    await generateReport({
      userId: "user-1",
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      now: NOW,
      useModel: false,
      appBaseUrl: APP_BASE_URL,
      ports,
    });

    const body = sender.sends[0].textBody;
    expect(body).toContain(`${APP_BASE_URL}/r/`);
    expect(body).toContain("Private view:");
    expect(body).toContain("Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.");
  });

  it("maps ordinalMap 1..N to the top loop ids in section/importance order", async () => {
    const { ports, nudgeRepository } = makePorts();

    await generateReport({
      userId: "user-1",
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      now: NOW,
      useModel: false,
      appBaseUrl: APP_BASE_URL,
      ports,
    });

    const metadata = nudgeRepository.created[0].metadata as {
      kind: string;
      ordinalMap: Record<number, string>;
      ordinalCount: number;
    };

    // ordinalMap lives at TOP LEVEL (resolve-reply-target.ts reads record.ordinalMap).
    expect(metadata.kind).toBe("report");
    expect(metadata.ordinalMap[1]).toBe("L1"); // first top row: needs_you
    expect(metadata.ordinalMap[2]).toBe("L2"); // due_soon
    expect(metadata.ordinalMap[3]).toBe("L3"); // waiting_on_others
    expect(metadata.ordinalCount).toBe(3);
  });

  it("uses the deterministic summary when useModel is false; subject matches the kind", async () => {
    const { ports, reportsRepository, sender } = makePorts();

    const result = await generateReport({
      userId: "user-1",
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      now: NOW,
      useModel: false,
      appBaseUrl: APP_BASE_URL,
      ports,
    });

    // totalOpen across the 3 fixture loops = 3.
    expect(result.summaryHeadline).toBe("You have 3 open loops.");
    expect(reportsRepository.inserted[0].summary).toBe("You have 3 open loops.");
    expect(sender.sends[0].subject).toBe("Your Keeps insights");
  });

  it("returns tokenHash equal to the sha256 of the token embedded in the link", async () => {
    const { ports, sender } = makePorts();

    const result = await generateReport({
      userId: "user-1",
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      now: NOW,
      useModel: false,
      appBaseUrl: APP_BASE_URL,
      ports,
    });

    // Recover the token from the link in the email body.
    const body = sender.sends[0].textBody;
    const match = body.match(/\/r\/([A-Za-z0-9_-]+)/);
    expect(match).not.toBeNull();
    const token = match![1];

    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(result.tokenHash).toBe(expectedHash);
  });

  it("skips the send (no throw) when the owner has no email, but still persists the report", async () => {
    const { ports, reportsRepository, nudgeRepository, sender, store } = makePorts(null);

    const result = await generateReport({
      userId: "user-1",
      kind: "insights",
      scope: {},
      requestedVia: "email_command",
      now: NOW,
      useModel: false,
      appBaseUrl: APP_BASE_URL,
      ports,
    });

    expect(reportsRepository.inserted).toHaveLength(1);
    expect(nudgeRepository.created).toHaveLength(1);
    expect(sender.sends).toHaveLength(0);
    expect(store.recorded).toHaveLength(0);
    expect(result.reportId).toBe("report-1");
  });
});
