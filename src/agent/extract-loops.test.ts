import { describe, expect, it } from "vitest";
import { extractLoops, buildReconciliationPrompt, backfillParticipantEmails } from "@/agent/extract-loops";
import { loopExtractionResultSchema, type LoopExtractionResult } from "@/agent/schemas";
import { launchThreadFixture } from "@/agent/fixtures/launch-thread";
import { bccLikePostmarkFixture, forwardLikePostmarkFixture } from "@/email/fixtures/postmark";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import { assertApprovalAllowed, requiresApproval } from "@/policy/actions";
import type { ExtractionContext } from "@/agent/extraction-context";

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

  // -------------------------------------------------------------------------
  // Phase 7 B1 — context-aware reconciliation PROPOSAL fields
  // -------------------------------------------------------------------------

  it("deterministic path proposes create/null/0/null for EVERY candidate (never reconciles, no creds)", async () => {
    const result = await extractLoops({
      email: normalizePostmarkInbound(forwardLikePostmarkFixture),
    });

    expect(result.loops.length).toBeGreaterThan(0);
    for (const loop of result.loops) {
      expect(loop.reconcilesLoopRef).toBeNull();
      expect(loop.reconcileAction).toBe("create");
      expect(loop.reconcileConfidence).toBe(0);
      expect(loop.reconcileEvidence).toBeNull();
    }
    // The new fields must satisfy the strict schema.
    expect(() => loopExtractionResultSchema.parse(result)).not.toThrow();
  });

  it("is backward-compatible when context is absent (deterministic output unchanged + reconcile defaults)", async () => {
    const withoutContext = await extractLoops({ email: launchThreadFixture });
    // Passing an explicitly empty context must behave identically.
    const emptyContext: ExtractionContext = { openLoops: [], knownEntities: [] };
    const withEmptyContext = await extractLoops({ email: launchThreadFixture, context: emptyContext });

    expect(withEmptyContext.loops.map((l) => l.summary)).toEqual(
      withoutContext.loops.map((l) => l.summary),
    );
    for (const loop of withEmptyContext.loops) {
      expect(loop.reconcilesLoopRef).toBeNull();
      expect(loop.reconcileAction).toBe("create");
    }
  });
});

describe("buildReconciliationPrompt (Phase 7 B1 prompt builder)", () => {
  const context: ExtractionContext = {
    openLoops: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        refId: "L1",
        summary: "Send the renewal packet to Acme",
        status: "open",
        ownerText: "You",
        requesterText: "Acme",
        emailThreadId: "thread-acme-1",
        entityIds: ["e-acme"],
        dueAt: "2026-06-20T17:00:00.000Z",
        updatedAt: "2026-06-10T12:00:00.000Z",
        generators: ["thread", "entity"],
        score: 1.7,
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        refId: "L2",
        summary: "Confirm the discount cap with finance",
        status: "waiting_on_other",
        ownerText: null,
        requesterText: null,
        emailThreadId: "thread-finance-9",
        entityIds: [],
        dueAt: null,
        updatedAt: "2026-06-09T12:00:00.000Z",
        generators: ["recent"],
        score: 0.2,
      },
    ],
    knownEntities: [
      {
        id: "e-acme",
        displayName: "Acme Corp",
        kind: "company",
        canonicalEmail: "ops@acme.com",
        openLoopCount: 3,
      },
    ],
  };

  it("renders every candidate refId, summary, and the known entities block", () => {
    const prompt = buildReconciliationPrompt(context);

    // Candidate refIds + summaries present
    expect(prompt).toContain("L1: Send the renewal packet to Acme");
    expect(prompt).toContain("L2: Confirm the discount cap with finance");
    expect(prompt).toContain("status: open");
    expect(prompt).toContain("status: waiting_on_other");
    // Known entity rendered with kind + open-loop count
    expect(prompt).toContain("Acme Corp (company, 3 open loops)");
  });

  it("frames create-new as the SAFE DEFAULT and select-ONE-among-candidates (anti-anchoring)", () => {
    const prompt = buildReconciliationPrompt(context);

    expect(prompt).toContain("SAFE DEFAULT");
    expect(prompt.toLowerCase()).toContain("this email alone");
    expect(prompt.toLowerCase()).toContain("unambiguously");
    // Candidates are framed as context, not an instruction to match.
    expect(prompt).toContain("NOT instructions");
    // Require evidence when a refId is chosen.
    expect(prompt).toContain("reconcileEvidence MUST name the concrete shared identifier");
  });

  it("does NOT leak the real loop id to the model (refId only)", () => {
    const prompt = buildReconciliationPrompt(context);
    expect(prompt).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(prompt).not.toContain("22222222-2222-2222-2222-222222222222");
  });
});

describe("action policy", () => {
  it("requires approvals for external side effects", () => {
    expect(requiresApproval("send_slack_message")).toBe(true);
    expect(requiresApproval("create_private_loop")).toBe(false);
    expect(() => assertApprovalAllowed("send_slack_message")).toThrow(/requires an approval_request/);
  });
});

describe("backfillParticipantEmails", () => {
  const baseLoop = {
    summary: "Send the report",
    kind: "commitment" as const,
    status: "open" as const,
    basis: "explicit_commitment" as const,
    ownerText: null,
    requesterText: null,
    dueDateText: null,
    dueAt: null,
    nextCheckAt: null,
    dueDateUncertainty: "missing" as const,
    confidence: 0.9,
    explicitness: "explicit" as const,
    participants: [] as { name: string | null; email: string | null }[],
    source: { quote: "q", startOffset: null, endOffset: null },
    ambiguityFlags: [] as string[],
    reconcilesLoopRef: null,
    reconcileAction: "create" as const,
    reconcileConfidence: 0,
    reconcileEvidence: null,
  };

  function resultWith(
    participants: { name: string | null; email: string | null }[],
  ): LoopExtractionResult {
    return {
      intent: "capture",
      emailSummary: "summary",
      loops: [{ ...baseLoop, participants }],
      clarifyingQuestion: null,
      suggestedPrivateReply: "ok",
    };
  }

  it("fills a missing email from the header participant with the same name (→ company can form)", () => {
    const out = backfillParticipantEmails(resultWith([{ name: "Priya Nair", email: null }]), [
      { name: "Priya Nair", email: "priya@acme.com" },
    ]);
    expect(out.loops[0]?.participants[0]).toEqual({ name: "Priya Nair", email: "priya@acme.com" });
  });

  it("never overwrites an email the model already supplied", () => {
    const out = backfillParticipantEmails(
      resultWith([{ name: "Priya Nair", email: "priya.personal@gmail.com" }]),
      [{ name: "Priya Nair", email: "priya@acme.com" }],
    );
    expect(out.loops[0]?.participants[0]?.email).toBe("priya.personal@gmail.com");
  });

  it("leaves a name-only participant untouched when no header name matches", () => {
    const out = backfillParticipantEmails(resultWith([{ name: "Stranger", email: null }]), [
      { name: "Priya Nair", email: "priya@acme.com" },
    ]);
    expect(out.loops[0]?.participants[0]?.email).toBeNull();
  });
});
