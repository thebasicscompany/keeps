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
import { executeConnectorPayload } from "@/connectors/action-registry";
import { loadConnectedCalendar } from "@/automation/calendar-context";
import type { ConnectorActionPayload } from "@/agent/schemas";
import type { ExecutorEffects } from "@/automation/executor";
import type { IntendedAction, SandboxPlan } from "@/automation/sandbox-plan";
import type { AutomationRunRepository } from "@/automation/run-repository";

export async function loadOwnerEmail(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}

async function loadUserTimezone(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ tz: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.tz ?? null;
}

/**
 * Create a SELF-ONLY calendar event (no attendees) via the existing frozen-payload connector path.
 * The action is authorized as allowed (self-only, SR8) BEFORE this runs. Idempotency comes from the
 * automation run ledger (one run per idempotency key), not the connector_actions row lock.
 */
async function runSelfOnlyCalendarEvent(
  action: IntendedAction,
  userId: string,
): Promise<Record<string, unknown>> {
  const t = action.target as { eventTitle?: unknown; whenAt?: unknown; durationMinutes?: unknown };
  const cal = await loadConnectedCalendar(userId);
  if (!cal) return { skipped: "no_connected_calendar" };
  const payload: ConnectorActionPayload = {
    kind: "calendar_event",
    destination: { kind: "self", nameText: null, emailText: null },
    eventTitle: typeof t.eventTitle === "string" ? t.eventTitle : "Keeps reminder",
    whenAt: typeof t.whenAt === "string" ? t.whenAt : null,
    durationMinutes: typeof t.durationMinutes === "number" ? t.durationMinutes : 30,
    reminderMinutesBefore: 10,
    description: null,
    attendees: null,
  };
  const tz = await loadUserTimezone(userId);
  const result = await executeConnectorPayload({
    payload,
    keepsUserId: userId,
    connectedAccountId: cal.connectedAccountId,
    user: { timezone: tz },
  });
  return { created: true, calendar: result as unknown as Record<string, unknown> };
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
  // Self-only calendar reminder — authorized as allowed (no attendees) before reaching here.
  if (action.kind === "create_calendar_event") {
    return runSelfOnlyCalendarEvent(action, userId);
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
