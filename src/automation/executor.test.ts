import { describe, it, expect, vi } from "vitest";
import { executeAutomationRun, type ExecutorEffects } from "@/automation/executor";
import { buildSandboxPlan } from "@/automation/sandbox-plan";
import { defaultGrantForRecipe } from "@/automation/grant-validator";
import type { StandingGrantContext } from "@/automation/types";

function staleGrant(over: Partial<StandingGrantContext> = {}): StandingGrantContext {
  return { ...defaultGrantForRecipe("stale_loop_followup")!, ...over };
}

function plan(actions: Parameters<typeof buildSandboxPlan>[0]["intendedActions"]) {
  return buildSandboxPlan({
    recipeKey: "stale_loop_followup",
    triggerKind: "loop_stale",
    intendedActions: actions,
    provenanceContext: { loopSummary: "Send packet", staleDays: 7 },
  });
}

function effects(over: Partial<ExecutorEffects> = {}): ExecutorEffects {
  return {
    loadFreshGrant: async () => staleGrant(),
    runPrivateAction: async () => ({ ok: true }),
    escalateToApproval: async () => ({ approvalRequestId: "appr-1" }),
    ...over,
  };
}

describe("executeAutomationRun (FR6/FR7/SR3/SR8)", () => {
  it("private action → completed", async () => {
    const runPrivateAction = vi.fn(async () => ({ reportId: "r1" }));
    const res = await executeAutomationRun({
      userId: "u1",
      plan: plan([{ kind: "create_private_report", target: { loopId: "l1" } }]),
      effects: effects({ runPrivateAction }),
    });
    expect(res.terminal).toBe("completed");
    expect(res.outcomes[0].status).toBe("completed");
    expect(runPrivateAction).toHaveBeenCalledOnce();
  });

  it("Slack send → needs_approval, never auto-runs the private effect (SR8/FR7)", async () => {
    const runPrivateAction = vi.fn(async () => ({}));
    const escalateToApproval = vi.fn(async () => ({ approvalRequestId: "appr-9" }));
    const res = await executeAutomationRun({
      userId: "u1",
      plan: plan([{ kind: "send_slack_message", target: { loopId: "l1" } }]),
      effects: effects({ runPrivateAction, escalateToApproval }),
    });
    expect(res.terminal).toBe("needs_approval");
    expect(res.outcomes[0].status).toBe("needs_approval");
    expect(res.outcomes[0].approvalRequestId).toBe("appr-9");
    expect(escalateToApproval).toHaveBeenCalledOnce();
    expect(runPrivateAction).not.toHaveBeenCalled();
  });

  it("revoked-between-plan-and-execute → cancelled, NO side effect (SR3)", async () => {
    const runPrivateAction = vi.fn(async () => ({}));
    const escalateToApproval = vi.fn(async () => ({ approvalRequestId: "x" }));
    const res = await executeAutomationRun({
      userId: "u1",
      plan: plan([{ kind: "create_private_report", target: {} }]),
      effects: effects({ loadFreshGrant: async () => null, runPrivateAction, escalateToApproval }),
    });
    expect(res.terminal).toBe("cancelled");
    expect(res.outcomes[0].status).toBe("cancelled");
    expect(runPrivateAction).not.toHaveBeenCalled();
    expect(escalateToApproval).not.toHaveBeenCalled();
  });

  it("paused grant at execute → denied → cancelled", async () => {
    const res = await executeAutomationRun({
      userId: "u1",
      plan: plan([{ kind: "create_private_report", target: {} }]),
      effects: effects({ loadFreshGrant: async () => staleGrant({ status: "paused" }) }),
    });
    expect(res.terminal).toBe("cancelled");
  });

  it("private effect that throws → failed", async () => {
    const res = await executeAutomationRun({
      userId: "u1",
      plan: plan([{ kind: "create_private_report", target: {} }]),
      effects: effects({ runPrivateAction: async () => { throw new Error("boom"); } }),
    });
    expect(res.terminal).toBe("failed");
    expect(res.outcomes[0].reason).toContain("boom");
  });

  it("cap exhausted at execute (fresh usage) → cancelled", async () => {
    const res = await executeAutomationRun({
      userId: "u1",
      plan: plan([{ kind: "create_private_report", target: {} }]),
      effects: effects({
        loadFreshGrant: async () =>
          staleGrant({ caps: { create_private_report: { limit: 1, window: "day" } } }),
        loadCapUsage: async () => ({ create_private_report: 1 }),
      }),
    });
    expect(res.terminal).toBe("cancelled");
    expect(res.outcomes[0].reason).toContain("cap exhausted");
  });
});
