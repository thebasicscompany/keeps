import { describe, expect, it } from "vitest";
import {
  assertApprovalAllowed,
  authorize,
  requiresApproval,
  type AuthorizationContext,
} from "@/policy/actions";

const NOW = new Date("2026-06-12T12:00:00.000Z");
const FUTURE = new Date("2026-06-12T13:00:00.000Z");
const PAST = new Date("2026-06-12T11:00:00.000Z");

function ctx(
  approval?: AuthorizationContext["approval"],
): AuthorizationContext {
  return { userId: "user-1", approval };
}

describe("requiresApproval (back-compat)", () => {
  it("flags external actions and clears private ones", () => {
    expect(requiresApproval("send_slack_message")).toBe(true);
    expect(requiresApproval("send_email")).toBe(true);
    expect(requiresApproval("create_private_loop")).toBe(false);
  });
});

describe("authorize", () => {
  it("allows a private action with no approval", () => {
    expect(authorize("create_private_loop", ctx(), { now: NOW })).toEqual({
      result: "allowed",
    });
  });

  it("requires approval for an external action with no approval context", () => {
    expect(authorize("send_slack_message", ctx(), { now: NOW })).toEqual({
      result: "needs_approval",
    });
  });

  it("allows an external action with a valid approved approval", () => {
    const decision = authorize(
      "send_email",
      ctx({ id: "a1", status: "approved", expiresAt: FUTURE }),
      { now: NOW },
    );
    expect(decision).toEqual({ result: "allowed" });
  });

  it("returns needs_approval for an external action when the approval is pending (in-flight, not terminal)", () => {
    const decision = authorize(
      "send_email",
      ctx({ id: "a1", status: "pending", expiresAt: FUTURE }),
      { now: NOW },
    );
    expect(decision.result).toBe("needs_approval");
    expect(decision.reason).toContain("pending");
  });

  it.each(["rejected", "expired", "cancelled"] as const)(
    "denies an external action when the approval is %s (terminal, not a re-ask)",
    (status) => {
      const decision = authorize(
        "send_email",
        ctx({ id: "a1", status, expiresAt: FUTURE }),
        { now: NOW },
      );
      expect(decision.result).toBe("denied");
      expect(decision.reason).toContain(status);
    },
  );

  it("denies an approved-but-expired approval (stale grant must not authorize)", () => {
    const decision = authorize(
      "send_email",
      ctx({ id: "a1", status: "approved", expiresAt: PAST }),
      { now: NOW },
    );
    expect(decision.result).toBe("denied");
    expect(decision.reason).toContain("expired");
  });

  it("denies an approved approval whose expiry exactly equals now (<= is stale)", () => {
    const decision = authorize(
      "send_email",
      ctx({ id: "a1", status: "approved", expiresAt: NOW }),
      { now: NOW },
    );
    expect(decision.result).toBe("denied");
  });

  it("treats an unrecognized action kind as external (fail closed)", () => {
    // No approval → needs_approval (not allowed).
    expect(
      authorize("test_action" as never, ctx(), { now: NOW }).result,
    ).toBe("needs_approval");
    // Valid approved approval → allowed.
    expect(
      authorize(
        "test_action" as never,
        ctx({ id: "a1", status: "approved", expiresAt: FUTURE }),
        { now: NOW },
      ),
    ).toEqual({ result: "allowed" });
  });
});

describe("assertApprovalAllowed (back-compat)", () => {
  it("throws for an external action without an approvalId", () => {
    expect(() => assertApprovalAllowed("send_slack_message")).toThrow(
      /requires an approval_request/,
    );
  });

  it("passes for an external action when an approvalId is supplied", () => {
    expect(() => assertApprovalAllowed("send_slack_message", "approval-1")).not.toThrow();
  });

  it("passes for a private action with or without an approvalId", () => {
    expect(() => assertApprovalAllowed("create_private_loop")).not.toThrow();
    expect(() => assertApprovalAllowed("create_private_loop", "approval-1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Deliverable #7 — full truth table (AR-7)
// Exercises send_slack_message (external) and create_private_loop (private)
// across every approval state including expiry boundary conditions.
// ---------------------------------------------------------------------------

describe("Phase 4 AR-7 truth table — send_slack_message (external action)", () => {
  it("approved + unexpired → allowed", () => {
    expect(
      authorize("send_slack_message", ctx({ id: "ap1", status: "approved", expiresAt: FUTURE }), { now: NOW }),
    ).toEqual({ result: "allowed" });
  });

  it("no approval → needs_approval", () => {
    expect(
      authorize("send_slack_message", ctx(), { now: NOW }),
    ).toEqual({ result: "needs_approval" });
  });

  it("pending → needs_approval (in-flight approval, not a terminal denial)", () => {
    const d = authorize(
      "send_slack_message",
      ctx({ id: "ap1", status: "pending", expiresAt: FUTURE }),
      { now: NOW },
    );
    expect(d.result).toBe("needs_approval");
    expect(d.reason).toContain("pending");
  });

  it("rejected → denied", () => {
    const d = authorize(
      "send_slack_message",
      ctx({ id: "ap1", status: "rejected", expiresAt: FUTURE }),
      { now: NOW },
    );
    expect(d.result).toBe("denied");
    expect(d.reason).toContain("rejected");
  });

  it("expired (status=expired) → denied", () => {
    const d = authorize(
      "send_slack_message",
      ctx({ id: "ap1", status: "expired", expiresAt: FUTURE }),
      { now: NOW },
    );
    expect(d.result).toBe("denied");
    expect(d.reason).toContain("expired");
  });

  it("cancelled → denied", () => {
    const d = authorize(
      "send_slack_message",
      ctx({ id: "ap1", status: "cancelled", expiresAt: FUTURE }),
      { now: NOW },
    );
    expect(d.result).toBe("denied");
    expect(d.reason).toContain("cancelled");
  });

  it("approved but expiresAt < now → denied (stale grant)", () => {
    const d = authorize(
      "send_slack_message",
      ctx({ id: "ap1", status: "approved", expiresAt: PAST }),
      { now: NOW },
    );
    expect(d.result).toBe("denied");
    expect(d.reason).toContain("expired");
  });

  it("approved but expiresAt === now → denied (boundary: <= is stale)", () => {
    const d = authorize(
      "send_slack_message",
      ctx({ id: "ap1", status: "approved", expiresAt: NOW }),
      { now: NOW },
    );
    expect(d.result).toBe("denied");
  });
});

describe("Phase 4 AR-7 truth table — create_private_loop (private action)", () => {
  it("no approval → allowed (private actions never require approval)", () => {
    expect(
      authorize("create_private_loop", ctx(), { now: NOW }),
    ).toEqual({ result: "allowed" });
  });

  it("approved + unexpired → allowed (approval is irrelevant for private)", () => {
    expect(
      authorize("create_private_loop", ctx({ id: "ap1", status: "approved", expiresAt: FUTURE }), { now: NOW }),
    ).toEqual({ result: "allowed" });
  });

  it("pending → allowed (private; approval context is ignored)", () => {
    expect(
      authorize("create_private_loop", ctx({ id: "ap1", status: "pending", expiresAt: FUTURE }), { now: NOW }),
    ).toEqual({ result: "allowed" });
  });

  it("rejected → allowed (private; approval context is ignored)", () => {
    expect(
      authorize("create_private_loop", ctx({ id: "ap1", status: "rejected", expiresAt: FUTURE }), { now: NOW }),
    ).toEqual({ result: "allowed" });
  });
});

describe("Phase 4 AR-7 truth table — requiresApproval shim", () => {
  it("returns true for an external action (send_slack_message)", () => {
    expect(requiresApproval("send_slack_message")).toBe(true);
  });

  it("returns false for a private action (create_private_loop)", () => {
    expect(requiresApproval("create_private_loop")).toBe(false);
  });
});
