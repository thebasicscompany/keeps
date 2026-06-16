import type { StandingGrantContext } from "@/automation/types";
import { isKnownRecipe } from "@/automation/recipe-registry";
import { zoneDecisionFor } from "@/visibility/zones";

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
 * AR-7 authorization context. Carries the AR-7 approval grant and (Phase V2) an OPTIONAL
 * standing grant. When `standingGrant` is present the standing-grant branch decides;
 * otherwise the legacy approval path runs unchanged, so every pre-V2 caller behaves
 * identically (no caller ever sets `standingGrant` unless it is an automation run).
 */
export type AuthorizationContext = {
  userId: string;
  approval?: {
    id: string;
    status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
    expiresAt: Date;
  };
  /** Phase V2 standing grant; assembled by the automation executor (see @/automation/types). */
  standingGrant?: StandingGrantContext;
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
  // Connector action kinds (slack_dm, calendar_event) are aliases of policy kinds — map
  // first so authorize() is invariant to which name a caller uses.
  const mapped = toPolicyActionKind(action);

  // ── Phase V2 standing-grant branch ──────────────────────────────────────────
  // Taken ONLY when a grant is supplied. requiresApproval / assertApprovalAllowed / every
  // connector path that passes only an approval never supply one, so the AR-7 path below is
  // byte-for-byte unchanged for them.
  if (context.standingGrant) {
    return authorizeWithStandingGrant(mapped, context.standingGrant, options);
  }

  // Fail closed: only an explicitly-known private action is treated as private. Everything
  // else (known external kinds AND arbitrary unrecognized strings like `test_action`) takes
  // the external path and must present a valid approved approval.
  if (privateActions.has(mapped as KeepsActionKind)) {
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

// ── Phase V2 standing-grant authorization ─────────────────────────────────────

const CONNECTOR_KIND_ALIASES: Record<string, KeepsActionKind> = {
  slack_dm: "send_slack_message",
  calendar_event: "create_calendar_event",
};

/**
 * Map a connector action kind (ACTION_REGISTRY: slack_dm, calendar_event) to its policy
 * action kind, so `authorize('slack_dm', g)` deep-equals `authorize('send_slack_message', g)`.
 * Unknown strings pass through unchanged (they fail closed downstream).
 */
export function toPolicyActionKind(action: string): KeepsActionKind | (string & {}) {
  return CONNECTOR_KIND_ALIASES[action] ?? action;
}

/**
 * Evaluate a standing grant for one action. PURE: cap usage + attendee presence are
 * supplied on the context by the executor (computed inside its FOR UPDATE txn, SR3).
 * Deny-by-default at every gate (SR1); blocked beats allowed (SR2); the external-visibility
 * boundary (SR8) is hard-coded here and CANNOT be widened by any grant or recipe.
 */
function authorizeWithStandingGrant(
  action: KeepsActionKind | (string & {}),
  grant: StandingGrantContext,
  options?: { now?: Date },
): AuthorizationResult {
  const now = options?.now ?? new Date();

  // 1. Validity gates.
  if (!isKnownRecipe(grant.recipeKey)) {
    return { result: "denied", reason: `unknown recipe ${grant.recipeKey}` };
  }
  if (grant.status !== "active") {
    return { result: "denied", reason: `grant is ${grant.status}, not active` };
  }
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) {
    return { result: "denied", reason: "grant expired" };
  }

  // 2. Blocked beats allowed (SR2).
  if (grant.blockedActionKinds.includes(action as KeepsActionKind)) {
    return { result: "denied", reason: `action ${action} blocked by grant` };
  }

  if (grant.targetZone) {
    // ── Zone-aware SR8 (Wave 2) ──────────────────────────────────────────────
    // The recipient's zone (computed by the executor via classifyZone) decides: escalate when
    // reachable within a shared scope (in_scope / external_counterparty), deny across a boundary
    // (cross_scope_internal / external_unscoped). Still bounded by the grant's allowed envelope.
    if (!grant.allowedActionKinds.includes(action as KeepsActionKind)) {
      return { result: "denied", reason: `action ${action} not in grant allowed kinds` };
    }
    const zoneDecision = zoneDecisionFor(action as KeepsActionKind, grant.targetZone);
    if (zoneDecision === "denied") {
      return { result: "denied", reason: `${action} denied: recipient zone ${grant.targetZone}` };
    }
    if (zoneDecision === "needs_approval") {
      return { result: "needs_approval", reason: `${action} to zone ${grant.targetZone} requires approval` };
    }
    // allowed (private kind) → fall through to caps.
  } else {
    // ── Legacy kind-only SR8 (unchanged; runs when no targetZone is supplied) ──
    // 3. SR8 hard external-visibility boundary — never authorizable by a standing grant.
    if (action === "send_email" || action === "share_loop" || action === "reveal_source") {
      return { result: "denied", reason: `${action} is never authorizable by a standing grant` };
    }
    // 4. Must be inside the grant's allowed envelope.
    if (!grant.allowedActionKinds.includes(action as KeepsActionKind)) {
      return { result: "denied", reason: `action ${action} not in grant allowed kinds` };
    }
    // 5. SR8 escalation — anything visible to another person still needs per-run approval.
    if (action === "send_slack_message") {
      return { result: "needs_approval", reason: "Slack send always requires per-run approval" };
    }
    if (action === "create_calendar_event" && grant.hasAttendees) {
      return { result: "needs_approval", reason: "calendar event with attendees requires approval" };
    }
  }

  // 6. Caps (usage supplied by the caller).
  const cap = grant.caps?.[action as KeepsActionKind];
  if (cap) {
    const used = grant.capUsage?.[action as KeepsActionKind] ?? 0;
    if (used >= cap.limit) {
      return { result: "denied", reason: `cap exhausted for ${action} (${used}/${cap.limit})` };
    }
  }

  return { result: "allowed" };
}
