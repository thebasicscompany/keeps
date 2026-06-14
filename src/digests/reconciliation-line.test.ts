/**
 * Unit tests for the Phase 7 AR-9 auto-reconciliation line in the digest.
 *
 * Verifies that:
 *   - When autoReconciled is absent the line is NOT rendered (no regression).
 *   - When autoReconciled is present the correct text appears in both text + HTML.
 *   - Pluralisation works correctly.
 *   - Zero counts produce no line (degenerate case).
 */

import { describe, it, expect } from "vitest";
import { buildDigest } from "@/digests/build";
import { renderDigestEmail } from "@/digests/render";
import type { DigestUserInput } from "@/digests/build";

const USER: DigestUserInput = { id: "u-1", email: "test@example.com" };
const NOW = new Date("2026-06-14T09:00:00Z");

// Minimal digest with no loops (ensures the reconciliation line is the only
// variable between tests).
function buildEmpty(autoReconciled?: { advanced: number; closed: number }) {
  const model = buildDigest({ user: USER, loops: [], now: NOW, autoReconciled });
  return renderDigestEmail(model);
}

describe("digest reconciliation line — absent when not provided", () => {
  it("does not include the 🔁 line when autoReconciled is omitted", () => {
    const { textBody, htmlBody } = buildEmpty(undefined);
    expect(textBody).not.toContain("🔁");
    expect(htmlBody).not.toContain("🔁");
  });

  it("does not include 'automatically from replies' when autoReconciled is omitted", () => {
    const { textBody } = buildEmpty(undefined);
    expect(textBody).not.toContain("automatically from replies");
  });
});

describe("digest reconciliation line — present when provided", () => {
  it("renders both advanced and closed counts in text body", () => {
    const { textBody } = buildEmpty({ advanced: 2, closed: 1 });
    expect(textBody).toContain("🔁");
    expect(textBody).toContain("2 loops advanced");
    expect(textBody).toContain("1 closed");
    expect(textBody).toContain("automatically from replies.");
  });

  it("renders the line in the HTML body too", () => {
    const { htmlBody } = buildEmpty({ advanced: 2, closed: 1 });
    expect(htmlBody).toContain("🔁");
    expect(htmlBody).toContain("automatically from replies.");
  });

  it("renders only advanced when closed is 0", () => {
    const { textBody } = buildEmpty({ advanced: 3, closed: 0 });
    expect(textBody).toContain("3 loops advanced");
    expect(textBody).not.toContain("0 closed");
  });

  it("renders only closed when advanced is 0", () => {
    const { textBody } = buildEmpty({ advanced: 0, closed: 2 });
    expect(textBody).toContain("2 closed");
    expect(textBody).not.toContain("0 loops advanced");
  });

  it("singular 'loop' when advanced is 1", () => {
    const { textBody } = buildEmpty({ advanced: 1, closed: 0 });
    expect(textBody).toContain("1 loop advanced");
    expect(textBody).not.toContain("1 loops advanced");
  });

  it("plural 'loops' when advanced > 1", () => {
    const { textBody } = buildEmpty({ advanced: 2, closed: 0 });
    expect(textBody).toContain("2 loops advanced");
  });

  it("produces no line when both counts are 0", () => {
    const { textBody, htmlBody } = buildEmpty({ advanced: 0, closed: 0 });
    expect(textBody).not.toContain("🔁");
    expect(htmlBody).not.toContain("🔁");
  });
});

describe("digest reconciliation line — existing tests unaffected", () => {
  it("model without autoReconciled still has all standard fields", () => {
    const model = buildDigest({ user: USER, loops: [], now: NOW });
    expect(model.autoReconciled).toBeUndefined();
    expect(model.totalActiveLoops).toBe(0);
    expect(model.needsAttention).toEqual([]);
  });

  it("buildDigest passes autoReconciled through to model", () => {
    const model = buildDigest({
      user: USER,
      loops: [],
      now: NOW,
      autoReconciled: { advanced: 1, closed: 2 },
    });
    expect(model.autoReconciled).toEqual({ advanced: 1, closed: 2 });
  });
});
