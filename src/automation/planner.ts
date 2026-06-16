/**
 * Automation planner core (Wave D, FR5/SR7) — PURE. Given a recipe + grant + intended
 * actions, either produce a stored-ready SandboxPlan or skip (with a reason) because of
 * quiet hours or exhausted caps. The Inngest planner function persists the result.
 */
import { buildSandboxPlan, type IntendedAction, type SandboxPlan } from "@/automation/sandbox-plan";
import { capStatus } from "@/automation/caps";
import { inQuietHours } from "@/automation/quiet-hours";
import { getRecipe } from "@/automation/recipe-registry";
import type { ProvenanceContext } from "@/automation/provenance";
import type { KeepsActionKind } from "@/policy/actions";
import type { RecipeKey, StandingGrantContext } from "@/automation/types";

export type PlanResult = { kind: "plan"; plan: SandboxPlan } | { kind: "skip"; reason: string };

export function planAutomationRun(input: {
  recipeKey: RecipeKey;
  triggerKind: string;
  triggerRef?: string;
  intendedActions: IntendedAction[];
  grant: StandingGrantContext;
  contextUsed?: SandboxPlan["contextUsed"];
  provenanceContext?: ProvenanceContext;
  draft?: { subject?: string; body?: string };
  /** Per-action recent usage for the plan-time cap check (caller supplies). */
  capUsage?: Partial<Record<KeepsActionKind, number>>;
  userTimezone?: string;
  /**
   * Skip the quiet-hours gate. Set ONLY for an explicit, user-initiated "Run now" — the user is
   * actively asking, so the proactive-quiet-window protection (SR7) doesn't apply. Cron-triggered
   * planning leaves this false so proactive runs still defer overnight.
   */
  bypassQuietHours?: boolean;
  now: Date;
}): PlanResult {
  const recipe = getRecipe(input.recipeKey);
  if (!recipe) return { kind: "skip", reason: `unknown recipe ${input.recipeKey}` };

  // Quiet hours (SR7): defer proactive recipes. Explicit-command recipes carry empty
  // quiet hours → never deferred; an explicit "Run now" bypasses the gate entirely.
  if (
    !input.bypassQuietHours &&
    inQuietHours({ quietHours: recipe.defaultQuietHours, now: input.now, tz: input.userTimezone })
  ) {
    return { kind: "skip", reason: "quiet hours" };
  }

  // Caps (SR7) at plan time — re-checked again at execute.
  for (const action of input.intendedActions) {
    const status = capStatus({
      caps: input.grant.caps,
      actionKind: action.kind,
      recentCount: input.capUsage?.[action.kind] ?? 0,
    });
    if (!status.ok) {
      return { kind: "skip", reason: `cap exhausted for ${action.kind}` };
    }
  }

  return {
    kind: "plan",
    plan: buildSandboxPlan({
      recipeKey: input.recipeKey,
      triggerKind: input.triggerKind,
      triggerRef: input.triggerRef,
      contextUsed: input.contextUsed,
      intendedActions: input.intendedActions,
      provenanceContext: input.provenanceContext,
      draft: input.draft,
    }),
  };
}
