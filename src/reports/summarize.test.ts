import { describe, expect, it } from "vitest";
import {
  generateEntityStatusSummary,
  generateSuggestedSummary,
  type SummarizeInput,
} from "./summarize";
import type { EntityReportLoop, EntityReportSlice } from "@/reports/query";

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

// ── Phase 5 live-wave fix: never call the model with empty top-items ───────────

describe("empty top-items guard (live-wave regression)", () => {
  it("does NOT invoke the model when there are no top summaries, even with useModel", async () => {
    let called = false;
    const result = await generateSuggestedSummary({
      totalOpen: 1,
      sections: [{ rows: [] }, { rows: [] }],
      useModel: true,
      generateSummary: async () => {
        called = true;
        return { headline: "HALLUCINATED", bullets: ["1. Top items: [no additional details provided]"] };
      },
    });
    expect(called).toBe(false); // model never reached → no hallucination
    expect(result.headline).toBe("You have 1 open loop.");
    expect(result.bullets).toEqual([]);
  });
});

// ── Phase 7 C1: entity status synthesis (deterministic fallback) ───────────────

function makeEntityLoop(o: Partial<EntityReportLoop> & { id: string }): EntityReportLoop {
  return {
    id: o.id,
    status: o.status ?? "open",
    summary: o.summary ?? `Summary ${o.id}`,
    dueAtIso: o.dueAtIso ?? null,
    confidence: o.confidence ?? 0.8,
    roles: o.roles ?? ["owner"],
    emailThreadId: o.emailThreadId ?? `thread-${o.id}`,
    createdAtIso: o.createdAtIso ?? "2026-06-01T00:00:00.000Z",
    updatedAtIso: o.updatedAtIso ?? "2026-06-10T00:00:00.000Z",
  };
}

function makeSlice(o: {
  displayName?: string;
  openLoops?: EntityReportLoop[];
  closedLoops?: EntityReportLoop[];
}): EntityReportSlice {
  const openLoops = o.openLoops ?? [];
  const closedLoops = o.closedLoops ?? [];
  return {
    entity: {
      id: "ent-1",
      displayName: o.displayName ?? "Dana Client",
      kind: "person",
      canonicalEmail: "dana@example.com",
      firstSeenAtIso: "2026-05-01T00:00:00.000Z",
      lastSeenAtIso: "2026-06-12T00:00:00.000Z",
    },
    openLoops,
    closedLoops,
    openCount: openLoops.length,
    closedCount: closedLoops.length,
    threadCount: new Set([...openLoops, ...closedLoops].map((l) => l.emailThreadId)).size,
    mostRecentThreadId: openLoops[0]?.emailThreadId ?? closedLoops[0]?.emailThreadId ?? null,
    recentEvents: [],
  };
}

describe("generateEntityStatusSummary (deterministic fallback, no creds)", () => {
  it("produces a structured status headline with counts + latest open loop", async () => {
    const slice = makeSlice({
      displayName: "Dana Client",
      openLoops: [
        makeEntityLoop({ id: "o1", summary: "Send the revised proposal", roles: ["owner"] }),
      ],
      closedLoops: [makeEntityLoop({ id: "c1", status: "done", summary: "Kickoff done" })],
    });

    const result = await generateEntityStatusSummary({ slice });

    expect(result.openCount).toBe(1);
    expect(result.closedCount).toBe(1);
    expect(result.headline).toBe(
      "Dana Client: 1 open, 1 closed; latest: Send the revised proposal.",
    );
  });

  it("classifies 'ball in your court' when an open loop the entity owns / awaits the user", async () => {
    const slice = makeSlice({
      openLoops: [makeEntityLoop({ id: "o1", status: "waiting_on_me", roles: ["requester"] })],
    });
    const result = await generateEntityStatusSummary({ slice });
    expect(result.state).toBe("ball in your court");
  });

  it("classifies 'waiting on them' when all open loops await the other side", async () => {
    const slice = makeSlice({
      openLoops: [
        makeEntityLoop({ id: "o1", status: "waiting_on_other", roles: ["participant"] }),
      ],
    });
    const result = await generateEntityStatusSummary({ slice });
    expect(result.state).toBe("waiting on them");
  });

  it("classifies 'mostly done' when there are no open loops but some closed", async () => {
    const slice = makeSlice({
      closedLoops: [makeEntityLoop({ id: "c1", status: "done", summary: "All wrapped up" })],
    });
    const result = await generateEntityStatusSummary({ slice });
    expect(result.state).toBe("mostly done");
    expect(result.headline).toBe("Dana Client: 0 open, 1 closed; latest: All wrapped up.");
  });

  it("classifies 'no open items' for an entity with no loops at all", async () => {
    const slice = makeSlice({});
    const result = await generateEntityStatusSummary({ slice });
    expect(result.state).toBe("no open items");
    expect(result.headline).toBe("Dana Client: 0 open, 0 closed.");
  });

  it("model path: reads ONLY headline+state, counts stay deterministic", async () => {
    const slice = makeSlice({
      openLoops: [makeEntityLoop({ id: "o1", summary: "Proposal" })],
    });
    const result = await generateEntityStatusSummary({
      slice,
      useModel: true,
      generateStatus: async () =>
        ({ headline: "Dana is awaiting your proposal.", state: "ball in your court", extra: "DROP" } as any),
    });
    expect(result.headline).toBe("Dana is awaiting your proposal.");
    expect(result.state).toBe("ball in your court");
    expect(result.openCount).toBe(1); // never model-authored
    expect(Object.keys(result).sort()).toEqual(["closedCount", "headline", "openCount", "state"]);
  });

  it("model returns null → deterministic fallback", async () => {
    const slice = makeSlice({ openLoops: [makeEntityLoop({ id: "o1", summary: "Thing" })] });
    const result = await generateEntityStatusSummary({
      slice,
      useModel: true,
      generateStatus: async () => null,
    });
    expect(result.headline).toBe("Dana Client: 1 open, 0 closed; latest: Thing.");
  });

  it("model throws → deterministic fallback", async () => {
    const slice = makeSlice({ openLoops: [makeEntityLoop({ id: "o1", summary: "Thing" })] });
    const result = await generateEntityStatusSummary({
      slice,
      useModel: true,
      generateStatus: async () => {
        throw new Error("model down");
      },
    });
    expect(result.headline).toBe("Dana Client: 1 open, 0 closed; latest: Thing.");
  });

  it("does NOT invoke the model for an entity with zero loops", async () => {
    let called = false;
    const result = await generateEntityStatusSummary({
      slice: makeSlice({}),
      useModel: true,
      generateStatus: async () => {
        called = true;
        return { headline: "HALLUCINATED", state: "stalled" };
      },
    });
    expect(called).toBe(false);
    expect(result.headline).toBe("Dana Client: 0 open, 0 closed.");
  });
});
