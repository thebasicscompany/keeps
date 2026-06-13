export type ExternalActionKind =
  | "send_email"
  | "send_slack_message"
  | "create_calendar_event"
  | "share_loop"
  | "reveal_source";

export type PrivateActionKind =
  | "create_private_loop"
  | "update_private_loop"
  | "send_private_email_to_user"
  | "create_private_report";

export type KeepsActionKind = ExternalActionKind | PrivateActionKind;

const externalActions = new Set<KeepsActionKind>([
  "send_email",
  "send_slack_message",
  "create_calendar_event",
  "share_loop",
  "reveal_source",
]);

const privateActions = new Set<KeepsActionKind>([
  "create_private_loop",
  "update_private_loop",
  "send_private_email_to_user",
  "create_private_report",
]);

/**
 * Thin shim that delegates to `authorize` so the single source of truth for
 * "is this action external" lives in one place. Returns true iff the action
 * requires an approval before execution (i.e. it is external, not private).
 * Calling with no approval context produces either `needs_approval` (external)
 * or `allowed` (private); we translate that binary.
 */
export function requiresApproval(action: KeepsActionKind): boolean {
  return authorize(action, { userId: "" }).result !== "allowed";
}

/**
 * The decision the policy gate hands back. `needs_approval` means "no valid approval is
 * present, ask for one"; `denied` means "an approval was present but does NOT authorize
 * this action — do not re-ask, do not execute" (rejected/expired/cancelled/pending, or a
 * stale-but-approved grant). This split is the security boundary: a `denied` must never be
 * silently upgraded to a fresh approval request by a caller.
 */
export type AuthorizationResult = {
  result: "allowed" | "needs_approval" | "denied";
  reason?: string;
};

/**
 * AR-7 authorization context. Carries an approval grant today; `standingGrant` is reserved
 * for Phase 4+ standing-grant authorization and is intentionally `never` so connector code
 * cannot hard-code "approval id string exists" as the only authorization shape.
 */
export type AuthorizationContext = {
  userId: string;
  approval?: {
    id: string;
    status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
    expiresAt: Date;
  };
  standingGrant?: never /* reserved for Phase 4+ */;
};

/**
 * Decide whether `action` may run given `context`. Total over both the typed action kinds
 * and arbitrary strings: ANY action that is not a known private action is treated as
 * EXTERNAL and therefore fails closed (requires a valid approved approval). This is what
 * lets the execute funnel authorize the Phase 3 `test_action` fixture — and any future
 * unrecognized kind — without ever defaulting to `allowed`.
 *
 * Rules:
 * - private action → allowed.
 * - external (or unrecognized) action with NO approval → needs_approval.
 * - external action, approval `approved` AND `expiresAt > now` → allowed.
 * - external action, approval `approved` but `expiresAt <= now` → denied (stale grant).
 * - external action, approval in any other status → denied (rejected/expired/cancelled/
 *   pending are terminal-for-this-attempt denials, NOT a reason to re-ask).
 */
export function authorize(
  action: KeepsActionKind | (string & {}),
  context: AuthorizationContext,
  options?: { now?: Date },
): AuthorizationResult {
  // Fail closed: only an explicitly-known private action is treated as private. Everything
  // else (known external kinds AND arbitrary unrecognized strings like `test_action`) takes
  // the external path and must present a valid approved approval.
  if (privateActions.has(action as KeepsActionKind)) {
    return { result: "allowed" };
  }

  const approval = context.approval;

  if (!approval) {
    return { result: "needs_approval" };
  }

  // A pending approval means "in-flight, not yet decided" — callers should wait,
  // not treat it as a hard denial. Map to needs_approval so the caller knows to
  // wait for the approval decision rather than reject the action outright.
  if (approval.status === "pending") {
    return {
      result: "needs_approval",
      reason: `approval ${approval.id} is pending`,
    };
  }

  // rejected / expired / cancelled are terminal-for-this-attempt: do not re-ask.
  if (approval.status !== "approved") {
    return {
      result: "denied",
      reason: `approval ${approval.id} is ${approval.status}, not approved`,
    };
  }

  const now = options?.now ?? new Date();
  if (approval.expiresAt.getTime() <= now.getTime()) {
    return {
      result: "denied",
      reason: `approval ${approval.id} expired at ${approval.expiresAt.toISOString()}`,
    };
  }

  return { result: "allowed" };
}

/**
 * Back-compat gate for existing callers (e.g. extract-loops) that only know whether an
 * approval id string was minted, not the approval's live status. Delegates to `authorize`
 * with NO approval object: a private action authorizes (`allowed`), and an external action
 * comes back `needs_approval` — which we translate to the historical throw UNLESS an
 * approvalId string was supplied. Semantics are identical to the pre-AR-7 implementation:
 * external action + no approvalId → throw; otherwise → ok.
 */
export function assertApprovalAllowed(action: KeepsActionKind, approvalId?: string | null) {
  const decision = authorize(action, { userId: "" });
  if (decision.result === "needs_approval" && !approvalId) {
    throw new Error(`Action "${action}" requires an approval_request before execution.`);
  }
}
