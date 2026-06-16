import { describe, it, expect } from "vitest";
import { grantRowToContext } from "@/automation/run-repository";
import type { StandingGrant } from "@/db/schema";

function row(over: Partial<StandingGrant> = {}): StandingGrant {
  return {
    id: "g1",
    userId: "u1",
    recipeKey: "stale_loop_followup",
    status: "active",
    scope: { staleDays: 7 },
    allowedActionKinds: ["send_private_email_to_user", "create_private_report"],
    blockedActionKinds: ["send_email", "share_loop", "reveal_source"],
    constraints: {},
    caps: { create_private_report: { limit: 5, window: "day" } },
    quietHours: {},
    createdFromApprovalRequestId: null,
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date("2026-06-15T00:00:00Z"),
    updatedAt: new Date("2026-06-15T00:00:00Z"),
    ...over,
  } as StandingGrant;
}

describe("grantRowToContext", () => {
  it("maps a grant row into the policy context (no capUsage/zone — executor adds those)", () => {
    const ctx = grantRowToContext(row());
    expect(ctx.recipeKey).toBe("stale_loop_followup");
    expect(ctx.status).toBe("active");
    expect(ctx.allowedActionKinds).toContain("create_private_report");
    expect(ctx.blockedActionKinds).toContain("send_email");
    expect(ctx.caps?.create_private_report?.limit).toBe(5);
    expect(ctx.scope).toEqual({ staleDays: 7 });
    expect(ctx.expiresAt?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(ctx.capUsage).toBeUndefined();
    expect(ctx.targetZone).toBeUndefined();
  });

  it("defaults null/absent jsonb arrays to empty", () => {
    const ctx = grantRowToContext(
      row({ allowedActionKinds: [] as unknown as StandingGrant["allowedActionKinds"], caps: {}, scope: {} }),
    );
    expect(ctx.allowedActionKinds).toEqual([]);
    expect(ctx.caps).toEqual({});
    expect(ctx.scope).toEqual({});
  });
});
