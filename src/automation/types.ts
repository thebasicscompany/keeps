/**
 * Phase V2 automation types — shared across policy (Wave B), the recipe registry +
 * sandbox planner (Wave C), the executor (Wave D), and the UX surfaces (Wave E).
 *
 * Type-only dependency on @/policy/actions (KeepsActionKind) — erased at runtime, so
 * the mutual policy<->types reference creates no import cycle.
 */
import type { KeepsActionKind } from "@/policy/actions";
import type { SR8Zone } from "@/visibility/zones";

export type RecipeKey =
  | "pre_meeting_brief"
  | "post_meeting_prompt"
  | "stale_loop_followup"
  | "self_only_calendar_reminder";

export type StandingGrantStatus = "pending" | "active" | "paused" | "revoked" | "expired";

export type GrantCapWindow = "day" | "lifetime";
export type GrantCaps = Partial<Record<KeepsActionKind, { limit: number; window: GrantCapWindow }>>;

export type QuietHours = {
  /** IANA tz the quiet window is evaluated in (defaults to the user's tz). */
  tz?: string;
  /** Local hour [0-23] the quiet window starts (inclusive). */
  startHour?: number;
  /** Local hour [0-23] the quiet window ends (exclusive). */
  endHour?: number;
};

export type GrantScope = Record<string, unknown>;
export type GrantConstraints = Record<string, unknown>;

/**
 * The pure, caller-assembled view of a standing grant that `authorize()` evaluates.
 * The executor builds this from the DB row + live usage counts INSIDE its FOR UPDATE
 * transaction, so `capUsage`/`hasAttendees` are fresh at the side-effect hop (SR3).
 */
export type StandingGrantContext = {
  recipeKey: string;
  status: StandingGrantStatus;
  allowedActionKinds: KeepsActionKind[];
  blockedActionKinds: KeepsActionKind[];
  expiresAt?: Date | null;
  scope?: GrantScope;
  caps?: GrantCaps;
  /** Current per-action usage, supplied by the executor (computed inside FOR UPDATE). */
  capUsage?: Partial<Record<KeepsActionKind, number>>;
  /** True for a calendar_event action carrying attendees — forces approval per SR8. */
  hasAttendees?: boolean;
  /**
   * Wave 2 (zone-aware SR8): the recipient's zone relative to the viewer, computed by the
   * executor via classifyZone. When present, the standing-grant gate uses zoneDecisionFor
   * (deny across a scope boundary, escalate when reachable). When ABSENT, the legacy kind-only
   * SR8 rules run unchanged (conservative default: send_email/share/reveal denied, slack escalates).
   */
  targetZone?: SR8Zone;
};

/** The decision the policy gate returns (mirrors AuthorizationResult from @/policy/actions). */
export type PolicyDecision = {
  result: "allowed" | "needs_approval" | "denied";
  reason?: string;
};
