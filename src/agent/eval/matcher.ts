import type { EvalLoopKind, ExpectedLoop, MatchResult, PredictedLoopLike, ConfidenceBand } from "@/agent/eval/types";

/**
 * Minimal stop-word list. Deliberately small: the goal is to drop filler that
 * inflates Jaccard overlap without carrying meaning, NOT to do real NLP.
 */
const STOP_WORDS = new Set<string>([
  "a",
  "an",
  "the",
  "to",
  "of",
  "on",
  "in",
  "for",
  "and",
  "or",
  "by",
  "is",
  "are",
  "be",
  "will",
  "you",
  "i",
  "we",
  "it",
  "this",
  "that",
  "with",
  "at",
]);

/**
 * tokenize: lowercase, strip punctuation, split on whitespace, drop stop words
 * and empties. Exported for direct unit testing.
 */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);

  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const JACCARD_THRESHOLD = 0.5;

/**
 * Allowed kind substitutes. A predicted `ask` may legitimately stand in for an
 * expected `commitment` (and vice-versa) when the only difference is an ownership
 * flip — "you owe them" vs "they owe you" describe the same loop from opposite
 * sides. No other kind substitutions are allowed.
 */
const KIND_SUBSTITUTES: Record<string, Set<EvalLoopKind>> = {
  ask: new Set<EvalLoopKind>(["commitment"]),
  commitment: new Set<EvalLoopKind>(["ask"]),
};

function kindMatches(predicted: EvalLoopKind, expected: EvalLoopKind): boolean {
  if (predicted === expected) {
    return true;
  }

  return KIND_SUBSTITUTES[expected]?.has(predicted) ?? false;
}

/**
 * Map a raw model confidence to a band. Boundaries (per spec): low < 0.5,
 * medium < 0.7, high >= 0.7.
 */
export function confidenceToBand(confidence: number): ConfidenceBand {
  if (confidence < 0.5) {
    return "low";
  }
  if (confidence < 0.7) {
    return "medium";
  }
  return "high";
}

/**
 * matchLoops: greedy best-match of predicted loops against expected loops.
 *
 * A predicted loop MATCHES an expected loop when BOTH:
 *   (a) Jaccard(tokenize(summary)) >= JACCARD_THRESHOLD, AND
 *   (b) the kinds match OR the predicted kind is an allowed substitute.
 *
 * Confidence band is checked SEPARATELY (it never blocks a match) and reported
 * on each ExpectedMatch as confidenceBandMatched.
 *
 * Each predicted loop matches at most one expected loop and vice-versa. We pick,
 * for each expected loop in order, the highest-Jaccard still-unclaimed predicted
 * loop that satisfies (a)+(b).
 */
export function matchLoops(predicted: PredictedLoopLike[], expected: ExpectedLoop[]): MatchResult {
  const predictedTokens = predicted.map((loop) => tokenize(loop.summary));
  const expectedTokens = expected.map((loop) => tokenize(loop.summary));
  const claimed = new Set<number>();

  const expectedMatches = expected.map((expectedLoop, expectedIndex) => {
    let bestPredictedIndex: number | null = null;
    let bestJaccard = 0;

    for (let predictedIndex = 0; predictedIndex < predicted.length; predictedIndex += 1) {
      if (claimed.has(predictedIndex)) {
        continue;
      }

      const score = jaccard(predictedTokens[predictedIndex] ?? [], expectedTokens[expectedIndex] ?? []);
      if (score < JACCARD_THRESHOLD) {
        continue;
      }
      if (!kindMatches(predicted[predictedIndex]!.kind, expectedLoop.kind)) {
        continue;
      }
      if (score > bestJaccard) {
        bestJaccard = score;
        bestPredictedIndex = predictedIndex;
      }
    }

    let confidenceBandMatched: boolean | null = null;
    if (bestPredictedIndex !== null) {
      claimed.add(bestPredictedIndex);
      const predictedBand = confidenceToBand(predicted[bestPredictedIndex]!.confidence);
      confidenceBandMatched = predictedBand === expectedLoop.confidenceBand;
    }

    return {
      expectedIndex,
      predictedIndex: bestPredictedIndex,
      jaccard: bestPredictedIndex === null ? 0 : bestJaccard,
      kindMatched: bestPredictedIndex !== null,
      confidenceBandMatched,
    };
  });

  const predictedFlags = predicted.map((_, predictedIndex) => ({
    predictedIndex,
    spurious: !claimed.has(predictedIndex),
  }));

  const truePositives = claimed.size;
  const falsePositives = predicted.length - truePositives;
  const falseNegatives = expected.length - truePositives;

  const precision = predicted.length === 0 ? null : truePositives / predicted.length;
  const recall = expected.length === 0 ? null : truePositives / expected.length;
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    expectedMatches,
    predictedFlags,
    precision,
    recall,
    f1,
    truePositives,
    falsePositives,
    falseNegatives,
  };
}

/**
 * gradedMatchLoops — model-graded matcher. Not implemented in v1.
 *
 * // TODO Phase 6.1: model-graded matcher with rubric
 * Rubric draft (to be sent to the grader model):
 *   "Score 1 if same actionable commitment; 0.5 if same topic but different
 *    ownership; 0 otherwise."
 */
export function gradedMatchLoops(_predicted: PredictedLoopLike[], _expected: ExpectedLoop[]): MatchResult {
  throw new Error("not implemented in v1");
}
