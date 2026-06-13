import { describe, expect, it } from "vitest";
import { aggregateScores, gateFailed, type Aggregate, type CaseScore } from "@/agent/eval/cli";
import { matchLoops } from "@/agent/eval/matcher";
import type { ExpectedLoop, PredictedLoopLike } from "@/agent/eval/types";

// Build a CaseScore directly from in-memory predicted/expected loops. No DB, no
// model, no extractLoops — pure scoring path.
function makeScore(
  id: string,
  predicted: PredictedLoopLike[],
  expected: ExpectedLoop[],
  clarifyingQuestion: string | null = null,
): CaseScore {
  const result = matchLoops(predicted, expected);
  const allLowConfidence = predicted.length > 0 && predicted.every((loop) => loop.confidence < 0.7);
  return {
    id,
    predictedCount: predicted.length,
    expectedCount: expected.length,
    result,
    allLowConfidence,
    clarifyingQuestion,
  };
}

const sendDeck: ExpectedLoop = {
  summary: "Send the deck by Friday",
  kind: "commitment",
  ownerText: "Arav",
  requesterText: "Maya",
  dueDateText: "Friday",
  confidenceBand: "high",
  expectsClarifyingQuestion: false,
};

describe("aggregateScores", () => {
  it("matching predicted → precision 1.0, recall 1.0", () => {
    const score = makeScore(
      "case-match",
      [{ summary: "Send the deck by Friday", kind: "commitment", confidence: 0.84 }],
      [sendDeck],
    );
    const aggregate = aggregateScores([score]);
    expect(aggregate.precision).toBe(1);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.falsePositiveRate).toBe(0);
  });

  it("partial predicted ('Send a deck' vs full) → precision drops", () => {
    // "send deck" vs "send deck friday": jaccard 2/3 = 0.67 >= 0.5 still matches,
    // so to make precision *drop* we add an extra spurious prediction.
    const score = makeScore(
      "case-partial",
      [
        { summary: "Send the deck by Friday", kind: "commitment", confidence: 0.84 },
        { summary: "Book a venue for the offsite", kind: "commitment", confidence: 0.84 },
      ],
      [sendDeck],
    );
    const aggregate = aggregateScores([score]);
    expect(aggregate.recall).toBe(1); // the one expected loop is found
    expect(aggregate.precision).toBe(0.5); // 1 of 2 predictions is spurious
    expect(aggregate.precision! < 1).toBe(true);
  });

  it("empty predicted, non-empty expected → recall 0, precision null (no predictions)", () => {
    const score = makeScore("case-miss", [], [sendDeck]);
    const aggregate = aggregateScores([score]);
    expect(aggregate.recall).toBe(0);
    expect(aggregate.precision).toBeNull();
    expect(aggregate.falsePositiveRate).toBeNull();
  });

  it("low_confidence_handling_rate counts only all-low-confidence cases", () => {
    const handled = makeScore(
      "low-handled",
      [{ summary: "Track the thing", kind: "reminder", confidence: 0.4 }],
      [{ ...sendDeck, summary: "Track the thing", kind: "reminder" }],
      "Should I track this?",
    );
    const unhandled = makeScore(
      "low-unhandled",
      [{ summary: "Track the other thing", kind: "reminder", confidence: 0.4 }],
      [{ ...sendDeck, summary: "Track the other thing", kind: "reminder" }],
      null,
    );
    const aggregate = aggregateScores([handled, unhandled]);
    expect(aggregate.lowConfidenceHandlingRate).toBe(0.5);
  });

  it("empty suite → all rates null", () => {
    const aggregate = aggregateScores([]);
    expect(aggregate.precision).toBeNull();
    expect(aggregate.recall).toBeNull();
    expect(aggregate.lowConfidenceHandlingRate).toBeNull();
  });
});

describe("gateFailed", () => {
  const baseline = { precision: 0.7, recall: 0.6 };

  function agg(precision: number | null, recall: number | null): Aggregate {
    return {
      caseCount: 1,
      precision,
      recall,
      lowConfidenceHandlingRate: null,
      falsePositiveRate: null,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      totalPredictions: 0,
      totalExpected: 0,
    };
  }

  it("passes when at/above baseline", () => {
    expect(gateFailed(agg(0.7, 0.6), baseline)).toBe(false);
    expect(gateFailed(agg(1, 1), baseline)).toBe(false);
  });

  it("returns exit-1 (failed) when precision below baseline", () => {
    expect(gateFailed(agg(0.5, 0.9), baseline)).toBe(true);
  });

  it("returns exit-1 (failed) when recall below baseline", () => {
    expect(gateFailed(agg(0.9, 0.4), baseline)).toBe(true);
  });

  it("treats null metrics as a gate failure (no evidence)", () => {
    expect(gateFailed(agg(null, 0.9), baseline)).toBe(true);
    expect(gateFailed(agg(0.9, null), baseline)).toBe(true);
  });
});
