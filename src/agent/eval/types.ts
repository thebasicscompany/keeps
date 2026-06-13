import type { z } from "zod";
import type { extractionIntentSchema, loopKindSchema, LoopCandidate } from "@/agent/schemas";
import type { NormalizedEmail } from "@/email/normalize";

/**
 * The extraction intent union (capture | command | approval | question | correction | unknown).
 * Mirrors src/agent/schemas.ts extractionIntentSchema.
 */
export type EvalIntent = z.infer<typeof extractionIntentSchema>;

/**
 * The loop-kind union (commitment | ask | waiting_on | ...).
 * Mirrors src/agent/schemas.ts loopKindSchema.
 */
export type EvalLoopKind = z.infer<typeof loopKindSchema>;

export type ConfidenceBand = "low" | "medium" | "high";

/**
 * A single human-labeled expected loop for a case. The *Text fields are the
 * free-text owner/requester/due-date a human would write; the matcher compares
 * `summary` (token Jaccard) and `kind` (with an allowed substitute set), and
 * checks `confidenceBand` SEPARATELY.
 */
export type ExpectedLoop = {
  summary: string;
  kind: EvalLoopKind;
  ownerText: string;
  requesterText: string;
  dueDateText: string | null;
  confidenceBand: ConfidenceBand;
  expectsClarifyingQuestion: boolean;
};

/**
 * A labeled evaluation case. `normalized` is fed straight to extractLoops; `label`
 * is the human ground truth the predicted loops are scored against.
 */
export type EvalCase = {
  id: string;
  normalized: NormalizedEmail;
  label: {
    intent: EvalIntent;
    expectedLoops: ExpectedLoop[];
  };
};

/**
 * One expected loop's best match against the predicted set.
 * `predictedIndex` is the index into the predicted array that matched, or null
 * if no predicted loop met the match threshold (a miss → hurts recall).
 */
export type ExpectedMatch = {
  expectedIndex: number;
  predictedIndex: number | null;
  jaccard: number;
  kindMatched: boolean;
  /**
   * Whether the predicted loop's confidence band equals the expected band.
   * Checked SEPARATELY from the match decision (band mismatch does not block a match).
   * null when there was no matched prediction.
   */
  confidenceBandMatched: boolean | null;
};

/**
 * Per-predicted-loop flag: true when this prediction matched no expected loop
 * (a spurious prediction → hurts precision / counts as a false positive).
 */
export type PredictedFlag = {
  predictedIndex: number;
  spurious: boolean;
};

/**
 * The result of matching one case's predicted loops against its expected loops.
 */
export type MatchResult = {
  /** One entry per expected loop, in order. */
  expectedMatches: ExpectedMatch[];
  /** One entry per predicted loop, in order. */
  predictedFlags: PredictedFlag[];
  /** truePositives / (truePositives + falsePositives); null when there were no predictions. */
  precision: number | null;
  /** truePositives / (truePositives + falseNegatives); null when there were no expected loops. */
  recall: number | null;
  /** harmonic mean of precision & recall; null when either is null. */
  f1: number | null;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
};

/**
 * Subset of LoopCandidate fields the matcher actually reads. Kept structural so
 * tests can pass minimal predicted objects without constructing a full candidate.
 */
export type PredictedLoopLike = Pick<LoopCandidate, "summary" | "kind" | "confidence">;
