/**
 * Tests for parse-connector-command.ts
 *
 * All tests use the deterministic path (useModel: false) — no network, no
 * OPENAI_API_KEY required.
 *
 * The model path is exercised with top-level vi.mock stubs for the "ai" package
 * and "@/agent/model" so that generateObject is replaced and no real network
 * call is made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted automatically by Vitest before any imports).
// The factory must not reference variables declared below this block.
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("@/agent/model", () => ({
  getKeepsLanguageModel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are registered.
// ---------------------------------------------------------------------------

import {
  parseConnectorCommand,
  parseConnectorCommandDeterministically,
  type ParseConnectorCommandInput,
} from "@/agent/parse-connector-command";
import { connectorCommandDraftSchema } from "@/agent/schemas";
import { generateObject } from "ai";
import { getKeepsLanguageModel } from "@/agent/model";

// ---------------------------------------------------------------------------
// Stable reference date used across tests
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-13T12:00:00.000Z");

function input(emailBody: string, extra?: Partial<ParseConnectorCommandInput>): ParseConnectorCommandInput {
  return { emailBody, now: NOW, timezone: "UTC", ...extra };
}

// ---------------------------------------------------------------------------
// Deterministic path — Slack commands
// ---------------------------------------------------------------------------

describe("parseConnectorCommandDeterministically — @Slack", () => {
  it("canonical fixture: @Slack tell Maya I'll send the deck Friday", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack tell Maya I'll send the deck Friday"),
    );

    expect(result.provider).toBe("slack");
    expect(result.kind).toBe("slack_dm");
    expect(result.destination.kind).toBe("person");
    expect(result.destination.nameText).toBe("Maya");
    expect(result.destination.emailText).toBeNull();
    expect(result.message).toBe("I'll send the deck Friday");
    expect(result.ambiguity).toEqual([]);
    // Schema validation
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
  });

  it("case-insensitive prefix: @slack tell Maya ...", () => {
    const result = parseConnectorCommandDeterministically(
      input("@slack tell Maya check in tomorrow"),
    );
    expect(result.provider).toBe("slack");
    expect(result.kind).toBe("slack_dm");
    expect(result.destination.nameText).toBe("Maya");
    expect(result.message).toBe("check in tomorrow");
  });

  it("ping verb: @Slack ping Alex let's sync", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack ping Alex let's sync"),
    );
    expect(result.destination.nameText).toBe("Alex");
    expect(result.message).toBe("let's sync");
    expect(result.ambiguity).toEqual([]);
  });

  it("dm verb: @Slack dm Jordan the proposal is ready", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack dm Jordan the proposal is ready"),
    );
    expect(result.destination.nameText).toBe("Jordan");
    expect(result.message).toBe("the proposal is ready");
    expect(result.ambiguity).toEqual([]);
  });

  it("message verb: @Slack message Sam about the timeline", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack message Sam about the timeline"),
    );
    expect(result.destination.nameText).toBe("Sam");
    expect(result.message).toBe("about the timeline");
    expect(result.ambiguity).toEqual([]);
  });

  it("bare name-colon form: @Slack Maya: I'll send the deck Friday", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack Maya: I'll send the deck Friday"),
    );
    expect(result.destination.kind).toBe("person");
    expect(result.destination.nameText).toBe("Maya");
    expect(result.message).toBe("I'll send the deck Friday");
    expect(result.ambiguity).toEqual([]);
  });

  it("self-recipient: @Slack tell me the summary", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack tell me the summary"),
    );
    expect(result.destination.kind).toBe("self");
    expect(result.destination.nameText).toBeNull();
    expect(result.destination.emailText).toBeNull();
    expect(result.message).toBe("the summary");
  });

  it("inline email address: @Slack tell maya@example.com I'll send the deck", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack tell maya@example.com I'll send the deck"),
    );
    expect(result.destination.kind).toBe("person");
    expect(result.destination.emailText).toBe("maya@example.com");
    expect(result.message).toBe("I'll send the deck");
  });

  it("angle-bracket email: @Slack tell Maya <maya@x.com> I'll send the deck", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack tell Maya <maya@x.com> I'll send the deck"),
    );
    expect(result.destination.nameText).toBe("Maya");
    expect(result.destination.emailText).toBe("maya@x.com");
    expect(result.message).toBe("I'll send the deck");
  });

  it("multi-line body: continuation lines fold into message", () => {
    const body = "@Slack tell Maya\nI'll send the deck Friday";
    const result = parseConnectorCommandDeterministically(input(body));
    expect(result.destination.nameText).toBe("Maya");
    // Continuation should be included in message
    expect(result.message).toContain("I'll send the deck Friday");
  });

  it("ambiguity: missing message after recipient", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Slack tell Maya"),
    );
    expect(result.ambiguity).toContain("missing_message");
  });

  it("ambiguity: missing recipient (bare @Slack with no parseable structure)", () => {
    const result = parseConnectorCommandDeterministically(input("@Slack"));
    expect(result.ambiguity).toContain("missing_message");
    expect(result.ambiguity).toContain("recipient_unclear");
  });

  it("output is always schema-valid", () => {
    const cases = [
      "@Slack tell Maya I'll send the deck Friday",
      "@slack ping Alex",
      "@Slack",
      "@Slack Maya: hi there",
      "@Slack tell myself the update",
    ];
    for (const body of cases) {
      const result = parseConnectorCommandDeterministically(input(body));
      expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic path — Calendar commands
// ---------------------------------------------------------------------------

describe("parseConnectorCommandDeterministically — @Calendar", () => {
  it("canonical fixture: @Calendar remind me before the renewal call", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Calendar remind me before the renewal call"),
    );

    expect(result.provider).toBe("google_calendar");
    expect(result.kind).toBe("calendar_event");
    expect(result.destination.kind).toBe("self");
    expect(result.destination.nameText).toBeNull();
    expect(result.destination.emailText).toBeNull();
    expect(result.eventTitle).toBeTruthy();
    // "the renewal call" should be surfaced as the title (possibly capitalized)
    expect(result.eventTitle!.toLowerCase()).toContain("renewal call");
    expect(result.message).toBeNull();
    expect(result.whenAt).toBeNull(); // deterministic path never resolves dates
    expect(result.ambiguity).toEqual([]);
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
  });

  it("case-insensitive: @calendar remind me before the quarterly review", () => {
    const result = parseConnectorCommandDeterministically(
      input("@calendar remind me before the quarterly review"),
    );
    expect(result.provider).toBe("google_calendar");
    expect(result.eventTitle!.toLowerCase()).toContain("quarterly review");
  });

  it("reminds with trailing day: @Calendar remind me before the renewal call Friday", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Calendar remind me before the renewal call Friday"),
    );
    expect(result.whenText).toBe("Friday");
    expect(result.eventTitle!.toLowerCase()).toContain("renewal call");
    // whenAt stays null in deterministic path
    expect(result.whenAt).toBeNull();
  });

  it("schedule form: @Calendar schedule the team standup tomorrow at 9am", () => {
    const result = parseConnectorCommandDeterministically(
      input("@Calendar schedule the team standup tomorrow at 9am"),
    );
    expect(result.provider).toBe("google_calendar");
    expect(result.eventTitle!.toLowerCase()).toContain("team standup");
    expect(result.whenText).toContain("tomorrow");
  });

  it("empty calendar command returns ambiguity", () => {
    const result = parseConnectorCommandDeterministically(input("@Calendar"));
    expect(result.provider).toBe("google_calendar");
    expect(result.ambiguity).toContain("missing_when");
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
  });

  it("output is always schema-valid for calendar commands", () => {
    const cases = [
      "@Calendar remind me before the renewal call",
      "@Calendar",
      "@calendar add the team lunch tomorrow",
      "@Calendar set a reminder for the board meeting Friday",
    ];
    for (const body of cases) {
      const result = parseConnectorCommandDeterministically(input(body));
      expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// parseConnectorCommand (async wrapper) — deterministic path
// ---------------------------------------------------------------------------

describe("parseConnectorCommand (async) — deterministic path", () => {
  // Ensure model is stubbed to null so useModel: false is fully deterministic.
  beforeEach(() => {
    vi.mocked(getKeepsLanguageModel).mockReturnValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns the same result as the sync helper with useModel: false", async () => {
    const emailBody = "@Slack tell Maya I'll send the deck Friday";
    const sync = parseConnectorCommandDeterministically(input(emailBody));
    const async_ = await parseConnectorCommand(input(emailBody), { useModel: false });

    expect(async_).toEqual(sync);
  });

  it("returns a schema-valid draft for @Calendar", async () => {
    const result = await parseConnectorCommand(
      input("@Calendar remind me before the renewal call"),
      { useModel: false },
    );
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
    expect(result.provider).toBe("google_calendar");
  });

  it("unknown prefix returns draft with ambiguity, not a throw", async () => {
    const result = await parseConnectorCommand(
      input("Hey, can you slack Maya?"),
      { useModel: false },
    );
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
    expect(result.ambiguity.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Model path — stubbed generateObject
// ---------------------------------------------------------------------------

describe("parseConnectorCommand — model path (stubbed)", () => {
  // Canned stub return value — inlined so no hoisting issues.
  const STUB_DRAFT = {
    provider: "slack" as const,
    kind: "slack_dm" as const,
    destination: { kind: "person" as const, nameText: "Maya", emailText: null },
    message: "I'll send the deck Friday",
    eventTitle: null,
    whenText: null,
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity: [] as string[],
  };

  beforeEach(() => {
    // Return a non-null model so the model branch is entered.
    vi.mocked(getKeepsLanguageModel).mockReturnValue({ id: "stub-model" } as unknown as ReturnType<typeof getKeepsLanguageModel>);
    // generateObject resolves with our canned draft.
    vi.mocked(generateObject).mockResolvedValue({ object: STUB_DRAFT } as Awaited<ReturnType<typeof generateObject>>);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("calls generateObject and returns a schema-valid draft", async () => {
    const result = await parseConnectorCommand(
      input("@Slack tell Maya I'll send the deck Friday"),
      { useModel: true },
    );

    expect(vi.mocked(generateObject)).toHaveBeenCalledOnce();
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
    expect(result.provider).toBe("slack");
    expect(result.destination.nameText).toBe("Maya");
    expect(result.message).toBe("I'll send the deck Friday");
  });

  it("falls back to deterministic path when model returns null (no API key)", async () => {
    // Override: no model available.
    vi.mocked(getKeepsLanguageModel).mockReturnValue(null);

    const result = await parseConnectorCommand(
      input("@Slack tell Maya I'll send the deck Friday"),
      { useModel: true },
    );

    // generateObject was NOT called (model was null).
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    // Deterministic fallback still returns a valid draft.
    expect(() => connectorCommandDraftSchema.parse(result)).not.toThrow();
    expect(result.provider).toBe("slack");
    expect(result.destination.nameText).toBe("Maya");
  });

  it("passes now and timezone to the generateObject system prompt", async () => {
    const tz = "America/New_York";
    await parseConnectorCommand(
      input("@Slack tell Maya check in", { timezone: tz }),
      { useModel: true },
    );

    const call = vi.mocked(generateObject).mock.calls[0];
    // The system prompt must mention the timezone and the reference ISO timestamp.
    const systemArg = (call?.[0] as { system?: string })?.system ?? "";
    expect(systemArg).toContain("2026-06-13T12:00:00.000Z");
    expect(systemArg).toContain("America/New_York");
  });
});
