import { describe, expect, it } from "vitest";
import { parseApprovalReplyCommand } from "@/approvals/commands";

describe("parseApprovalReplyCommand — canonical commands", () => {
  it('parses "approve"', () => {
    expect(parseApprovalReplyCommand("approve")).toMatchObject({
      type: "approve",
      rawText: "approve",
    });
  });

  it('parses "approve all"', () => {
    expect(parseApprovalReplyCommand("approve all")).toMatchObject({
      type: "approve_all",
      rawText: "approve all",
    });
  });

  it('parses "reject" (no ordinal)', () => {
    expect(parseApprovalReplyCommand("reject")).toMatchObject({
      type: "reject",
      rawText: "reject",
      loopOrdinal: null,
    });
  });

  it('parses "reject 1" with ordinal', () => {
    expect(parseApprovalReplyCommand("reject 1")).toMatchObject({
      type: "reject",
      rawText: "reject 1",
      loopOrdinal: 1,
    });
  });

  it('parses "reject 5" with a larger ordinal', () => {
    expect(parseApprovalReplyCommand("reject 5")).toMatchObject({
      type: "reject",
      rawText: "reject 5",
      loopOrdinal: 5,
    });
  });

  it('parses "cancel"', () => {
    expect(parseApprovalReplyCommand("cancel")).toMatchObject({
      type: "cancel",
      rawText: "cancel",
    });
  });

  it('parses "edit: <payload>"', () => {
    expect(parseApprovalReplyCommand("edit: please change the subject line")).toMatchObject({
      type: "edit",
      rawText: "edit: please change the subject line",
      payloadText: "please change the subject line",
    });
  });

  it('parses "edit:" with no payload as payloadText null', () => {
    expect(parseApprovalReplyCommand("edit:")).toMatchObject({
      type: "edit",
      payloadText: null,
    });
  });

  it('parses "edit: " (whitespace-only after colon) as payloadText null', () => {
    expect(parseApprovalReplyCommand("edit:   ")).toMatchObject({
      type: "edit",
      payloadText: null,
    });
  });
});

describe("parseApprovalReplyCommand — ordinal variants", () => {
  it("parses reject with ordinal 12", () => {
    expect(parseApprovalReplyCommand("reject 12")).toMatchObject({
      type: "reject",
      loopOrdinal: 12,
    });
  });

  it("parses reject ordinal regardless of trailing punctuation after the word boundary", () => {
    // "reject 3 please" — the \\b after \\d+ still matches; ordinal is 3
    expect(parseApprovalReplyCommand("reject 3 please")).toMatchObject({
      type: "reject",
      loopOrdinal: 3,
    });
  });
});

describe("parseApprovalReplyCommand — whitespace and case insensitivity", () => {
  it("strips leading and trailing whitespace from rawText", () => {
    const result = parseApprovalReplyCommand("  approve  ");

    expect(result.rawText).toBe("approve");
    expect(result.type).toBe("approve");
  });

  it("handles APPROVE (uppercase)", () => {
    expect(parseApprovalReplyCommand("APPROVE").type).toBe("approve");
  });

  it("handles Approve All (mixed case)", () => {
    expect(parseApprovalReplyCommand("Approve All").type).toBe("approve_all");
  });

  it("handles REJECT 2 (uppercase with ordinal)", () => {
    const result = parseApprovalReplyCommand("REJECT 2");

    expect(result.type).toBe("reject");
    if (result.type === "reject") {
      expect(result.loopOrdinal).toBe(2);
    }
  });

  it("handles CANCEL (uppercase)", () => {
    expect(parseApprovalReplyCommand("CANCEL").type).toBe("cancel");
  });

  it("handles EDIT: payload (uppercase)", () => {
    const result = parseApprovalReplyCommand("EDIT: uppercase payload");

    expect(result.type).toBe("edit");
    if (result.type === "edit") {
      expect(result.payloadText).toBe("uppercase payload");
    }
  });

  it("handles leading whitespace before a command", () => {
    expect(parseApprovalReplyCommand("\t  reject  ").type).toBe("reject");
  });
});

describe("parseApprovalReplyCommand — ambiguous cases", () => {
  // "approved!" — starts with "approve" but has trailing "d!"; the regex /^approve\b/ matches
  // because \b is a word boundary between 'e' and 'd' only if 'd' is not a word char — but 'd' IS
  // a word char. So "approvED" does NOT match /^approve\b/ → unknown. Verdict: unknown.
  it('"approved!" is unknown (not a bare approve command)', () => {
    expect(parseApprovalReplyCommand("approved!").type).toBe("unknown");
  });

  // "approve 2 all" — starts "approve" then has a number then "all". The regex checks
  // /^approve\s+all\b/ first, which fails ("2" is not "all"). Then /^approve\b/ matches.
  // Verdict: approve (ordinal and trailing "all" are ignored).
  it('"approve 2 all" resolves to approve (not approve_all; ordinal not supported)', () => {
    expect(parseApprovalReplyCommand("approve 2 all").type).toBe("approve");
  });

  // "rejection letter" — starts with "reject" followed by "ion". /^reject\b/ fails because "ion"
  // follows immediately without a word boundary between 't' and 'i'.
  // Verdict: unknown.
  it('"rejection letter" is unknown (not a reject command)', () => {
    expect(parseApprovalReplyCommand("rejection letter").type).toBe("unknown");
  });

  // "cancel order" — /^cancel\b/ matches at the word boundary after "cancel".
  // Verdict: cancel (extra text after the word boundary is ignored by this parser).
  it('"cancel order" resolves to cancel (word boundary satisfied)', () => {
    expect(parseApprovalReplyCommand("cancel order").type).toBe("cancel");
  });

  // "cancellation" — /^cancel\b/ fails because "lation" follows without a boundary.
  // Verdict: unknown.
  it('"cancellation" is unknown (not a cancel command)', () => {
    expect(parseApprovalReplyCommand("cancellation").type).toBe("unknown");
  });

  // "edit without colon" — no colon present; the edit regex requires ":".
  // Verdict: unknown.
  it('"edit without colon" is unknown (colon required)', () => {
    expect(parseApprovalReplyCommand("edit without colon").type).toBe("unknown");
  });

  // Empty string → unknown.
  it("empty string is unknown", () => {
    expect(parseApprovalReplyCommand("").type).toBe("unknown");
  });

  // "approve all items" — /^approve\s+all\b/ matches ("items" is beyond the boundary).
  // Verdict: approve_all.
  it('"approve all items" resolves to approve_all', () => {
    expect(parseApprovalReplyCommand("approve all items").type).toBe("approve_all");
  });

  // "reject 0" — ordinal 0 is technically parsed; callers validate meaningful ordinals.
  // Verdict: reject with loopOrdinal 0.
  it('"reject 0" is parsed as reject with ordinal 0 (caller validates range)', () => {
    const result = parseApprovalReplyCommand("reject 0");

    expect(result.type).toBe("reject");
    if (result.type === "reject") {
      expect(result.loopOrdinal).toBe(0);
    }
  });
});

describe("parseApprovalReplyCommand — edit payload variants", () => {
  it("preserves internal whitespace in payloadText", () => {
    const result = parseApprovalReplyCommand("edit:   lots   of   spaces   ");

    expect(result.type).toBe("edit");
    if (result.type === "edit") {
      // trim() collapses leading/trailing but not internal
      expect(result.payloadText).toBe("lots   of   spaces");
    }
  });

  it("preserves newlines in multi-line payload", () => {
    const payload = "line one\nline two\nline three";
    const result = parseApprovalReplyCommand(`edit: ${payload}`);

    expect(result.type).toBe("edit");
    if (result.type === "edit") {
      expect(result.payloadText).toBe(payload);
    }
  });

  it("handles edit with no space before colon", () => {
    // "edit:" — the regex allows optional whitespace before colon
    const result = parseApprovalReplyCommand("edit:payload without space");

    expect(result.type).toBe("edit");
    if (result.type === "edit") {
      expect(result.payloadText).toBe("payload without space");
    }
  });
});

describe("parseApprovalReplyCommand — unknown fallback", () => {
  it("returns unknown for arbitrary text", () => {
    expect(parseApprovalReplyCommand("sounds good to me").type).toBe("unknown");
  });

  it("returns unknown for a number alone", () => {
    expect(parseApprovalReplyCommand("42").type).toBe("unknown");
  });

  it("returns unknown for 'yes'", () => {
    expect(parseApprovalReplyCommand("yes").type).toBe("unknown");
  });

  it("preserves rawText in unknown results", () => {
    const result = parseApprovalReplyCommand("  sure thing  ");

    expect(result.rawText).toBe("sure thing");
    expect(result.type).toBe("unknown");
  });
});

describe("parseApprovalReplyCommand — injected now parameter (clock injection pattern)", () => {
  it("accepts and ignores now without error (future use for time-dependent approval state)", () => {
    const result = parseApprovalReplyCommand("approve", { now: new Date("2026-06-12T09:00:00.000Z") });

    expect(result.type).toBe("approve");
  });
});
