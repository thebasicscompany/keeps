/**
 * Run-now orchestrator (Wave E) — runs a recipe ONE TIME, synchronously, on demand.
 *
 * This is the same trigger → plan → execute pipeline the cron sweeps + Inngest functions run,
 * collapsed into a single in-request call so the user can click "Run now" and immediately see a
 * run (and its private email / report / escalation) instead of waiting for an hourly sweep. It
 * reuses the exact pure cores (planAutomationRun, executeAutomationRun) over the shared Drizzle
 * dispatch, so a manual run and an automatic run behave identically — including SR3/SR8.
 *
 * Deny-by-default: refuses if the recipe has no active, unexpired grant for the user.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loops, standingGrants } from "@/db/schema";
import { DrizzleAutomationRunRepository } from "@/automation/run-repository";
import { buildPlanInputForRecipe } from "@/automation/plan-input";
import { planAutomationRun } from "@/automation/planner";
import { executeAutomationRun, type ExecuteRunResult } from "@/automation/executor";
import { buildDrizzleExecutorEffects } from "@/automation/dispatch";
import { isKnownRecipe } from "@/automation/recipe-registry";
import { startOfLocalDay } from "@/users/timezone";
import type { SandboxPlan } from "@/automation/sandbox-plan";
import type { InsertRunInput } from "@/automation/run-repository";
import type { RecipeKey } from "@/automation/types";

const ACTIVE_LOOP_STATUSES = ["open", "waiting_on_me", "waiting_on_other"] as const;

const TRIGGER_KIND: Record<RecipeKey, InsertRunInput["triggerKind"]> = {
  pre_meeting_brief: "calendar_event",
  post_meeting_prompt: "calendar_event",
  stale_loop_followup: "loop_stale",
  self_only_calendar_reminder: "explicit_command",
};

export type RunNowResult =
  | { ok: true; runId: string; status: ExecuteRunResult["terminal"] | "skipped"; reason?: string }
  | { ok: false; error: string };

export async function runAutomationNow(input: {
  userId: string;
  recipeKey: string;
  now?: Date;
}): Promise<RunNowResult> {
  if (!isKnownRecipe(input.recipeKey)) return { ok: false, error: "unknown recipe" };
  const recipeKey = input.recipeKey as RecipeKey;
  const now = input.now ?? new Date();
  const db = getDb();
  const repo = new DrizzleAutomationRunRepository();

  // SR1: an active, unexpired grant is required.
  const [grantRow] = await db
    .select({ id: standingGrants.id, expiresAt: standingGrants.expiresAt })
    .from(standingGrants)
    .where(
      and(
        eq(standingGrants.userId, input.userId),
        eq(standingGrants.recipeKey, recipeKey),
        eq(standingGrants.status, "active"),
      ),
    )
    .limit(1);
  if (!grantRow) return { ok: false, error: "This automation isn't enabled." };
  if (grantRow.expiresAt && grantRow.expiresAt <= now) return { ok: false, error: "This grant has expired." };

  const grant = await repo.loadGrantContext(grantRow.id);
  if (!grant) return { ok: false, error: "This automation isn't enabled." };

  // Pick the trigger reference. Stale-loop: the user's longest-idle open loop.
  let triggerRef: string | undefined;
  let context: Record<string, unknown> | undefined;
  if (recipeKey === "stale_loop_followup") {
    const [loop] = await db
      .select({ id: loops.id, updatedAt: loops.updatedAt })
      .from(loops)
      .where(and(eq(loops.userId, input.userId), inArray(loops.status, [...ACTIVE_LOOP_STATUSES])))
      .orderBy(asc(loops.updatedAt))
      .limit(1);
    if (!loop) return { ok: false, error: "You have no open loops to follow up on." };
    triggerRef = loop.id;
    const staleDays = Math.max(0, Math.floor((now.getTime() - loop.updatedAt.getTime()) / 86_400_000));
    context = { staleDays };
  }

  const built = await buildPlanInputForRecipe(recipeKey, { userId: input.userId, triggerRef, context, now });
  if (!built.ok) return { ok: false, error: built.reason };

  const triggerKind = TRIGGER_KIND[recipeKey];
  const capUsage = await repo.countCapUsage(grantRow.id, startOfLocalDay("UTC", now));
  const planResult = planAutomationRun({
    recipeKey,
    triggerKind,
    triggerRef: built.triggerRef ?? undefined,
    intendedActions: built.input.intendedActions,
    grant,
    contextUsed: built.input.contextUsed,
    provenanceContext: built.input.provenanceContext,
    draft: built.input.draft,
    capUsage,
    userTimezone: "UTC",
    now,
  });

  // Manual runs are always fresh (random idempotency key) so the user can re-run on demand.
  const idempotencyKey = `automation:runnow:${recipeKey}:${randomUUID()}`;

  if (planResult.kind === "skip") {
    const skipPlan: SandboxPlan = {
      recipeKey,
      triggerKind,
      triggerRef: built.triggerRef ?? undefined,
      contextUsed: built.input.contextUsed,
      intendedActions: [],
      provenanceLine: `skipped: ${planResult.reason}`,
      requiresApproval: false,
    };
    const { id } = await repo.insertRun({
      userId: input.userId,
      standingGrantId: grantRow.id,
      recipeKey,
      triggerKind,
      triggerRef: built.triggerRef ?? null,
      status: "skipped",
      idempotencyKey,
      sandboxPlan: skipPlan,
      provenance: { skipReason: planResult.reason },
    });
    return { ok: true, runId: id, status: "skipped", reason: planResult.reason };
  }

  const { id } = await repo.insertRun({
    userId: input.userId,
    standingGrantId: grantRow.id,
    recipeKey,
    triggerKind,
    triggerRef: built.triggerRef ?? null,
    status: "planned",
    idempotencyKey,
    sandboxPlan: planResult.plan,
    provenance: { line: planResult.plan.provenanceLine },
  });
  await repo.insertRunActions(
    id,
    planResult.plan.intendedActions.map((a) => ({ actionKind: a.kind, target: a.target })),
  );

  await repo.updateRunStatus(id, "executing", { at: now });
  const exec = await executeAutomationRun({
    plan: planResult.plan,
    userId: input.userId,
    now,
    effects: buildDrizzleExecutorEffects({
      repo,
      standingGrantId: grantRow.id,
      userId: input.userId,
      plan: planResult.plan,
      now,
    }),
  });
  await repo.updateRunStatus(id, exec.terminal, { result: { outcomes: exec.outcomes }, at: new Date() });

  return { ok: true, runId: id, status: exec.terminal };
}
