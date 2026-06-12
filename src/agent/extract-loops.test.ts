import { describe, expect, it } from "vitest";
import { extractLoops } from "@/agent/extract-loops";
import { loopExtractionResultSchema } from "@/agent/schemas";
import { launchThreadFixture } from "@/agent/fixtures/launch-thread";
import { bccLikePostmarkFixture, forwardLikePostmarkFixture } from "@/email/fixtures/postmark";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import { assertApprovalAllowed, requiresApproval } from "@/policy/actions";

describe("extractLoops", () => {
  it("returns schema-valid loop candidates from the phase 0 fixture", async () => {
    const result = await extractLoops({ email: launchThreadFixture });

    expect(() => loopExtractionResultSchema.parse(result)).not.toThrow();
    expect(result.intent).toBe("capture");
    expect(result.loops.length).toBeGreaterThanOrEqual(2);
    expect(result.loops[0]?.source.quote).toContain("I will send");
  });

  it("extracts useful candidates from a realistic forwarded email", async () => {
    const result = await extractLoops({ email: normalizePostmarkInbound(forwardLikePostmarkFixture) });

    expect(result.intent).toBe("capture");
    expect(result.loops.map((loop) => loop.summary)).toEqual(
      expect.arrayContaining(["Send the renewal packet.", "Confirm the discount cap."]),
    );
    expect(result.loops.every((loop) => loop.source.quote.length > 0)).toBe(true);
    expect(result.loops.some((loop) => loop.dueDateText === "Tuesday")).toBe(true);
  });

  it("extracts BCC-like candidates from the visible body", async () => {
    const result = await extractLoops({ email: normalizePostmarkInbound(bccLikePostmarkFixture) });

    expect(result.loops).toHaveLength(1);
    expect(result.loops[0]).toMatchObject({
      summary: "You can approve the discount after finance confirms the margin.",
      source: {
        quote: "I can approve the discount after finance confirms the margin",
      },
    });
  });

  it("asks for clarification on low-confidence capture", async () => {
    const result = await extractLoops({
      email: {
        ...launchThreadFixture,
        providerMessageId: "fixture-low-confidence-001",
        subject: "Keep an eye on this",
        textBody: "Can you keep this from slipping?",
      } satisfies NormalizedEmail,
    });

    expect(result.loops).toHaveLength(1);
    expect(result.loops[0]?.confidence).toBeLessThan(0.7);
    expect(result.clarifyingQuestion).toContain("Should I track this?");
  });
});

describe("action policy", () => {
  it("requires approvals for external side effects", () => {
    expect(requiresApproval("send_slack_message")).toBe(true);
    expect(requiresApproval("create_private_loop")).toBe(false);
    expect(() => assertApprovalAllowed("send_slack_message")).toThrow(/requires an approval_request/);
  });
});
