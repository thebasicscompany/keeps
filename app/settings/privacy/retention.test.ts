/**
 * app/settings/privacy/retention.test.ts
 *
 * Pure unit tests for the retention select-value <-> column mapping.
 * No DB, no Clerk, no React — runs in plain Node vitest env.
 */

import { describe, expect, it } from "vitest";
import {
  RETENTION_OPTIONS,
  selectValueToDays,
  daysToSelectValue,
} from "./retention";

// ---------------------------------------------------------------------------
// RETENTION_OPTIONS shape invariants
// ---------------------------------------------------------------------------

describe("RETENTION_OPTIONS", () => {
  it("contains exactly 4 options", () => {
    expect(RETENTION_OPTIONS).toHaveLength(4);
  });

  it("has unique selectValue keys", () => {
    const keys = RETENTION_OPTIONS.map((o) => o.selectValue);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a 'null' selectValue entry with days === null", () => {
    const nullOption = RETENTION_OPTIONS.find((o) => o.selectValue === "null");
    expect(nullOption).toBeDefined();
    expect(nullOption!.days).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectValueToDays — label → column
// ---------------------------------------------------------------------------

describe("selectValueToDays", () => {
  it("maps '30' to 30", () => {
    expect(selectValueToDays("30")).toBe(30);
  });

  it("maps '90' to 90", () => {
    expect(selectValueToDays("90")).toBe(90);
  });

  it("maps '365' to 365", () => {
    expect(selectValueToDays("365")).toBe(365);
  });

  it("maps 'null' to null (until I delete)", () => {
    expect(selectValueToDays("null")).toBeNull();
  });

  it("falls back to null for an unknown value", () => {
    expect(selectValueToDays("unknown")).toBeNull();
  });

  it("falls back to null for an empty string", () => {
    expect(selectValueToDays("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// daysToSelectValue — column → label
// ---------------------------------------------------------------------------

describe("daysToSelectValue", () => {
  it("maps 30 to '30'", () => {
    expect(daysToSelectValue(30)).toBe("30");
  });

  it("maps 90 to '90'", () => {
    expect(daysToSelectValue(90)).toBe("90");
  });

  it("maps 365 to '365'", () => {
    expect(daysToSelectValue(365)).toBe("365");
  });

  it("maps null to 'null' (until I delete)", () => {
    expect(daysToSelectValue(null)).toBe("null");
  });

  it("falls back to '30' for an unrecognised day count", () => {
    expect(daysToSelectValue(999)).toBe("30");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: selectValueToDays ∘ daysToSelectValue = identity
// ---------------------------------------------------------------------------

describe("round-trip consistency", () => {
  for (const { selectValue, days, label } of RETENTION_OPTIONS) {
    it(`${label}: days→select→days is stable`, () => {
      const sv = daysToSelectValue(days);
      expect(sv).toBe(selectValue);
      const d = selectValueToDays(sv);
      expect(d).toBe(days);
    });
  }
});
