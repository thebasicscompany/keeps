import { describe, expect, it } from "vitest";
import {
  generateSuggestedSummary,
  type SummarizeInput,
} from "./summarize";

// Helper to build a minimal section with the given summaries
function makeSections(
  summaries: string[],
): SummarizeInput["sections"] {
  return [
    {
      rows: summaries.map((summary) => ({ loop: { summary } })),
    },
  ];
}

describe("generateSuggestedSummary", () => {
  // ── Deterministic fallback (useModel unset / false) ─────────────────────────

  it("produces correct plural headline when totalOpen > 1", async () => {
    const result = await generateSuggestedSummary({
      totalOpen: 5,
      sections: makeSections(["A", "B", "C"]),
    });
    expect(result.headline).toBe("You have 5 open loops.");
  });

  it("produces correct singular headline when totalOpen === 1", async () => {
    const result = await generateSuggestedSummary({
      totalOpen: 1,
      sections: makeSections(["Only one"]),
    });
    expect(result.headline).toBe("You have 1 open loop.");
  });

  it("returns first ≤3 row summaries verbatim as bullets", async () => {
    const result = await generateSuggestedSummary({
      totalOpen: 3,
      sections: makeSections(["Alpha", "Beta", "Gamma"]),
    });
    expect(result.bullets).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("with >3 rows only returns the first 3 summaries", async () => {
    const result = await generateSuggestedSummary({
      totalOpen: 10,
      sections: makeSections(["One", "Two", "Three", "Four", "Five"]),
    });
    expect(result.bullets).toEqual(["One", "Two", "Three"]);
  });

  it("with 0 rows bullets is empty array", async () => {
    const result = await generateSuggestedSummary({
      totalOpen: 0,
      sections: makeSections([]),
    });
    expect(result.bullets).toEqual([]);
  });

  it("gathers topSummaries across multiple sections in order", async () => {
    const result = await generateSuggestedSummary({
      totalOpen: 3,
      sections: [
        { rows: [{ loop: { summary: "First" } }] },
        { rows: [{ loop: { summary: "Second" } }] },
        { rows: [{ loop: { summary: "Third" } }] },
      ],
    });
    expect(result.bullets).toEqual(["First", "Second", "Third"]);
  });

  // ── Model path: injected generateSummary ─────────────────────────────────────

  it("model path: extracts ONLY headline+bullets, drops extra fields", async () => {
    const injected = async () =>
      ({
        headline: "H",
        bullets: ["a", "b"],
        extra: "DROP",
        loops: [{}],
      } as any);

    const result = await generateSuggestedSummary({
      totalOpen: 2,
      sections: makeSections(["X", "Y"]),
      useModel: true,
      generateSummary: injected,
    });

    expect(result).toEqual({ headline: "H", bullets: ["a", "b"] });

    // The model boundary: these keys MUST NOT appear on the result
    expect(Object.keys(result)).not.toContain("extra");
    expect(Object.keys(result)).not.toContain("loops");

    // The result has ONLY headline + bullets
    expect(Object.keys(result).sort()).toEqual(["bullets", "headline"]);
  });

  it("model returns null → deterministic fallback", async () => {
    const injected = async () => null;

    const result = await generateSuggestedSummary({
      totalOpen: 3,
      sections: makeSections(["P", "Q", "R"]),
      useModel: true,
      generateSummary: injected,
    });

    expect(result.headline).toBe("You have 3 open loops.");
    expect(result.bullets).toEqual(["P", "Q", "R"]);
  });

  it("model returns >3 bullets → sliced to 3", async () => {
    const injected = async () => ({
      headline: "Many things",
      bullets: ["a", "b", "c", "d", "e"],
    });

    const result = await generateSuggestedSummary({
      totalOpen: 5,
      sections: makeSections(["X", "Y", "Z"]),
      useModel: true,
      generateSummary: injected,
    });

    expect(result.bullets).toEqual(["a", "b", "c"]);
    expect(result.bullets).toHaveLength(3);
  });

  it("model returns empty bullets → falls back to topSummaries", async () => {
    const injected = async () => ({
      headline: "Summary headline",
      bullets: [],
    });

    const result = await generateSuggestedSummary({
      totalOpen: 2,
      sections: makeSections(["Alpha", "Beta"]),
      useModel: true,
      generateSummary: injected,
    });

    expect(result.bullets).toEqual(["Alpha", "Beta"]);
  });

  it("model returns empty/missing headline → deterministic headline used", async () => {
    const injected = async () => ({
      headline: "",
      bullets: ["a"],
    });

    const result = await generateSuggestedSummary({
      totalOpen: 4,
      sections: makeSections(["Thing"]),
      useModel: true,
      generateSummary: injected,
    });

    expect(result.headline).toBe("You have 4 open loops.");
    expect(result.bullets).toEqual(["a"]);
  });

  it("model throws → deterministic fallback", async () => {
    const injected = async (): Promise<{ headline: string; bullets: string[] }> => {
      throw new Error("model unavailable");
    };

    const result = await generateSuggestedSummary({
      totalOpen: 2,
      sections: makeSections(["Foo", "Bar"]),
      useModel: true,
      generateSummary: injected,
    });

    expect(result.headline).toBe("You have 2 open loops.");
    expect(result.bullets).toEqual(["Foo", "Bar"]);
  });
});
