/**
 * Automation executor core (Wave D, FR6/FR7/SR3/SR4/SR8) — PURE over injected effects.
 *
 * For each intended action in a stored sandbox plan:
 *   1. SR3: re-load the grant FRESH immediately before side effects (a revoke between plan
 *      and execute → the run is cancelled, never executed).
 *   2. authorize() the action against the fresh grant (+ live cap usage + attendee presence).
 *   3. allowed → run the PRIVATE effect; needs_approval (SR8) → escalate to a per-run
 *      approval (never auto-send); denied → cancel; effect throw → fail.
 *
 * The Inngest executor function wires the Drizzle effects inside a FOR UPDATE txn (SR4
 * execute-once is preserved by routing connector side effects through executeConnectorAction).
 */
import { authorize, type KeepsActionKind } from "@/policy/actions";
import type { IntendedAction, SandboxPlan } from "@/automation/sandbox-plan";
import type { StandingGrantContext } from "@/automation/types";
import type { SR8Zone } from "@/visibility/zones";

export type RunActionStatus = "completed" | "needs_approval" | "cancelled" | "failed";

export type RunActionOutcome = {
  actionKind: KeepsActionKind;
  status: RunActionStatus;
  reason?: string;
  result?: Record<string, unknown>;
  approvalRequestId?: string;
};

export type ExecutorEffects = {
  /** SR3: re-load the grant FRESH; null = revoked/expired/deleted before execution. */
  loadFreshGrant: () => Promise<StandingGrantContext | null>;
  /** Per-action usage for the fresh cap re-check (computed inside the executor txn). */
  loadCapUsage?: () => Promise<Partial<Record<KeepsActionKind, number>>>;
  /** Run a PRIVATE action; resolves to a non-secret result record. */
  runPrivateAction: (action: IntendedAction) => Promise<Record<string, unknown>>;
  /** Escalate an externally-visible action to a per-run approval (SR8); returns the approval id. */
  escalateToApproval: (action: IntendedAction) => Promise<{ approvalRequestId: string }>;
};

export type ExecuteRunResult = {
  outcomes: RunActionOutcome[];
  terminal: "completed" | "needs_approval" | "cancelled" | "failed";
};

function actionHasAttendees(action: IntendedAction): boolean {
  if (action.kind !== "create_calendar_event") return false;
  const attendees = (action.target as { attendees?: unknown[] }).attendees;
  return Array.isArray(attendees) && attendees.length > 0;
}

export async function executeAutomationRun(input: {
  plan: SandboxPlan;
  userId: string;
  effects: ExecutorEffects;
  now?: Date;
  /**
   * Wave 3 (viewer-scoped SR8): classify an action's recipient zone (via classifyZone against the
   * viewer's scope). When provided, authorize uses zone-aware SR8 — deny across a boundary,
   * escalate when reachable. When ABSENT, the legacy kind-only SR8 runs (back-compat).
   */
  classifyActionZone?: (action: IntendedAction) => SR8Zone | undefined;
}): Promise<ExecuteRunResult> {
  const now = input.now ?? new Date();
  const outcomes: RunActionOutcome[] = [];

  // SR3 — one fresh grant load per run (the actions execute together in the run's txn).
  const grant = await input.effects.loadFreshGrant();
  const capUsage = grant && input.effects.loadCapUsage ? await input.effects.loadCapUsage() : {};

  for (const action of input.plan.intendedActions) {
    if (!grant) {
      outcomes.push({
        actionKind: action.kind,
        status: "cancelled",
        reason: "grant revoked or expired before execution",
      });
      continue;
    }

    const targetZone = input.classifyActionZone?.(action);
    const decision = authorize(
      action.kind,
      {
        userId: input.userId,
        standingGrant: { ...grant, capUsage, hasAttendees: actionHasAttendees(action), targetZone },
      },
      { now },
    );

    if (decision.result === "allowed") {
      try {
        const result = await input.effects.runPrivateAction(action);
        outcomes.push({ actionKind: action.kind, status: "completed", result });
      } catch (err) {
        outcomes.push({
          actionKind: action.kind,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (decision.result === "needs_approval") {
      const { approvalRequestId } = await input.effects.escalateToApproval(action);
      outcomes.push({
        actionKind: action.kind,
        status: "needs_approval",
        reason: decision.reason,
        approvalRequestId,
      });
    } else {
      outcomes.push({
        actionKind: action.kind,
        status: "cancelled",
        reason: decision.reason ?? "denied by policy",
      });
    }
  }

  const terminal: ExecuteRunResult["terminal"] = outcomes.some((o) => o.status === "failed")
    ? "failed"
    : outcomes.some((o) => o.status === "needs_approval")
      ? "needs_approval"
      : outcomes.some((o) => o.status === "cancelled")
        ? "cancelled"
        : "completed";

  return { outcomes, terminal };
}
