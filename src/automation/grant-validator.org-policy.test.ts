import { describe, it, expect } from "vitest";
import {
  validateGrantWithinOrgPolicy,
  type OrgPolicyEnvelope,
} from "@/automation/grant-validator";
import { selfOnlyScope, type ViewerScope } from "@/visibility/can-view";
import type { KeepsActionKind } from "@/policy/actions";

const ORG = "org-1";
function granter(over: Partial<ViewerScope> = {}): ViewerScope {
  return { ...selfOnlyScope("granter", ORG), ...over };
}

const envelope: OrgPolicyEnvelope = {
  allowedRecipeKeys: ["stale_loop_followup", "pre_meeting_brief"],
  perRoleAllowedRecipeKeys: { member: ["pre_meeting_brief"] },
  forbiddenActionKinds: ["create_calendar_event"],
};

describe("validateGrantWithinOrgPolicy (two-tier grants)", () => {
  it("permits a recipe inside the org envelope", () => {
    const r = validateGrantWithinOrgPolicy({
      grant: { recipeKey: "stale_loop_followup", allowedActionKinds: ["send_private_email_to_user"], scope: {} },
      envelope,
      granterScope: granter(),
    });
    expect(r.valid).toBe(true);
  });

  it("denies a recipe the org does not permit", () => {
    const r = validateGrantWithinOrgPolicy({
      grant: { recipeKey: "post_meeting_prompt", allowedActionKinds: [], scope: {} },
      envelope,
      granterScope: granter(),
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("not permitted by org policy");
  });

  it("per-role allowlist overrides the org default", () => {
    // 'member' may only use pre_meeting_brief, even though the org default allows stale_loop_followup.
    const r = validateGrantWithinOrgPolicy({
      grant: { recipeKey: "stale_loop_followup", allowedActionKinds: [], scope: {} },
      envelope,
      granterScope: granter(),
      role: "member",
    });
    expect(r.valid).toBe(false);
  });

  it("denies a forbidden action kind (never-auto-act data class)", () => {
    const r = validateGrantWithinOrgPolicy({
      grant: {
        recipeKey: "stale_loop_followup",
        allowedActionKinds: ["create_calendar_event"] as KeepsActionKind[],
        scope: {},
      },
      envelope,
      granterScope: granter(),
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("forbidden by org policy"))).toBe(true);
  });

  it("can't grant a scope the granter can't see; org admin or a scope member can", () => {
    const targetingAcme = {
      recipeKey: "stale_loop_followup",
      allowedActionKinds: ["send_private_email_to_user"] as KeepsActionKind[],
      scope: { scopeId: "acme" },
    };
    expect(validateGrantWithinOrgPolicy({ grant: targetingAcme, envelope, granterScope: granter() }).valid).toBe(
      false,
    );
    expect(
      validateGrantWithinOrgPolicy({
        grant: targetingAcme,
        envelope,
        granterScope: granter({ scopeIds: new Set(["acme"]) }),
      }).valid,
    ).toBe(true);
    expect(
      validateGrantWithinOrgPolicy({
        grant: targetingAcme,
        envelope,
        granterScope: granter({ isOrgAdmin: true }),
      }).valid,
    ).toBe(true);
  });
});
