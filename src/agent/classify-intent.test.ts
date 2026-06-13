import { describe, expect, it } from "vitest";
import {
  classifyEmailIntent,
  classifyInsightCommand,
  detectInsightCommand,
  type EmailIntent,
} from "@/agent/classify-intent";

// ---------------------------------------------------------------------------
// Connector-command pre-rule (Phase 4 B4)
// ---------------------------------------------------------------------------

describe("classifyEmailIntent — connector-command pre-rule", () => {
  it("@Slack on the first line classifies as command/connector_command (uppercase)", () => {
    const result = classifyEmailIntent({ body: "@Slack tell Maya I'll send the deck Friday" });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.basis).toBe("rule");
    expect(result.matchedRule).toBe("connector-command");
    expect(result.subtype).toBe("connector_command");
  });

  it("@Calendar on the first line classifies as command/connector_command (lowercase)", () => {
    const result = classifyEmailIntent({ body: "@calendar remind me before the renewal call" });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.basis).toBe("rule");
    expect(result.matchedRule).toBe("connector-command");
    expect(result.subtype).toBe("connector_command");
  });

  it("@SLACK (mixed case) on the first line matches", () => {
    const result = classifyEmailIntent({ body: "@SLACK ping Maya" });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.subtype).toBe("connector_command");
  });

  it("leading whitespace before @Slack on the first line matches", () => {
    const result = classifyEmailIntent({ body: "  @Slack tell Alex about the deadline" });
    expect(result.subtype).toBe("connector_command");
  });

  it("@Slack mention NOT on the first line does NOT trigger the connector branch", () => {
    // Mid-text / non-first-line mentions fall through to existing rules in V0.
    // Contains a request phrase ("can you") so the question rule does NOT fire;
    // it falls through to capture-default.
    const result = classifyEmailIntent({ body: "Hey, can you @slack ping Maya about Friday?" });
    expect(result.subtype).toBeUndefined();
    expect(result.intent).toBe<EmailIntent>("capture");
  });

  it("@Slack on the SECOND line (after a blank first line) is treated as first non-empty line", () => {
    // blank first line → @Slack is the first non-empty line → matches
    const result = classifyEmailIntent({ body: "\n@Slack tell Sam the report is ready" });
    expect(result.subtype).toBe("connector_command");
  });

  it("connector-command rule wins over approve prefix when @Slack is on line 1", () => {
    // Even if body somehow starts with @Slack and contains "approve", the connector
    // rule fires first because it is checked before all other rules.
    const result = classifyEmailIntent({ body: "@Slack approve the draft" });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.subtype).toBe("connector_command");
  });

  it("'approve' still classifies as approval when no @connector prefix is present", () => {
    const result = classifyEmailIntent({ body: "approve the slack message" });
    expect(result.intent).toBe<EmailIntent>("approval");
    expect(result.subtype).toBeUndefined();
  });

  it("ordinary email body has no subtype", () => {
    const result = classifyEmailIntent({ body: "I will send the contract by Tuesday." });
    expect(result.subtype).toBeUndefined();
  });

  it("connector still wins over insight: '@Slack send insights'", () => {
    const result = classifyEmailIntent({ body: "@Slack send insights" });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.subtype).toBe("connector_command");
    expect(result.matchedRule).toBe("connector-command");
  });
});

describe("classifyEmailIntent", () => {
  it("classifies a correction prefix", () => {
    const result = classifyEmailIntent({ body: "Correct: the due date is Friday, not Tuesday." });

    expect(result.intent).toBe<EmailIntent>("correction");
    expect(result.basis).toBe("rule");
    expect(result.matchedRule).toBe("correction-prefix");
  });

  it("classifies a command prefix (dismiss N)", () => {
    const result = classifyEmailIntent({ body: "dismiss 1" });

    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.matchedRule).toBe("command-prefix");
  });

  it("classifies other command variants (confirm, remind me, mark N done)", () => {
    expect(classifyEmailIntent({ body: "confirm" }).intent).toBe<EmailIntent>("command");
    expect(classifyEmailIntent({ body: "remind me tomorrow" }).intent).toBe<EmailIntent>("command");
    expect(classifyEmailIntent({ body: "mark 2 done" }).intent).toBe<EmailIntent>("command");
  });

  it("classifies an approval prefix", () => {
    expect(classifyEmailIntent({ body: "approve" }).intent).toBe<EmailIntent>("approval");
    expect(classifyEmailIntent({ body: "approved" }).intent).toBe<EmailIntent>("approval");
    const yesApprove = classifyEmailIntent({ body: "yes, approve the discount" });
    expect(yesApprove.intent).toBe<EmailIntent>("approval");
    expect(yesApprove.matchedRule).toBe("approval-prefix");
  });

  it("'What are my open loops this week?' classifies as command/insight_command (NOT trailing-question)", () => {
    // Was previously classified as "question" via trailing-question rule.
    // Now the insight pre-rule fires first and returns command/insight_command.
    const result = classifyEmailIntent({ body: "What are my open loops this week?" });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.matchedRule).toBe("insight-command");
    expect(result.subtype).toBe("insight_command");
  });

  it("genuine trailing question (non-insight) classifies as question", () => {
    const result = classifyEmailIntent({ body: "What time is the sync?" });
    expect(result.intent).toBe<EmailIntent>("question");
    expect(result.matchedRule).toBe("trailing-question");
    expect(result.subtype).toBeUndefined();
  });

  it("does not treat a request phrased as a question as a question intent", () => {
    // Trailing "?" but contains a request phrase — falls through to capture, not question.
    expect(classifyEmailIntent({ body: "Can you send the renewal packet?" }).intent).toBe<EmailIntent>(
      "capture",
    );
    expect(classifyEmailIntent({ body: "Could you follow up please?" }).intent).toBe<EmailIntent>(
      "capture",
    );
  });

  it("falls back to capture for ordinary email bodies", () => {
    const result = classifyEmailIntent({ body: "I will send the contract by Tuesday." });

    expect(result.intent).toBe<EmailIntent>("capture");
    expect(result.basis).toBe("rule");
    expect(result.matchedRule).toBe("capture-default");
  });

  it("ignores leading/trailing whitespace and case when matching prefixes", () => {
    expect(classifyEmailIntent({ body: "  DISMISS 3  " }).intent).toBe<EmailIntent>("command");
    expect(classifyEmailIntent({ body: "\n Correct the owner \n" }).intent).toBe<EmailIntent>(
      "correction",
    );
  });
});

// ---------------------------------------------------------------------------
// detectInsightCommand — deterministic patterns (Phase 5 A3)
// ---------------------------------------------------------------------------

describe("detectInsightCommand", () => {
  it.each([
    ["insights", { kind: "insights" }],
    ["Insights", { kind: "insights" }],
    ["what are my insights?", { kind: "insights" }],
    ["what are my insight", { kind: "insights" }],
    ["what are my open loops", { kind: "insights" }],
    ["open loops", { kind: "insights" }],
    ["what are open loops", { kind: "insights" }],
    ["what are my open loops this week?", { kind: "insights" }],
    ["status", { kind: "insights" }],
    ["Status?", { kind: "insights" }],
    ["what am I waiting on?", { kind: "waiting_on" }],
    ["what is waiting on?", { kind: "waiting_on" }],
    ["what is stale?", { kind: "stale" }],
    ["stale loops", { kind: "stale" }],
    ["stale loop?", { kind: "stale" }],
    ["weekly summary", { kind: "weekly" }],
    ["weekly digest", { kind: "weekly" }],
  ])("'%s' → %o", (input, expected) => {
    expect(detectInsightCommand(input)).toMatchObject(expected);
  });

  it("'show Acme loops' → entity with entityCandidate", () => {
    expect(detectInsightCommand("show Acme loops")).toEqual({ kind: "entity", entityCandidate: "Acme" });
  });

  it("'loops with Maya' → entity with entityCandidate", () => {
    expect(detectInsightCommand("loops with Maya")).toEqual({ kind: "entity", entityCandidate: "Maya" });
  });

  it("'loops for Acme Corp?' → entity with entityCandidate", () => {
    expect(detectInsightCommand("loops for Acme Corp?")).toEqual({
      kind: "entity",
      entityCandidate: "Acme Corp",
    });
  });

  it("'Acme status' → entity with entityCandidate", () => {
    expect(detectInsightCommand("Acme status")).toEqual({ kind: "entity", entityCandidate: "Acme" });
  });

  it("'status' alone does NOT hit the entity-status rule", () => {
    // must match the insights rule, not entity
    expect(detectInsightCommand("status")).toEqual({ kind: "insights" });
  });

  it("non-insight body → null", () => {
    expect(detectInsightCommand("I will send the contract Tuesday")).toBeNull();
    expect(detectInsightCommand("Can you ping Maya?")).toBeNull();
    expect(detectInsightCommand("What time is the sync?")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyEmailIntent — insight-command pre-rule (Phase 5 A3)
// ---------------------------------------------------------------------------

describe("classifyEmailIntent — insight-command pre-rule", () => {
  it.each([
    "insights",
    "what are my insights?",
    "what are my open loops",
    "what are my open loops this week?",
    "status",
    "what am I waiting on?",
    "what is stale?",
    "stale loops",
    "weekly summary",
    "weekly digest",
  ])("'%s' → command/insight_command", (body) => {
    const result = classifyEmailIntent({ body });
    expect(result.intent).toBe<EmailIntent>("command");
    expect(result.basis).toBe("rule");
    expect(result.matchedRule).toBe("insight-command");
    expect(result.subtype).toBe("insight_command");
  });

  it("non-insight body does NOT get insight subtype", () => {
    const result = classifyEmailIntent({ body: "I will send the contract Tuesday" });
    expect(result.subtype).toBeUndefined();
    expect(result.intent).toBe<EmailIntent>("capture");
  });
});

// ---------------------------------------------------------------------------
// classifyInsightCommand — full classifier (Phase 5 A3)
// ---------------------------------------------------------------------------

describe("classifyInsightCommand", () => {
  it.each([
    ["insights", "insights"],
    ["what are my insights?", "insights"],
    ["what are my open loops", "insights"],
    ["what are my open loops this week?", "insights"],
    ["status", "insights"],
    ["what am I waiting on?", "waiting_on"],
    ["what is stale?", "stale"],
    ["stale loops", "stale"],
    ["weekly summary", "weekly"],
    ["weekly digest", "weekly"],
  ])("'%s' → kind '%s', scope {}, basis 'rule'", async (text, expectedKind) => {
    const result = await classifyInsightCommand(text);
    expect(result.kind).toBe(expectedKind);
    expect(result.scope).toEqual({});
    expect(result.basis).toBe("rule");
  });

  it("non-insight body → unknown", async () => {
    const result = await classifyInsightCommand("I will send the contract Tuesday");
    expect(result.kind).toBe("unknown");
    expect(result.scope).toEqual({});
    expect(result.basis).toBe("rule");
  });

  // entity — deterministic resolution via knownParticipants
  it("'show Acme loops' + knownParticipants=['Acme Corp'] → entity/rule", async () => {
    const result = await classifyInsightCommand("show Acme loops", {
      knownParticipants: ["Acme Corp"],
    });
    expect(result.kind).toBe("entity");
    expect(result.basis).toBe("rule");
    if (result.kind === "entity") {
      expect(result.scope.entity).toBe("Acme");
    }
  });

  it("'loops with Maya' + knownParticipants=['Maya Chen'] → entity/rule", async () => {
    const result = await classifyInsightCommand("loops with Maya", {
      knownParticipants: ["Maya Chen"],
    });
    expect(result.kind).toBe("entity");
    expect(result.basis).toBe("rule");
    if (result.kind === "entity") {
      expect(result.scope.entity).toBe("Maya");
    }
  });

  it("'Acme status' + knownParticipants=['Acme'] → entity/rule", async () => {
    const result = await classifyInsightCommand("Acme status", {
      knownParticipants: ["Acme"],
    });
    expect(result.kind).toBe("entity");
    expect(result.basis).toBe("rule");
    if (result.kind === "entity") {
      expect(result.scope.entity).toBe("Acme");
    }
  });

  // entity — model path
  it("entity model path: extra model fields are dropped from scope", async () => {
    const result = await classifyInsightCommand("show Acme loops", {
      useModel: true,
      knownParticipants: [],
      generateEntity: async () => ({ entity: "Acme", junk: "x" } as any),
    });
    expect(result.kind).toBe("entity");
    expect(result.basis).toBe("model");
    if (result.kind === "entity") {
      expect(result.scope).toEqual({ entity: "Acme" });
      // Ensure extra model fields don't leak into scope
      expect(Object.keys(result.scope)).toEqual(["entity"]);
    }
  });

  // entity — no match, no model
  it("entity no-match, no model → unknown", async () => {
    const result = await classifyInsightCommand("show Acme loops", {
      knownParticipants: [],
    });
    expect(result.kind).toBe("unknown");
    expect(result.basis).toBe("rule");
  });

  // entity — model returns null
  it("entity model returns null → unknown", async () => {
    const result = await classifyInsightCommand("show Acme loops", {
      useModel: true,
      knownParticipants: [],
      generateEntity: async () => null,
    });
    expect(result.kind).toBe("unknown");
    expect(result.basis).toBe("rule");
  });
});
