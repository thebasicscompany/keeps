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

  it.each(["pending", "rejected", "expired", "cancelled"] as const)(
    "denies an external action when the approval is %s (not a re-ask)",
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
