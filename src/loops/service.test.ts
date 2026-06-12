import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import { forwardLikePostmarkFixture } from "@/email/fixtures/postmark";
import {
  applyLoopReplyCommand,
  processInboundEmailForLoops,
  type LoopProcessingRepository,
  type LoopToPersist,
  type PersistedLoop,
  type PersistedNudge,
  type ProcessableInboundEmail,
} from "@/loops/service";
import { parseLoopReplyCommand } from "@/loops/commands";

describe("processInboundEmailForLoops", () => {
  it("persists extracted loops with source evidence and emits phase 2 events", async () => {
    const repository = new InMemoryLoopProcessingRepository();
    repository.addEmail({
      id: "inbound-1",
      userId: "user-1",
      emailThreadId: "thread-1",
      emailMessageId: "message-1",
      normalized: normalizePostmarkInbound(forwardLikePostmarkFixture),
    });

    const result = await processInboundEmailForLoops({
      inboundEmailId: "inbound-1",
      repository,
    });

    if (result.status !== "processed") {
      throw new Error("expected processed result");
    }

    expect(result.loops.map((loop) => loop.summary)).toEqual(
      expect.arrayContaining(["Send the renewal packet.", "Confirm the discount cap."]),
    );
    expect(result.loops.every((loop) => loop.sourceEvidenceId.startsWith("evidence-"))).toBe(true);
    expect(result.privateReply).toContain("I found");
    expect(result.events.map((event) => event.name)).toEqual([
      "email.classified",
      "loops.extracted",
      ...result.loops.map(() => "loop.created"),
    ]);
  });

  it("stores a low-confidence candidate and asks a clarification question", async () => {
    const repository = new InMemoryLoopProcessingRepository();
    repository.addEmail({
      id: "inbound-low",
      userId: "user-1",
      emailThreadId: "thread-low",
      emailMessageId: "message-low",
      normalized: lowConfidenceEmail,
    });

    const result = await processInboundEmailForLoops({
      inboundEmailId: "inbound-low",
      repository,
    });

    if (result.status !== "processed") {
      throw new Error("expected processed result");
    }

    expect(result.loops).toHaveLength(1);
    expect(result.loops[0]?.status).toBe("candidate");
    expect(result.privateReply).toContain("I may be reading this wrong");
  });
});

describe("reply command handling", () => {
  it("parses correct and confirm commands", () => {
    expect(parseLoopReplyCommand("correct: Maya owns this")).toMatchObject({
      type: "correction",
      correctionText: "Maya owns this",
    });
    expect(parseLoopReplyCommand("confirm")).toMatchObject({
      type: "confirm",
    });
  });

  it("dismisses, snoozes, and marks loops done", async () => {
    const repository = new InMemoryLoopProcessingRepository();
    const loopOne = repository.addLoop({
      id: "loop-1",
      userId: "user-1",
      emailThreadId: "thread-1",
      status: "open",
      summary: "Send the renewal packet.",
    });
    const loopTwo = repository.addLoop({
      id: "loop-2",
      userId: "user-1",
      emailThreadId: "thread-1",
      status: "open",
      summary: "Confirm discount cap.",
    });

    const dismiss = await applyLoopReplyCommand({
      userId: "user-1",
      emailThreadId: "thread-1",
      text: "dismiss 1",
      repository,
    });

    expect(dismiss.updatedLoops).toHaveLength(1);
    expect(repository.getLoop(loopOne.id)?.status).toBe("dismissed");

    const snooze = await applyLoopReplyCommand({
      userId: "user-1",
      emailThreadId: "thread-1",
      text: "remind me Thursday",
      repository,
      now: new Date("2026-06-12T09:00:00.000Z"),
    });

    expect(snooze.updatedLoops).toHaveLength(1);
    expect(repository.getLoop(loopTwo.id)?.status).toBe("snoozed");
    expect(repository.getLoop(loopTwo.id)?.nextCheckAt?.toISOString()).toBe("2026-06-18T09:00:00.000Z");

    repository.addLoop({
      id: "loop-3",
      userId: "user-1",
      emailThreadId: "thread-1",
      status: "open",
      summary: "Review the margin.",
    });

    const done = await applyLoopReplyCommand({
      userId: "user-1",
      emailThreadId: "thread-1",
      text: "mark 2 done",
      repository,
    });

    expect(done.updatedLoops).toHaveLength(1);
    expect(repository.getLoop("loop-3")?.status).toBe("done");
    expect(done.events).toMatchObject([
      {
        name: "loop.updated",
        data: {
          loopId: "loop-3",
          status: "done",
        },
      },
    ]);
  });
});

const lowConfidenceEmail: NormalizedEmail = {
  provider: "fixture",
  providerMessageId: "fixture-low-confidence-001",
  mailboxHash: null,
  from: {
    email: "arav@example.com",
    name: "Arav",
  },
  to: [
    {
      email: "agent@keeps.ai",
      name: "Keeps",
    },
  ],
  cc: [],
  subject: "Keep this from slipping",
  textBody: "Can you keep this from slipping?",
  htmlBody: null,
  strippedTextReply: null,
  headers: {},
  attachmentCount: 0,
  attachments: [],
  receivedAt: "2026-06-12T09:00:00.000Z",
};

class InMemoryLoopProcessingRepository implements LoopProcessingRepository {
  private readonly emails = new Map<string, ProcessableInboundEmail>();
  private readonly loops = new Map<string, PersistedLoop>();
  private readonly nudges = new Map<string, PersistedNudge>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  addLoop(input: {
    id?: string;
    userId: string;
    emailThreadId: string;
    status: LoopStatus;
    summary: string;
  }): PersistedLoop {
    const id = input.id ?? this.allocateId("loop");
    const loop: PersistedLoop = {
      id,
      userId: input.userId,
      emailThreadId: input.emailThreadId,
      inboundEmailId: "inbound-command",
      sourceEvidenceId: this.allocateId("evidence"),
      status: input.status,
      summary: input.summary,
      sourceQuote: input.summary,
      confidence: 0.9,
      nextCheckAt: null,
    };

    this.loops.set(id, loop);
    return loop;
  }

  getLoop(loopId: string): PersistedLoop | undefined {
    return this.loops.get(loopId);
  }

  async findInboundEmailById(inboundEmailId: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(inboundEmailId) ?? null;
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
    metadata: Record<string, unknown>;
  }): Promise<PersistedNudge> {
    const nudge: PersistedNudge = {
      id: this.allocateId("nudge"),
      userId: input.userId,
      inboundEmailId: input.inboundEmailId,
      body: input.body,
    };

    this.nudges.set(nudge.id, nudge);
    return nudge;
  }

  async listCommandableLoops(input: { userId: string; emailThreadId?: string | null }): Promise<PersistedLoop[]> {
    return [...this.loops.values()].filter((loop) => {
      const statusMatches = ["candidate", "open", "snoozed", "waiting_on_me", "waiting_on_other"].includes(loop.status);
      const userMatches = loop.userId === input.userId;
      const threadMatches = input.emailThreadId ? loop.emailThreadId === input.emailThreadId : true;

      return statusMatches && userMatches && threadMatches;
    });
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

    if (!existing || existing.userId !== input.userId) {
      throw new Error(`Missing loop ${input.loopId}`);
    }

    const updated: PersistedLoop = {
      ...existing,
      status: input.status,
      nextCheckAt: input.nextCheckAt ?? existing.nextCheckAt,
    };

    this.loops.set(updated.id, updated);
    return updated;
  }

  private allocateId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }
}
