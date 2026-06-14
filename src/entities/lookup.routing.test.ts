/**
 * Unit tests for the entity-query → entityId routing integration (Phase 7 C2).
 *
 * Tests that when an entity insight command resolves via findEntityByQuery,
 * the emitted report.requested event carries scope.entityId, and that an
 * unresolved entity keeps the existing clarification behavior.
 *
 * Uses in-memory fakes only — no live DB, no Inngest.
 * Mirrors the style of src/workflows/functions/route-email.c4.test.ts.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
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
import type { EntityLookupResult } from "@/entities/lookup";

// ---------------------------------------------------------------------------
// Minimal in-memory store (mirrors route-email.c4.test.ts pattern)
// ---------------------------------------------------------------------------

class MinimalStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }
  async findLoopsByInboundEmailId(): Promise<PersistedLoop[]> { return []; }
  async persistExtractedLoops(input: { email: ProcessableInboundEmail; loops: LoopToPersist[]; normalizedBody: string }): Promise<PersistedLoop[]> {
    return input.loops.map((l) => ({
      id: `loop-${this.nextId++}`,
      userId: input.email.userId,
      emailThreadId: input.email.emailThreadId,
      inboundEmailId: input.email.id,
      sourceEvidenceId: `ev-${this.nextId++}`,
      status: l.status,
      summary: l.summary,
      sourceQuote: l.source.quote,
      confidence: l.confidence,
      nextCheckAt: l.nextCheckAt ? new Date(l.nextCheckAt) : null,
    }));
  }
  async createPrivateReplyNudge(input: { userId: string; inboundEmailId: string; subject: string; body: string; metadata: PrivateReplyNudgeMetadata }): Promise<PersistedNudge> {
    const nudge: PersistedNudge = { id: randomUUID(), userId: input.userId, inboundEmailId: input.inboundEmailId, body: input.body };
    this.nudges.set(nudge.id, { nudge, metadata: input.metadata });
    return nudge;
  }
  async createReplyNudge(input: { userId: string; inboundEmailId: string; subject: string; body: string; intent: string }): Promise<PersistedNudge> {
    const nudge: PersistedNudge = { id: randomUUID(), userId: input.userId, inboundEmailId: input.inboundEmailId, body: input.body };
    this.nudges.set(nudge.id, { nudge, metadata: { kind: "private_reply", intent: input.intent, loopCount: 0, lowConfidence: false, ordinalMap: {} } });
    return nudge;
  }
  async listCommandableLoops(): Promise<PersistedLoop[]> { throw new Error("not used"); }
  async updateLoopFromCommand(): Promise<PersistedLoop> { throw new Error("not used"); }
  async recordLoopCorrection(): Promise<void> {}
  async findUserTimezone(): Promise<string | null> { return null; }

  async findNudgeById(id: string): Promise<ResolvableNudge | null> {
    const e = this.nudges.get(id);
    return e ? { id: e.nudge.id, userId: e.nudge.userId, metadata: e.metadata } : null;
  }
  async findNudgeByOutboundInReplyTo(): Promise<ResolvableNudge | null> { return null; }
  async findLoopsByIds(): Promise<PersistedLoop[]> { return []; }
}

function makeEmail(id: string, body: string): ProcessableInboundEmail {
  return {
    id,
    userId: "user-c2",
    emailThreadId: "thread-c2",
    emailMessageId: `msg-${id}`,
    normalized: {
      ...normalizePostmarkInbound(directPostmarkFixture),
      textBody: body,
      strippedTextReply: body,
    },
  };
}

function makeDeps(
  store: MinimalStore,
  sent: string[],
  extra: Partial<RouterDeps> = {},
): RouterDeps {
  return {
    repository: store,
    replyTargetStore: store,
    sendReply: async (id) => { sent.push(id); },
    useModel: false,
    now: new Date("2026-06-14T12:00:00Z"),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("C2 — entity query resolves to entityId in report.requested", () => {
  it("sets scope.entityId when findEntityByQuery resolves the candidate", async () => {
    const store = new MinimalStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-resolve", "show Acme loops"));

    const resolved: EntityLookupResult = { id: "entity-acme-id", displayName: "Acme Corp", kind: "company" };

    const result = await routeEmail(
      "inbound-resolve",
      makeDeps(store, sent, {
        // participant list includes "Acme" so classifyInsightCommand resolves to entity kind
        listTrackedParticipants: async () => ["Acme Corp", "Maya Chen"],
        // inject the lookup port
        findEntityByQuery: async (_input) => resolved,
      }),
    );

    expect(result.branch).toBe("insight_command");
    expect(result.nudgeId).toBeNull();
    expect(sent).toEqual([]);

    const reportEvent = result.events.find((e) => e.name === "report.requested");
    expect(reportEvent).toBeDefined();
    expect(reportEvent!.data).toMatchObject({
      kind: "entity",
      scope: { entity: "Acme", entityId: "entity-acme-id" },
    });
  });

  it("omits scope.entityId (keeps existing behavior) when findEntityByQuery returns null", async () => {
    const store = new MinimalStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-noresolve", "show Acme loops"));

    const result = await routeEmail(
      "inbound-noresolve",
      makeDeps(store, sent, {
        listTrackedParticipants: async () => ["Acme Corp", "Maya Chen"],
        findEntityByQuery: async () => null,
      }),
    );

    expect(result.branch).toBe("insight_command");
    const reportEvent = result.events.find((e) => e.name === "report.requested");
    expect(reportEvent).toBeDefined();
    // entityId should NOT be present when lookup returns null
    const scope = (reportEvent!.data as Record<string, unknown>).scope as Record<string, unknown>;
    expect(scope).not.toHaveProperty("entityId");
    expect(scope).toMatchObject({ entity: "Acme" });
  });

  it("keeps the clarification reply when entity is unresolved by participant list (no findEntityByQuery port)", async () => {
    const store = new MinimalStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-unk", "show Zylo loops"));

    const result = await routeEmail(
      "inbound-unk",
      makeDeps(store, sent, {
        listTrackedParticipants: async () => ["Acme Corp", "Maya Chen"],
        // no findEntityByQuery port → falls through to existing unknown handling
      }),
    );

    expect(result.branch).toBe("insight_command");
    // Clarification nudge is sent; no report.requested
    expect(sent).toHaveLength(1);
    expect(result.events.map((e) => e.name)).not.toContain("report.requested");
  });

  it("does not inject entityId for non-entity insight kinds", async () => {
    const store = new MinimalStore();
    const sent: string[] = [];
    store.addEmail(makeEmail("inbound-insights", "what are my insights?"));

    const result = await routeEmail(
      "inbound-insights",
      makeDeps(store, sent, {
        findEntityByQuery: async () => ({ id: "should-not-appear", displayName: "X", kind: "person" }),
      }),
    );

    expect(result.branch).toBe("insight_command");
    const reportEvent = result.events.find((e) => e.name === "report.requested");
    expect(reportEvent).toBeDefined();
    expect(reportEvent!.data).toMatchObject({ kind: "insights" });
    const scope = (reportEvent!.data as Record<string, unknown>).scope as Record<string, unknown>;
    expect(scope).not.toHaveProperty("entityId");
  });
});
