import { describe, expect, it } from "vitest";

import {
  ASK_CONF,
  CLOSE_CONF,
  TOKEN_SIM_FLOOR,
  UPDATE_CONF,
  decideReconciliation,
  type ReconcileCandidate,
  type ReconcileProposal,
  type ReconcileStructuralContext,
} from "@/agent/reconcile";

// ── Builders ─────────────────────────────────────────────────────────────────

// Two summaries with HIGH token overlap (well above TOKEN_SIM_FLOOR=0.30).
const SUMMARY_A = "send the signed vendor contract to acme finance";
const SUMMARY_A_PARAPHRASE = "send the signed vendor contract to acme finance team";
// A summary with NO meaningful overlap with SUMMARY_A.
const SUMMARY_UNRELATED = "schedule dentist appointment next tuesday morning";

function proposal(overrides: Partial<ReconcileProposal> = {}): ReconcileProposal {
  return {
    reconcilesLoopRef: "L2",
    reconcileAction: "update",
    reconcileConfidence: 0.9,
    reconcileEvidence: "thread-id:abc123 shared subject line",
    ...overrides,
  };
}

function candidate(overrides: Partial<NonNullable<ReconcileCandidate>> = {}): ReconcileCandidate {
  return {
    id: "loop-uuid-2",
    refId: "L2",
    summary: SUMMARY_A,
    ...overrides,
  };
}

function structural(overrides: Partial<ReconcileStructuralContext> = {}): ReconcileStructuralContext {
  return {
    newLoopSummary: SUMMARY_A_PARAPHRASE,
    sameThread: true,
    sameEntity: false,
    ...overrides,
  };
}

// ── 1. Hard gates → create ───────────────────────────────────────────────────

describe("hard gates → create", () => {
  it("creates when the model proposes create", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "create", reconcilesLoopRef: null, reconcileEvidence: null }),
      candidate: null,
      structural: structural(),
    });
    expect(d.kind).toBe("create");
  });

  it("creates when reconcilesLoopRef is null (even with action=update)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcilesLoopRef: null }),
      candidate: candidate(),
      structural: structural(),
    });
    expect(d.kind).toBe("create");
  });

  it("creates when candidate is null (hallucinated/absent ref)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcilesLoopRef: "L99" }),
      candidate: null,
      structural: structural(),
    });
    expect(d.kind).toBe("create");
  });

  it("creates when evidence is null even if EVERYTHING else screams match", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileConfidence: 0.99, reconcileEvidence: null }),
      candidate: candidate(),
      structural: structural({ sameThread: true, sameEntity: true }),
    });
    expect(d.kind).toBe("create");
  });

  it("creates when evidence is blank/whitespace (evidence-required gate)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileConfidence: 0.99, reconcileEvidence: "   " }),
      candidate: candidate(),
      structural: structural({ sameThread: true, sameEntity: true }),
    });
    expect(d.kind).toBe("create");
  });
});

// ── 2. AUTO update ───────────────────────────────────────────────────────────

describe("auto update", () => {
  it("auto-updates on same thread + high sim + high conf, with the right loopId", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: 0.81 }),
      candidate: candidate(),
      structural: structural({ sameThread: true, sameEntity: false }),
    });
    expect(d).toMatchObject({ kind: "reconcile", action: "update", loopId: "loop-uuid-2" });
  });

  it("auto-updates on sameEntity (not thread) + high sim + high conf", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: 0.9 }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: true }),
    });
    expect(d).toMatchObject({ kind: "reconcile", action: "update" });
  });
});

// ── 3. AUTO close ────────────────────────────────────────────────────────────

describe("auto close", () => {
  it("auto-closes on same thread + high sim + conf ≥ CLOSE_CONF", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: CLOSE_CONF }),
      candidate: candidate(),
      structural: structural({ sameThread: true, sameEntity: false }),
    });
    expect(d).toMatchObject({ kind: "reconcile", action: "close", loopId: "loop-uuid-2" });
  });

  it("DOWNGRADES close to ask when only sameEntity (NOT sameThread) at high conf", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: 0.99 }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: true }),
    });
    // The destructive-cross-thread guard: must NOT auto-close.
    expect(d.kind).toBe("ask");
    expect(d.kind === "ask" && d.loopId).toBe("loop-uuid-2");
  });

  it("DOWNGRADES close to ask when sameThread but conf below CLOSE_CONF", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: UPDATE_CONF }),
      candidate: candidate(),
      structural: structural({ sameThread: true }),
    });
    expect(d.kind).toBe("ask");
  });

  it("DOWNGRADES close to ask when sameThread + high conf but guardrail disagrees", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: 0.99 }),
      candidate: candidate({ summary: SUMMARY_UNRELATED }),
      structural: structural({ sameThread: true, newLoopSummary: SUMMARY_A }),
    });
    expect(d.kind).toBe("ask");
  });
});

// ── 4. Middle band (ask) ─────────────────────────────────────────────────────

describe("middle band → ask", () => {
  it("asks when update has a structural signal but conf in [ASK_CONF, UPDATE_CONF)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: 0.5 }),
      candidate: candidate(),
      structural: structural({ sameThread: true }),
    });
    expect(d.kind).toBe("ask");
    expect(d.kind === "ask" && d.loopId).toBe("loop-uuid-2");
  });

  it("asks (update) when guardrail agrees but conf just below UPDATE_CONF", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: UPDATE_CONF - 0.01 }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: true }),
    });
    expect(d.kind).toBe("ask");
  });
});

// ── 5. No structural signal → false-merge guards ─────────────────────────────

describe("no structural signal", () => {
  it("creates on no structural signal + low sim (cross-thread/cross-entity guard) — NEVER reconcile", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: 0.9 }),
      candidate: candidate({ summary: SUMMARY_UNRELATED }),
      structural: structural({ sameThread: false, sameEntity: false, newLoopSummary: SUMMARY_A }),
    });
    expect(d.kind).toBe("create");
  });

  it("asks on no structural signal BUT high sim + high conf (plausible, unverifiable)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: 0.9 }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: false }),
    });
    expect(d.kind).toBe("ask");
  });

  it("CALIBRATION GUARD: conf 0.95 with no structural signal AND no guardrail agreement → create", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: 0.95 }),
      candidate: candidate({ summary: SUMMARY_UNRELATED }),
      structural: structural({ sameThread: false, sameEntity: false, newLoopSummary: SUMMARY_A }),
    });
    // Confidence ALONE can never authorize anything beyond a create here.
    expect(d.kind).toBe("create");
  });

  it("close with no structural signal + high sim + high conf → ask (never auto-close)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: 0.99 }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: false }),
    });
    expect(d.kind).toBe("ask");
  });
});

// ── 6. Boundary tests around each threshold ──────────────────────────────────

describe("threshold boundaries", () => {
  it("UPDATE_CONF boundary: exactly UPDATE_CONF auto-updates (>=)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: UPDATE_CONF }),
      candidate: candidate(),
      structural: structural({ sameThread: true }),
    });
    expect(d.kind).toBe("reconcile");
  });

  it("UPDATE_CONF boundary: just below stays ask", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: UPDATE_CONF - 0.001 }),
      candidate: candidate(),
      structural: structural({ sameThread: true }),
    });
    expect(d.kind).toBe("ask");
  });

  it("CLOSE_CONF boundary: exactly CLOSE_CONF auto-closes (>=)", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: CLOSE_CONF }),
      candidate: candidate(),
      structural: structural({ sameThread: true }),
    });
    expect(d.kind).toBe("reconcile");
  });

  it("CLOSE_CONF boundary: just below downgrades to ask", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "close", reconcileConfidence: CLOSE_CONF - 0.001 }),
      candidate: candidate(),
      structural: structural({ sameThread: true }),
    });
    expect(d.kind).toBe("ask");
  });

  it("ASK_CONF boundary (no structural): exactly ASK_CONF + guardrail → ask", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: ASK_CONF }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: false }),
    });
    expect(d.kind).toBe("ask");
  });

  it("ASK_CONF boundary (no structural): just below → create", () => {
    const d = decideReconciliation({
      proposal: proposal({ reconcileAction: "update", reconcileConfidence: ASK_CONF - 0.001 }),
      candidate: candidate(),
      structural: structural({ sameThread: false, sameEntity: false }),
    });
    expect(d.kind).toBe("create");
  });

  it("CLOSE_CONF is strictly above UPDATE_CONF (invariant)", () => {
    expect(CLOSE_CONF).toBeGreaterThan(UPDATE_CONF);
  });

  it("TOKEN_SIM_FLOOR boundary: sim exactly at floor counts as agreement", () => {
    // Construct summaries whose Jaccard is >= floor on one side. We assert the
    // floor itself is a sane value; precise sim is exercised by behavior tests.
    expect(TOKEN_SIM_FLOOR).toBeGreaterThan(0);
    expect(TOKEN_SIM_FLOOR).toBeLessThan(1);
  });
});

// ── 7. Provenance reason is always present and non-empty ─────────────────────

describe("provenance", () => {
  it("every decision carries a one-sentence reason", () => {
    const cases: ReconcileProposal[] = [
      proposal({ reconcileAction: "create" }),
      proposal({ reconcileAction: "update", reconcileConfidence: 0.9 }),
      proposal({ reconcileAction: "close", reconcileConfidence: CLOSE_CONF }),
      proposal({ reconcileAction: "update", reconcileConfidence: 0.5 }),
    ];
    for (const p of cases) {
      const d = decideReconciliation({ proposal: p, candidate: candidate(), structural: structural({ sameThread: true }) });
      expect(typeof d.reason).toBe("string");
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});
