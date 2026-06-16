/**
 * handle-automation-run (Wave 3, FR6/FR7/SR3/SR8) — the executor Inngest function.
 *
 * Consumes `automation.planned`, loads the stored sandbox plan, and runs the PURE
 * `executeAutomationRun` core over Drizzle effects:
 *   - SR3: loadFreshGrant re-loads the grant immediately before side effects.
 *   - PRIVATE actions (send_private_email_to_user / create_private_report) run via sendSystemEmail
 *     / createReport.
 *   - EXTERNAL actions (slack / attendee-calendar) → authorize returns needs_approval → we create
 *     a per-run approval (createApprovalRequest) and record it; we NEVER auto-send (SR8). The
 *     approve→execute hop is handled by the approval flow (follow-up).
 *
 * Terminal status is persisted to automation_runs.status (+ outcomes in .result). Flag-gated by
 * the planner that emits the event; this function is harmless if no planned runs exist.
 */
import { inngest } from "@/workflows/client";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { executeAutomationRun } from "@/automation/executor";
import { DrizzleAutomationRunRepository } from "@/automation/run-repository";
import type { IntendedAction, SandboxPlan } from "@/automation/sandbox-plan";
import { sendSystemEmail } from "@/email/system-send";
import { getEmailSender } from "@/email/sender-factory";
import { createReport } from "@/reports/service";
import { DrizzleReportsRepository } from "@/reports/repository";
import { createApprovalRequest } from "@/approvals/service";
import { DrizzleApprovalRepository } from "@/approvals/repository";
import { startOfLocalDay } from "@/users/timezone";

async function loadOwnerEmail(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}

/** PRIVATE action dispatch — only kinds that never leave the user's boundary. */
async function runPrivateAutomationAction(
  action: IntendedAction,
  plan: SandboxPlan,
  userId: string,
): Promise<Record<string, unknown>> {
  if (action.kind === "send_private_email_to_user") {
    const ownerEmail = await loadOwnerEmail(userId);
    if (!ownerEmail) return { skipped: "no_owner_email" };
    const subject = plan.generatedContent?.subject ?? "Keeps";
    const textBody = `${plan.generatedContent?.body ?? ""}\n\n— ${plan.provenanceLine}`;
    const { providerMessageId } = await sendSystemEmail({
      email: { to: ownerEmail, subject, textBody },
      sender: getEmailSender(),
    });
    return { sent: true, providerMessageId };
  }
  if (action.kind === "create_private_report") {
    const { reportId } = await createReport({
      userId,
      kind: "insights",
      scope: action.target,
      summary: plan.generatedContent?.subject ?? "Automation report",
      requestedVia: "automation_recipe",
      repository: new DrizzleReportsRepository(),
    });
    return { reportId };
  }
  return { skipped: `unsupported_private_kind_${action.kind}` };
}

/** SR8 escalation — create a per-run approval; the action is NEVER auto-executed here. */
async function escalateAutomationAction(
  action: IntendedAction,
  userId: string,
): Promise<{ approvalRequestId: string }> {
  const { request } = await createApprovalRequest({
    userId,
    draft: { actionKind: action.kind, payload: action.target },
    now: new Date(),
    repository: new DrizzleApprovalRepository(),
    // This function owns the run; suppress the generic approval.requested broadcast.
    emitEvent: async () => {},
  });
  return { approvalRequestId: request.id };
}

export const handleAutomationRunFunction = inngest.createFunction(
  {
    id: "handle-automation-run",
    triggers: { event: "automation.planned" },
    retries: 3,
  },
  async ({ event, step }) => {
    const automationRunId = event.data.automationRunId as string;
    const recipeKey = event.data.recipeKey as string;
    const userId = event.data.userId as string;

    const result = await step.run("execute", async () => {
      const repo = new DrizzleAutomationRunRepository();
      const run = await repo.loadRun(automationRunId);
      if (!run) return { status: "skipped", reason: "run_not_found" } as const;
      // Idempotency: only a freshly-planned run executes (a retry/replay sees executing/terminal).
      if (run.status !== "planned") return { status: "skipped", reason: `already_${run.status}` } as const;

      const now = new Date();
      await repo.updateRunStatus(automationRunId, "executing", { at: now });

      const exec = await executeAutomationRun({
        plan: run.sandboxPlan,
        userId: run.userId,
        now,
        effects: {
          loadFreshGrant: () =>
            run.standingGrantId ? repo.loadGrantContext(run.standingGrantId) : Promise.resolve(null),
          loadCapUsage: () =>
            run.standingGrantId
              ? repo.countCapUsage(run.standingGrantId, startOfLocalDay("UTC", now))
              : Promise.resolve({}),
          runPrivateAction: (action) => runPrivateAutomationAction(action, run.sandboxPlan, run.userId),
          escalateToApproval: (action) => escalateAutomationAction(action, run.userId),
        },
      });

      await repo.updateRunStatus(automationRunId, exec.terminal, {
        result: { outcomes: exec.outcomes },
        at: new Date(),
      });
      return { status: exec.terminal, outcomes: exec.outcomes.length } as const;
    });

    // Emit the terminal event (best-effort; ids/summaries only).
    if (result.status === "completed" || result.status === "failed" || result.status === "cancelled") {
      await step.sendEvent("emit-terminal", {
        name: result.status === "completed" ? "automation.completed" : result.status === "failed" ? "automation.failed" : "automation.cancelled",
        data:
          result.status === "failed"
            ? { userId, automationRunId, recipeKey, error: { code: "execute_failed", message: "see run result", retryable: false } }
            : result.status === "cancelled"
              ? { userId, automationRunId, recipeKey, reason: "denied or grant revoked" }
              : { userId, automationRunId, recipeKey },
      });
    } else if (result.status === "needs_approval") {
      await step.sendEvent("emit-needs-approval", {
        name: "automation.needs_approval",
        data: { userId, automationRunId, recipeKey, approvalRequestId: "see run actions", actionKind: "external" },
      });
    }

    console.log(`[handle-automation-run] run=${automationRunId} recipe=${recipeKey} status=${result.status}`);
    return result;
  },
);
