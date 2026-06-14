import { jaccard, tokenize } from "@/agent/eval/matcher";

/**
 * Phase 7 B2a — the PURE, deterministic three-band reconciliation DECIDER.
 *
 * This is the single most safety-critical function in the Context Engine. It
 * DISPOSES (AR-8) on a reconciliation that the model already PROPOSED upstream.
 * It makes NO model calls, touches NO DB, needs NO credentials, and runs in the
 * default (DB-less) test suite.
 *
 * THE CARDINAL SIN IS A FALSE MERGE. Silently collapsing two DISTINCT
 * commitments into one destroys a commitment — the worst possible trust
 * failure. A false merge is a PRECISION failure (silent, destructive); a
 * duplicate loop is a RECALL failure (visible, recoverable). This decider is
 * tuned HARD for precision: when in doubt, DO NOT auto-reconcile.
 *
 * DESIGN MANDATE (binding, from an adversarial design audit): band on
 * STRUCTURED signals FIRST. The model's confidence is a WEAK SECONDARY feature
 * (LLM confidence is miscalibrated) — it can only gate WITHIN a structural band
 * and can NEVER, by itself, authorize an auto-reconcile. The structured signals
 * are: same email thread, same resolved entity, and a deterministic
 * token-similarity guardrail computed here (Jaccard over tokenized summaries).
 */

export type ReconcileProposal = {
  reconcilesLoopRef: string | null;
  reconcileAction: "create" | "update" | "close";
  reconcileConfidence: number;
  reconcileEvidence: string | null;
};

// The resolved candidate the proposal points at (caller maps refId -> CompactLoop),
// or null if the refId was absent/hallucinated/not in the injected set.
export type ReconcileCandidate = { id: string; refId: string; summary: string } | null;

// Structured facts the caller computes from the inbound email vs. the candidate:
export type ReconcileStructuralContext = {
  newLoopSummary: string; // the freshly-extracted loop's summary
  sameThread: boolean; // inbound email's emailThreadId === candidate.emailThreadId
  sameEntity: boolean; // overlap between inbound participants' entity ids and candidate.entityIds
};

export type ReconcileDecision =
  | { kind: "create"; reason: string }
  | { kind: "reconcile"; action: "update" | "close"; loopId: string; evidence: string; reason: string }
  | { kind: "ask"; loopId: string; evidence: string; reason: string };

/**
 * Threshold constants. All four are SECONDARY gates inside a structural band.
 * No `reconcile` outcome is reachable without BOTH a structural signal AND
 * guardrail agreement (and, for the destructive `close` action, specifically
 * `sameThread`). The confidence floors only modulate the choice WITHIN a band.
 *
 * - TOKEN_SIM_FLOOR: deterministic guardrail. The two summaries must share at
 *   least this Jaccard token overlap before any reconcile/update path opens.
 *   Low-ish (0.30) because summaries are paraphrased across emails; the
 *   structural signals carry the real precision weight.
 * - ASK_CONF: floor below which we don't even bother a human — too weak to be a
 *   plausible match, so we just `create` a fresh loop.
 * - UPDATE_CONF: confidence floor to AUTO update an existing (non-destructive) loop.
 * - CLOSE_CONF: confidence floor to AUTO close. STRICTLY above UPDATE_CONF
 *   because close is destructive (audit R7) — and close additionally demands
 *   `sameThread`, never `sameEntity` alone.
 */
export const TOKEN_SIM_FLOOR = 0.3;
export const ASK_CONF = 0.4;
export const UPDATE_CONF = 0.7;
export const CLOSE_CONF = 0.82;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Discriminator tokens — identifying markers that distinguish two otherwise-similar
 * commitments: quarters (q1–q4), fiscal years (fy24), halves (h1/h2), versions (v2, v1.3),
 * and any multi-digit number (invoice/PO/ticket numbers, years). Token-Jaccard CANNOT
 * separate "send Acme the Q2 renewal" from "...Q3 renewal" (0.60 overlap, one token differs),
 * which is a same-thread FALSE-MERGE corridor surfaced by the D1 eval. When both summaries
 * carry discriminators and they are fully DISJOINT, the commitments are treated as DISTINCT
 * and an auto-reconcile is DOWNGRADED to `ask` (never a silent merge — this guard can only
 * ever block a merge, never cause one).
 */
const DISCRIMINATOR_RE = /\b(?:q[1-4]|fy\d{2,4}|h[12]|v\d+(?:\.\d+)*|\d{2,})\b/gi;

export function discriminatorsOf(summary: string): Set<string> {
  const out = new Set<string>();
  const matches = summary.toLowerCase().match(DISCRIMINATOR_RE);
  if (matches) {
    for (const m of matches) out.add(m);
  }
  return out;
}

/**
 * True when both summaries carry at least one discriminator AND share none — i.e. each names
 * an identifier the other lacks (Q2 vs Q3, invoice 401 vs 402). Returns false when either side
 * has no discriminator (can't conclude) or they share one (likely the same deliverable).
 */
export function discriminatorMismatch(a: string, b: string): boolean {
  const da = discriminatorsOf(a);
  const db = discriminatorsOf(b);
  if (da.size === 0 || db.size === 0) return false;
  for (const x of da) {
    if (db.has(x)) return false; // a shared discriminator → not a mismatch
  }
  return true; // both non-empty, fully disjoint → distinct deliverables
}

export function decideReconciliation(input: {
  proposal: ReconcileProposal;
  candidate: ReconcileCandidate;
  structural: ReconcileStructuralContext;
}): ReconcileDecision {
  const { proposal, candidate, structural } = input;
  const { reconcileAction, reconcilesLoopRef, reconcileConfidence, reconcileEvidence } = proposal;

  // ── Step 1: HARD GATES → `create` (the safe default). ───────────────────────
  // ANY of these means we have no trustworthy basis to reconcile, so we fall
  // back to creating a fresh loop (RECALL failure at worst, never a false merge).
  if (reconcileAction === "create") {
    return { kind: "create", reason: "Created new: model proposed create, not a reconciliation." };
  }
  if (reconcilesLoopRef === null) {
    return { kind: "create", reason: "Created new: model cited no loop to reconcile against (ref null)." };
  }
  if (candidate === null) {
    return {
      kind: "create",
      reason: "Created new: proposed loop ref was absent or hallucinated (not in injected candidate set).",
    };
  }
  const evidence = reconcileEvidence?.trim() ?? "";
  if (evidence.length === 0) {
    // Evidence-required gate: no cited shared identifier ⇒ never reconcile,
    // even if every other signal screams "match".
    return {
      kind: "create",
      reason: "Created new: no evidence (shared identifier) was cited, so reconciliation is not permitted.",
    };
  }

  // ── Step 2: deterministic guardrail (token similarity over summaries). ───────
  const sim = jaccard(tokenize(structural.newLoopSummary), tokenize(candidate.summary));
  const guardrailAgrees = sim >= TOKEN_SIM_FLOOR;
  const simStr = round2(sim).toFixed(2);

  // Discriminator guard: even with high token overlap + a structural signal, disjoint
  // identifiers (Q2 vs Q3, 401 vs 402) mean DISTINCT commitments → never auto-reconcile.
  const discMismatch = discriminatorMismatch(structural.newLoopSummary, candidate.summary);

  // ── Step 3: structural signal presence. ─────────────────────────────────────
  const { sameThread, sameEntity } = structural;
  const hasStructural = sameThread || sameEntity;
  const structuralDesc = sameThread ? "same thread" : sameEntity ? "same entity" : "no structural signal";

  // ── Step 4: NO structural signal → NEVER auto-reconcile. ─────────────────────
  // This is exactly where false merges hide: cross-thread, cross-entity matches
  // proposed on the strength of paraphrase + (miscalibrated) model confidence.
  // The most we ever do here is ASK a human; confidence ALONE can never merge.
  if (!hasStructural) {
    if (guardrailAgrees && reconcileConfidence >= ASK_CONF) {
      return {
        kind: "ask",
        loopId: candidate.id,
        evidence,
        reason: `Asked: token overlap ${simStr} is plausible but no structural signal (thread/entity) corroborates it, model conf ${round2(reconcileConfidence)}.`,
      };
    }
    return {
      kind: "create",
      reason: `Created new: no structural signal and token overlap ${simStr} too weak to even ask, model conf ${round2(reconcileConfidence)}.`,
    };
  }

  // ── Step 5: HAS a structural signal — band by action. ───────────────────────
  if (reconcileAction === "update") {
    // AUTO update requires structural + guardrail + confidence floor — AND no discriminator
    // mismatch (disjoint identifiers ⇒ distinct deliverables, never silently merged).
    if (guardrailAgrees && reconcileConfidence >= UPDATE_CONF && !discMismatch) {
      return {
        kind: "reconcile",
        action: "update",
        loopId: candidate.id,
        evidence,
        reason: `Auto-updated ${candidate.refId}: ${structuralDesc} + token overlap ${simStr}, model conf ${round2(reconcileConfidence)}.`,
      };
    }
    // Would have auto-updated, but disjoint discriminators mark distinct deliverables → ask.
    if (guardrailAgrees && reconcileConfidence >= UPDATE_CONF && discMismatch) {
      return {
        kind: "ask",
        loopId: candidate.id,
        evidence,
        reason: `Asked instead of auto-updating ${candidate.refId}: ${structuralDesc} + overlap ${simStr}, but the two name different identifiers (e.g. Q2 vs Q3) — distinct deliverables, so confirm before merging.`,
      };
    }
    // Middle band: a structural OR guardrail signal plus minimal confidence ⇒ ask.
    if ((hasStructural || guardrailAgrees) && reconcileConfidence >= ASK_CONF) {
      return {
        kind: "ask",
        loopId: candidate.id,
        evidence,
        reason: `Asked to update ${candidate.refId}: ${structuralDesc} + token overlap ${simStr}, model conf ${round2(reconcileConfidence)} below auto bar.`,
      };
    }
    return {
      kind: "create",
      reason: `Created new: update proposal for ${candidate.refId} too weak (${structuralDesc}, token overlap ${simStr}, model conf ${round2(reconcileConfidence)}).`,
    };
  }

  // reconcileAction === "close" — DESTRUCTIVE, so STRICTER (audit R7).
  // AUTO close requires sameThread (NOT sameEntity alone) AND guardrail AND a
  // confidence floor strictly above update. Anything weaker DOWNGRADES to ask;
  // we never silently auto-close on weak evidence, and a sameEntity-but-not-
  // sameThread close proposal can NEVER auto-close.
  if (sameThread && guardrailAgrees && reconcileConfidence >= CLOSE_CONF && !discMismatch) {
    return {
      kind: "reconcile",
      action: "close",
      loopId: candidate.id,
      evidence,
      reason: `Auto-closed ${candidate.refId}: same thread + token overlap ${simStr}, model conf ${round2(reconcileConfidence)} ≥ close bar.`,
    };
  }
  // Structural signal present but strict close bar unmet → ask (downgrade).
  return {
    kind: "ask",
    loopId: candidate.id,
    evidence,
    reason: `Asked to close ${candidate.refId}: ${structuralDesc}, token overlap ${simStr}, model conf ${round2(reconcileConfidence)} — below the strict same-thread close bar, downgraded to ask.`,
  };
}
