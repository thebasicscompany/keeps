import { describe, expect, it } from "vitest";
import { classifyEmailIntent, type EmailIntent } from "@/agent/classify-intent";

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

  it("classifies a trailing-question email", () => {
    const result = classifyEmailIntent({ body: "What are my open loops this week?" });

    expect(result.intent).toBe<EmailIntent>("question");
    expect(result.matchedRule).toBe("trailing-question");
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
