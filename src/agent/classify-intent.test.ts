import { describe, expect, it } from "vitest";
import { classifyEmailIntent, type EmailIntent } from "@/agent/classify-intent";

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
