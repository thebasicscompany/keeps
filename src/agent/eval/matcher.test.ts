import { describe, expect, it } from "vitest";
import { matchLoops, tokenize } from "@/agent/eval/matcher";
import type { ExpectedLoop, PredictedLoopLike } from "@/agent/eval/types";

function expectedLoop(overrides: Partial<ExpectedLoop> = {}): ExpectedLoop {
  return {
    summary: "Send the deck by Friday",
    kind: "commitment",
    ownerText: "Arav",
    requesterText: "Maya",
    dueDateText: "Friday",
    confidenceBand: "high",
    expectsClarifyingQuestion: false,
    ...overrides,
  };
}

function predictedLoop(overrides: Partial<PredictedLoopLike> = {}): PredictedLoopLike {
  return {
    summary: "Send the deck by Friday",
    kind: "commitment",
    confidence: 0.84,
    ...overrides,
  };
}

describe("tokenize", () => {
  it("lowercases, strips punctuation, and drops stop words", () => {
    expect(tokenize("Send the deck, by Friday!")).toEqual(["send", "deck", "friday"]);
  });
});

describe("matchLoops", () => {
  it("matches an identical summary", () => {
    const result = matchLoops([predictedLoop()], [expectedLoop()]);
    expect(result.expectedMatches[0]?.predictedIndex).toBe(0);
    expect(result.truePositives).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it("matches reordered tokens", () => {
    const result = matchLoops([predictedLoop({ summary: "By Friday, send the deck" })], [expectedLoop()]);
    expect(result.expectedMatches[0]?.predictedIndex).toBe(0);
    expect(result.truePositives).toBe(1);
  });

  it("does NOT match synonymous-but-different tokens (acknowledged limitation)", () => {
    // "ship the slides" vs "send the deck" — same meaning, disjoint tokens.
    const result = matchLoops([predictedLoop({ summary: "Ship the slides before Fri" })], [expectedLoop()]);
    expect(result.expectedMatches[0]?.predictedIndex).toBeNull();
    expect(result.truePositives).toBe(0);
    expect(result.predictedFlags[0]?.spurious).toBe(true);
  });

  it("matches a summary with extra context", () => {
    const result = matchLoops(
      [predictedLoop({ summary: "Send the deck by Friday for the launch review" })],
      [expectedLoop()],
    );
    // shared tokens send/deck/friday over union including launch/review => 3/5 = 0.6 >= 0.5
    expect(result.expectedMatches[0]?.predictedIndex).toBe(0);
    expect(result.truePositives).toBe(1);
  });

  it("does NOT match when the owner is wrong (no predicted summary overlap)", () => {
    // Wrong owner manifests as a different actionable summary; tokens diverge.
    const result = matchLoops(
      [predictedLoop({ summary: "Maya will confirm the launch copy" })],
      [expectedLoop()],
    );
    expect(result.expectedMatches[0]?.predictedIndex).toBeNull();
    expect(result.truePositives).toBe(0);
  });

  it("does NOT match a correct summary with the wrong kind (missing kind override)", () => {
    // Summary tokens fully overlap, but kind=reminder is not in commitment's substitute set.
    const result = matchLoops([predictedLoop({ kind: "reminder" })], [expectedLoop()]);
    expect(result.expectedMatches[0]?.predictedIndex).toBeNull();
    expect(result.truePositives).toBe(0);
    expect(result.predictedFlags[0]?.spurious).toBe(true);
  });

  it("allows ask<->commitment kind substitution for ownership flips", () => {
    const result = matchLoops([predictedLoop({ kind: "ask" })], [expectedLoop({ kind: "commitment" })]);
    expect(result.expectedMatches[0]?.predictedIndex).toBe(0);
  });

  it("reports confidence band separately from the match decision", () => {
    const result = matchLoops(
      [predictedLoop({ confidence: 0.3 })],
      [expectedLoop({ confidenceBand: "high" })],
    );
    // still a match, but the band disagrees
    expect(result.expectedMatches[0]?.predictedIndex).toBe(0);
    expect(result.expectedMatches[0]?.confidenceBandMatched).toBe(false);
  });

  it("returns null precision when there are no predictions", () => {
    const result = matchLoops([], [expectedLoop()]);
    expect(result.precision).toBeNull();
    expect(result.recall).toBe(0);
  });
});
