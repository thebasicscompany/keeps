/**
 * app/settings/automations/runs/[runId]/page.tsx
 *
 * Run detail (Wave E observability). Shows ONE automation run from the owner's seat: the
 * provenance ("Because …"), what it drafted, what it actually did (per-action outcome), and the
 * trigger/timing. Scoped to the signed-in user's own runs. Read-only; no tokens, no source quotes.
 */
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { automationRunActions, automationRuns, userIdentities } from "@/db/schema";
import { getRecipe } from "@/automation/recipe-registry";
import type { SandboxPlan } from "@/automation/sandbox-plan";
import { cardClass, labelClass, mutedClass, statusBadgeVariants } from "../../../_ui";

export const dynamic = "force-dynamic";

async function resolveInternalUserId(): Promise<string | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const [identity] = await getDb()
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, "clerk"), eq(userIdentities.providerAccountId, clerkUserId)))
    .limit(1);
  return identity?.userId ?? null;
}

type Outcome = {
  actionKind: string;
  status: string;
  reason?: string;
  result?: Record<string, unknown>;
  approvalRequestId?: string;
};

const ACTION_LABEL: Record<string, string> = {
  send_private_email_to_user: "Email you privately",
  create_private_report: "Build a private report",
  send_slack_message: "Send a Slack message",
  create_calendar_event: "Create a calendar event",
};

function actionLabel(kind: string): string {
  return ACTION_LABEL[kind] ?? kind;
}

/** Plain-language outcome line for one action. */
function outcomeLine(o: Outcome): string {
  if (o.status === "completed") {
    if (o.result?.sent) return `Sent — a private email landed in your inbox (${String(o.result.to ?? "you")}).`;
    if (o.result?.reportId) return "Done — a private report was created.";
    if (o.result?.created) return "Created — a self-only event was added to your calendar.";
    if (o.result?.skipped) return `Nothing to do (${String(o.result.skipped)}).`;
    return "Done.";
  }
  if (o.status === "needs_approval") return "Waiting for your approval before anything leaves your account.";
  if (o.status === "cancelled") return o.reason ?? "Cancelled.";
  if (o.status === "failed") return `Failed: ${o.reason ?? "unknown error"}.`;
  return o.status;
}

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const statusVariant = (s: string) =>
  s === "completed" ? statusBadgeVariants.active : s === "failed" ? statusBadgeVariants.error : statusBadgeVariants.none;

export default async function AutomationRunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const userId = await resolveInternalUserId();
  if (!userId) redirect("/sign-in?redirect_url=/settings/automations" as Route);

  const [run] = await getDb()
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.userId, userId)))
    .limit(1);

  if (!run) {
    return (
      <div className={cardClass}>
        <h2 className="text-[22px] font-bold text-[#14140F]">Run not found</h2>
        <p className={`mt-2 text-[15px] ${mutedClass}`}>This run doesn’t exist or isn’t yours.</p>
        <Link href={"/settings/automations" as Route} className="mt-4 inline-block text-[14px] underline">
          ← Back to automations
        </Link>
      </div>
    );
  }

  const plan = (run.sandboxPlan ?? {}) as Partial<SandboxPlan>;
  const provenance = (run.provenance ?? {}) as { line?: string; skipReason?: string };
  const result = (run.result ?? {}) as { outcomes?: Outcome[] };
  const outcomes = result.outcomes ?? [];
  const recipeName = getRecipe(run.recipeKey)?.displayName ?? run.recipeKey;
  const provenanceLine = plan.provenanceLine ?? provenance.line ?? "";
  const actions = await getDb()
    .select({ kind: automationRunActions.actionKind, status: automationRunActions.status })
    .from(automationRunActions)
    .where(eq(automationRunActions.automationRunId, runId));

  return (
    <div className={cardClass}>
      <Link href={"/settings/automations" as Route} className={`text-[13px] ${mutedClass} hover:text-[#14140F]`}>
        ← Automations
      </Link>

      <div className="mt-3 mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[26px] leading-tight font-bold text-[#14140F]">{recipeName}</h2>
          {provenanceLine ? <p className={`mt-1 text-[16px] ${mutedClass}`}>{provenanceLine}</p> : null}
        </div>
        <span
          className={`keeps-mono inline-flex h-7 shrink-0 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${statusVariant(run.status)}`}
        >
          {run.status}
        </span>
      </div>

      {/* What it did */}
      <section className="mb-8">
        <h3 className={`mb-3 ${labelClass}`}>What happened</h3>
        {run.status === "skipped" ? (
          <p className={`text-[15px] ${mutedClass}`}>Skipped: {provenance.skipReason ?? "not applicable"}.</p>
        ) : outcomes.length === 0 ? (
          <p className={`text-[15px] ${mutedClass}`}>No actions were taken.</p>
        ) : (
          <ul className="space-y-2">
            {outcomes.map((o, i) => (
              <li key={i} className="flex items-start justify-between gap-3 rounded-[4px] border border-[#DEDED8] px-4 py-3">
                <div className="min-w-0">
                  <span className="text-[15px] font-semibold text-[#14140F]">{actionLabel(o.actionKind)}</span>
                  <p className={`text-[13px] ${mutedClass}`}>{outcomeLine(o)}</p>
                </div>
                <span
                  className={`keeps-mono inline-flex h-7 shrink-0 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${statusVariant(o.status)}`}
                >
                  {o.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* What it drafted (private to you) */}
      {plan.generatedContent?.subject || plan.generatedContent?.body ? (
        <section className="mb-8">
          <h3 className={`mb-3 ${labelClass}`}>What it wrote (private to you)</h3>
          <div className="rounded-[4px] border border-[#DEDED8] bg-white px-4 py-3">
            {plan.generatedContent?.subject ? (
              <p className="text-[15px] font-semibold text-[#14140F]">{plan.generatedContent.subject}</p>
            ) : null}
            {plan.generatedContent?.body ? (
              <p className={`mt-1 whitespace-pre-wrap text-[14px] ${mutedClass}`}>{plan.generatedContent.body}</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Plan / provenance facts */}
      <section className="grid gap-3 text-[13px] sm:grid-cols-2">
        <Fact label="Trigger" value={run.triggerKind} />
        <Fact label="Planned actions" value={actions.map((a) => actionLabel(a.kind)).join(", ") || "—"} />
        <Fact label="Needs approval" value={plan.requiresApproval ? "yes" : "no"} />
        <Fact label="Started" value={fmt(run.startedAt)} />
        <Fact label="Completed" value={fmt(run.completedAt)} />
        <Fact
          label="Context used"
          value={
            [
              plan.contextUsed?.loopIds?.length ? `${plan.contextUsed.loopIds.length} loop(s)` : null,
              plan.contextUsed?.entityIds?.length ? `${plan.contextUsed.entityIds.length} contact(s)` : null,
              plan.contextUsed?.calendarEventId ? "1 calendar event" : null,
            ]
              .filter(Boolean)
              .join(", ") || "—"
          }
        />
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-[#DEDED8] px-4 py-2">
      <div className="keeps-mono text-[10px] uppercase text-[#6F6F66]">{label}</div>
      <div className="text-[14px] text-[#14140F]">{value}</div>
    </div>
  );
}
