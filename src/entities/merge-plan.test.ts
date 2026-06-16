import { describe, it, expect } from "vitest";
import { planEntityMerges, type EntityForMerge } from "@/entities/merge-plan";

function person(over: Partial<EntityForMerge>): EntityForMerge {
  return {
    id: "x",
    kind: "person",
    canonicalEmail: null,
    domain: null,
    mergedIntoEntityId: null,
    firstSeenAtMs: 0,
    ...over,
  };
}

describe("planEntityMerges", () => {
  it("merges same-email people into the earliest-seen canonical", () => {
    const plan = planEntityMerges([
      person({ id: "b", canonicalEmail: "jane@acme.com", firstSeenAtMs: 200 }),
      person({ id: "a", canonicalEmail: "jane@acme.com", firstSeenAtMs: 100 }),
      person({ id: "c", canonicalEmail: "jane@acme.com", firstSeenAtMs: 300 }),
    ]);
    expect(plan.canonicalIds).toEqual(["a"]); // earliest firstSeenAt
    expect(plan.remaps.sort((x, y) => (x.from < y.from ? -1 : 1))).toEqual([
      { from: "b", into: "a" },
      { from: "c", into: "a" },
    ]);
    expect(plan.mergedGroupCount).toBe(1);
  });

  it("never name-matches — different emails stay separate even with same display logic", () => {
    const plan = planEntityMerges([
      person({ id: "a", canonicalEmail: "jane@acme.com" }),
      person({ id: "b", canonicalEmail: "jane@beta.com" }),
    ]);
    expect(plan.remaps).toEqual([]);
    expect(plan.canonicalIds.sort()).toEqual(["a", "b"]);
  });

  it("merges companies by domain (case-insensitive); ignores null-key rows", () => {
    const plan = planEntityMerges([
      { id: "a", kind: "company", canonicalEmail: null, domain: "Acme.com", mergedIntoEntityId: null, firstSeenAtMs: 50 },
      { id: "b", kind: "company", canonicalEmail: null, domain: "acme.com", mergedIntoEntityId: null, firstSeenAtMs: 60 },
      { id: "c", kind: "company", canonicalEmail: null, domain: null, mergedIntoEntityId: null, firstSeenAtMs: 70 },
    ]);
    expect(plan.remaps).toEqual([{ from: "b", into: "a" }]);
    expect(plan.canonicalIds).toContain("a");
    expect(plan.canonicalIds).not.toContain("c"); // null domain → no key → not grouped/canonical
  });

  it("leaves already-merged rows untouched", () => {
    const plan = planEntityMerges([
      person({ id: "a", canonicalEmail: "jane@acme.com", firstSeenAtMs: 100 }),
      person({ id: "b", canonicalEmail: "jane@acme.com", firstSeenAtMs: 200, mergedIntoEntityId: "a" }),
    ]);
    expect(plan.remaps).toEqual([]); // b already merged → not re-planned
    expect(plan.mergedGroupCount).toBe(0);
  });

  it("tiebreaks equal firstSeenAt by id (deterministic)", () => {
    const plan = planEntityMerges([
      person({ id: "z", canonicalEmail: "j@acme.com", firstSeenAtMs: 100 }),
      person({ id: "a", canonicalEmail: "j@acme.com", firstSeenAtMs: 100 }),
    ]);
    expect(plan.canonicalIds).toEqual(["a"]);
    expect(plan.remaps).toEqual([{ from: "z", into: "a" }]);
  });
});
