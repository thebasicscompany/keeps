/**
 * handle-automation-trigger (Wave 3, FR5/SR7) — the planner Inngest function.
 *
 * Consumes `automation.triggered`, loads the fresh grant + the recipe's context (lean, by
 * triggerRef + event.context), builds the intended actions via the pure recipe builder, runs the
 * pure `planAutomationRun` (quiet-hours / cap gates), and persists an automation_runs row:
 *   - plan  → status 'planned' (+ child run_actions) → emit `automation.planned` (executor picks up)
 *   - skip  → status 'skipped' (+ reason), no side effect
 * Idempotent via the Inngest fn `idempotency` key AND the unique automation_runs.idempotency_key
 * (insertRun ON CONFLICT DO NOTHING). Calendar recipes (pre/post-meeting) await the calendar sweep.
 */
import { inngest } from "@/workflows/client";
import { DrizzleAutomationRunRepository, type InsertRunInput } from "@/automation/run-repository";
import { planAutomationRun } from "@/automation/planner";
import { buildPlanInputForRecipe } from "@/automation/plan-input";
import { startOfLocalDay } from "@/users/timezone";
import type { SandboxPlan } from "@/automation/sandbox-plan";

export const handleAutomationTriggerFunction = inngest.createFunction(
  {
    id: "handle-automation-trigger",
    triggers: { event: "automation.triggered" },
    idempotency: "event.data.idempotencyKey",
    retries: 3,
  },
  async ({ event, step }) => {
    const userId = event.data.userId as string;
    const recipeKey = event.data.recipeKey as string;
    const triggerKind = event.data.triggerKind as InsertRunInput["triggerKind"];
    const triggerRef = (event.data.triggerRef as string | undefined) ?? null;
    const idempotencyKey = event.data.idempotencyKey as string;
    const standingGrantId = (event.data.standingGrantId as string | undefined) ?? null;
    const context = event.data.context as Record<string, unknown> | undefined;

    const planned = await step.run("plan-and-persist", async () => {
      const repo = new DrizzleAutomationRunRepository();
      const now = new Date();

      const grant = standingGrantId ? await repo.loadGrantContext(standingGrantId) : null;
      if (!grant) return { status: "skipped" as const, reason: "no_active_grant" };

      const builtResult = await buildPlanInputForRecipe(recipeKey, {
        userId,
        triggerRef: triggerRef ?? undefined,
        context,
        now,
      });
      if (!builtResult.ok) return { status: "skipped" as const, reason: builtResult.reason };
      const built = builtResult.input;

      const capUsage = standingGrantId
        ? await repo.countCapUsage(standingGrantId, startOfLocalDay("UTC", now))
        : {};

      const planResult = planAutomationRun({
        recipeKey: recipeKey as Parameters<typeof planAutomationRun>[0]["recipeKey"],
        triggerKind,
        triggerRef: triggerRef ?? undefined,
        intendedActions: built.intendedActions,
        grant,
        contextUsed: built.contextUsed,
        provenanceContext: built.provenanceContext,
        draft: built.draft,
        capUsage,
        userTimezone: "UTC",
        now,
      });

      if (planResult.kind === "skip") {
        const skipPlan: SandboxPlan = {
          recipeKey: recipeKey as SandboxPlan["recipeKey"],
          triggerKind,
          triggerRef: triggerRef ?? undefined,
          contextUsed: built.contextUsed,
          intendedActions: [],
          provenanceLine: `skipped: ${planResult.reason}`,
          requiresApproval: false,
        };
        const { id } = await repo.insertRun({
          userId,
          standingGrantId,
          recipeKey,
          triggerKind,
          triggerRef,
          status: "skipped",
          idempotencyKey,
          sandboxPlan: skipPlan,
          provenance: { skipReason: planResult.reason },
        });
        return { status: "skipped" as const, reason: planResult.reason, runId: id };
      }

      const { id, deduped } = await repo.insertRun({
        userId,
        standingGrantId,
        recipeKey,
        triggerKind,
        triggerRef,
        status: "planned",
        idempotencyKey,
        sandboxPlan: planResult.plan,
        provenance: { line: planResult.plan.provenanceLine },
      });
      if (deduped) return { status: "deduped" as const, runId: id };

      await repo.insertRunActions(
        id,
        planResult.plan.intendedActions.map((a) => ({ actionKind: a.kind, target: a.target })),
      );
      return {
        status: "planned" as const,
        runId: id,
        requiresApproval: planResult.plan.requiresApproval,
        provenance: planResult.plan.provenanceLine,
      };
    });

    if (planned.status === "planned") {
      await step.sendEvent("emit-planned", {
        name: "automation.planned",
        data: {
          userId,
          automationRunId: planned.runId,
          recipeKey,
          requiresApproval: planned.requiresApproval ?? false,
          provenance: planned.provenance ?? "",
        },
      });
    }

    console.log(`[handle-automation-trigger] recipe=${recipeKey} status=${planned.status}`);
    return planned;
  },
);
