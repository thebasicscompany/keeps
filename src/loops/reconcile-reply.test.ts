import { describe, expect, it } from "vitest";
import { parseReconcileConfirmReply } from "@/loops/reconcile-reply";

/**
 * Phase 7 B2c — the YES/NO parser for suppressed-duplicate reconciliation asks. 'same'
 * (merge), 'different' (keep separate), null (not a recognizable answer → caller falls
 * through to normal intent handling so a real loop command is never hijacked).
 */
describe("parseReconcileConfirmReply", () => {
  it("maps affirmative answers to 'same'", () => {
    for (const text of ["yes", "Yes", "YES", "y", "yep", "yeah", "yup", "same", "merge", "correct"]) {
      expect(parseReconcileConfirmReply(text)).toBe("same");
    }
  });

  it("maps negative answers to 'different'", () => {
    for (const text of ["no", "No", "NO", "n", "nope", "nah", "different", "separate", "keep separate"]) {
      expect(parseReconcileConfirmReply(text)).toBe("different");
    }
  });

  it("tolerates surrounding whitespace and trailing punctuation", () => {
    expect(parseReconcileConfirmReply("  yes!  ")).toBe("same");
    expect(parseReconcileConfirmReply("no.")).toBe("different");
    expect(parseReconcileConfirmReply("the same")).toBe("same");
    expect(parseReconcileConfirmReply("not the same")).toBe("different");
  });

  it("returns null for anything that is not a clear YES/NO", () => {
    for (const text of ["", "   ", "done 1", "dismiss 2", "maybe", "what?", "yes please merge them all"]) {
      expect(parseReconcileConfirmReply(text)).toBeNull();
    }
  });
});
