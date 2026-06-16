/**
 * Automation dispatch (Wave 3/E) — the SHARED, server-only effects the executor core runs over.
 *
 * Both the Inngest executor (handle-automation-run) and the synchronous "Run now" orchestrator
 * (run-now.ts) build their ExecutorEffects from here, so a manual run and a cron-triggered run
 * dispatch through byte-identical code:
 *   - PRIVATE actions (send_private_email_to_user / create_private_report) → sendSystemEmail /
 *     createReport (never leave the owner's boundary).
 *   - EXTERNAL actions (slack / attendee-calendar) → SR8 escalation to a per-run approval. We
 *     emit `approval.requested` so the existing handle-approval workflow surfaces the approval
 *     email + runs the approve→execute hop. We NEVER auto-send here.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { sendSystemEmail } from "@/email/system-send";
import { getEmailSender } from "@/email/sender-factory";
import { createReport } from "@/reports/service";
import { DrizzleReportsRepository } from "@/reports/repository";
import { createApprovalRequest } from "@/approvals/service";
import { DrizzleApprovalRepository } from "@/approvals/repository";
import { startOfLocalDay } from "@/users/timezone";
import type { ExecutorEffects } from "@/automation/executor";
import type { IntendedAction, SandboxPlan } from "@/automation/sandbox-plan";
import type { AutomationRunRepository } from "@/automation/run-repository";

export async function loadOwnerEmail(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}

/** PRIVATE action dispatch — only kinds that never leave the user's boundary. */
export async function runPrivateAutomationAction(
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
    return { sent: true, providerMessageId, to: ownerEmail };
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

/**
 * SR8 escalation — create a per-run approval. The action is NEVER auto-executed here; the
 * approve→execute hop is owned by the approval workflow. We let `approval.requested` fire (the
 * default emitter) so handle-approval sends the approval email + waits for the decision.
 */
export async function escalateAutomationAction(
  action: IntendedAction,
  userId: string,
): Promise<{ approvalRequestId: string }> {
  const { request } = await createApprovalRequest({
    userId,
    draft: { actionKind: action.kind, payload: action.target },
    now: new Date(),
    repository: new DrizzleApprovalRepository(),
  });
  return { approvalRequestId: request.id };
}

/**
 * The standard Drizzle-backed effects for one run. Shared by the Inngest executor and Run-now
 * so both honor SR3 (fresh grant reload) + SR4 (cap usage computed at the side-effect hop).
 */
export function buildDrizzleExecutorEffects(input: {
  repo: AutomationRunRepository;
  standingGrantId: string | null;
  userId: string;
  plan: SandboxPlan;
  now: Date;
}): ExecutorEffects {
  const { repo, standingGrantId, userId, plan, now } = input;
  return {
    loadFreshGrant: () =>
      standingGrantId ? repo.loadGrantContext(standingGrantId) : Promise.resolve(null),
    loadCapUsage: () =>
      standingGrantId
        ? repo.countCapUsage(standingGrantId, startOfLocalDay("UTC", now))
        : Promise.resolve({}),
    runPrivateAction: (action) => runPrivateAutomationAction(action, plan, userId),
    escalateToApproval: (action) => escalateAutomationAction(action, userId),
  };
}
