import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorCommandDraft } from "@/agent/schemas";
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

// ---------------------------------------------------------------------------
// Minimal in-memory store shared across test helpers
// ---------------------------------------------------------------------------

class InMemoryConnectorStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  private nextId = 1;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  // --- LoopProcessingRepository ---
  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }
  async findLoopsByInboundEmailId(): Promise<PersistedLoop[]> {
    return [];
  }
  async persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    return [];
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
    return [];
  }
  async updateLoopFromCommand(): Promise<PersistedLoop> {
    throw new Error("not expected in connector tests");
  }
  async recordLoopCorrection(): Promise<void> {}
  async findUserTimezone(): Promise<string | null> {
    return null;
  }

  // --- ReplyTargetStore ---
  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata } : null;
  }
  async findNudgeByOutboundInReplyTo(): Promise<ResolvableNudge | null> {
    return null;
  }
  async findLoopsByIds(): Promise<PersistedLoop[]> {
    return [];
  }

  private storeNudge(
    userId: string,
    inboundEmailId: string,
    body: string,
    metadata: PrivateReplyNudgeMetadata,
  ): PersistedNudge {
    const nudge: PersistedNudge = { id: `nudge-${this.nextId++}`, userId, inboundEmailId, body };
    this.nudges.set(nudge.id, { nudge, metadata });
    return nudge;
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

function makeSlackDraft(overrides: Partial<ConnectorCommandDraft> = {}): ConnectorCommandDraft {
  return {
    provider: "slack",
    kind: "slack_dm",
    destination: { kind: "person", nameText: "Maya", emailText: null },
    message: "I'll send the deck Friday",
    eventTitle: null,
    whenText: null,
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity: [],
    ...overrides,
  };
}

function makeCalendarDraft(overrides: Partial<ConnectorCommandDraft> = {}): ConnectorCommandDraft {
  return {
    provider: "google_calendar",
    kind: "calendar_event",
    destination: { kind: "self", nameText: null, emailText: null },
    message: null,
    eventTitle: "Reminder before renewal call",
    whenText: "before the renewal call",
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: 15,
    linkedLoopId: null,
    ambiguity: [],
    ...overrides,
  };
}

function makeDeps(
  store: InMemoryConnectorStore,
  sent: string[],
  extra: Partial<RouterDeps> = {},
): RouterDeps {
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
// Tests
// ---------------------------------------------------------------------------

describe("routeEmail — connector_command branch", () => {
  it('"@Slack tell Maya I\'ll send the deck Friday" classifies as connector_command, invokes parser, emits connector.action_requested and email.classified with branch connector_command, no reply nudge', async () => {
    const store = new InMemoryConnectorStore();
    const sent: string[] = [];
    store.addEmail(
      makeEmail("inbound-slack", {
        textBody: "@Slack tell Maya I'll send the deck Friday",
        strippedTextReply: "@Slack tell Maya I'll send the deck Friday",
      }),
    );

    const parsedDraft = makeSlackDraft();
    const fakeParser = vi.fn().mockResolvedValue(parsedDraft);

    const result = await routeEmail(
      "inbound-slack",
      makeDeps(store, sent, { parseConnectorCommand: fakeParser }),
    );

    // Branch and status
    expect(result.status).toBe("processed");
    expect(result.intent).toBe("command");
    expect(result.branch).toBe("connector_command");

    // Parser was called exactly once (no model call path exercised here)
    expect(fakeParser).toHaveBeenCalledOnce();
    expect(fakeParser).toHaveBeenCalledWith(
      expect.objectContaining({ emailBody: "@Slack tell Maya I'll send the deck Friday" }),
      { useModel: false },
    );

    // No reply nudge — downstream connector workflow owns user-facing replies
    expect(result.nudgeId).toBeNull();
    expect(sent).toHaveLength(0);

    // Events: email.classified first, then connector.action_requested
    expect(result.events).toHaveLength(2);

    const classifiedEvent = result.events.find((e) => e.name === "email.classified");
    expect(classifiedEvent).toBeDefined();
    expect(classifiedEvent?.data).toMatchObject({
      intent: "command",
      branch: "connector_command",
      inboundEmailId: "inbound-slack",
      userId: "user-1",
    });

    const actionEvent = result.events.find((e) => e.name === "connector.action_requested");
    expect(actionEvent).toBeDefined();
    expect(actionEvent?.data).toMatchObject({
      userId: "user-1",
      inboundEmailId: "inbound-slack",
      emailThreadId: "thread-1",
      provider: "slack",
      kind: "slack_dm",
    });
    // The full parsed command travels inline in the event
    expect((actionEvent?.data as { command: ConnectorCommandDraft }).command).toEqual(parsedDraft);
  });

  it('"@calendar remind me before the renewal call" (lowercase) classifies as connector_command with provider google_calendar', async () => {
    const store = new InMemoryConnectorStore();
    const sent: string[] = [];
    store.addEmail(
      makeEmail("inbound-cal", {
        textBody: "@calendar remind me before the renewal call",
        strippedTextReply: "@calendar remind me before the renewal call",
      }),
    );

    const parsedDraft = makeCalendarDraft();
    const fakeParser = vi.fn().mockResolvedValue(parsedDraft);

    const result = await routeEmail(
      "inbound-cal",
      makeDeps(store, sent, { parseConnectorCommand: fakeParser }),
    );

    expect(result.status).toBe("processed");
    expect(result.branch).toBe("connector_command");
    expect(result.nudgeId).toBeNull();
    expect(sent).toHaveLength(0);

    const actionEvent = result.events.find((e) => e.name === "connector.action_requested");
    expect(actionEvent).toBeDefined();
    expect(actionEvent?.data).toMatchObject({
      provider: "google_calendar",
      kind: "calendar_event",
    });
    expect((actionEvent?.data as { command: ConnectorCommandDraft }).command).toEqual(parsedDraft);
  });

  it("mid-text @slack mention (not first line) does NOT trigger the connector branch", async () => {
    const store = new InMemoryConnectorStore();
    const sent: string[] = [];
    // This body has a trailing "?" and no request phrase → classifies as question, not connector
    store.addEmail(
      makeEmail("inbound-midtext", {
        textBody: "Hey, can you @slack ping Maya about Friday?",
        strippedTextReply: "Hey, can you @slack ping Maya about Friday?",
      }),
    );

    const fakeParser = vi.fn();

    const result = await routeEmail(
      "inbound-midtext",
      makeDeps(store, sent, { parseConnectorCommand: fakeParser }),
    );

    // Parser must NOT have been called — this is a question/capture, not a connector command
    expect(fakeParser).not.toHaveBeenCalled();
    expect(result.branch).not.toBe("connector_command");
    // The nudge is sent (question/capture branch sends a stub reply)
    expect(result.nudgeId).not.toBeNull();
  });

  it("missing parseConnectorCommand dep → polite stub reply, no connector.action_requested event", async () => {
    const store = new InMemoryConnectorStore();
    const sent: string[] = [];
    store.addEmail(
      makeEmail("inbound-slack-nodep", {
        textBody: "@Slack tell Sam the report is ready",
        strippedTextReply: "@Slack tell Sam the report is ready",
      }),
    );

    // Deps WITHOUT parseConnectorCommand — simulates pre-B3 callers
    const result = await routeEmail("inbound-slack-nodep", makeDeps(store, sent));

    expect(result.status).toBe("processed");
    expect(result.branch).toBe("connector_command");

    // A polite stub nudge is sent
    expect(result.nudgeId).not.toBeNull();
    expect(sent).toHaveLength(1);
    const nudge = store.nudges.get(result.nudgeId as string);
    expect(nudge?.nudge.body).toBe("Connector commands land soon.");

    // No connector.action_requested event
    const hasActionEvent = result.events.some((e) => e.name === "connector.action_requested");
    expect(hasActionEvent).toBe(false);

    // email.classified IS still emitted
    const hasClassified = result.events.some((e) => e.name === "email.classified");
    expect(hasClassified).toBe(true);
  });
});
