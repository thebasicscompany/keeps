/**
 * Phase V2 automation types — shared across policy (Wave B), the recipe registry +
 * sandbox planner (Wave C), the executor (Wave D), and the UX surfaces (Wave E).
 *
 * Type-only dependency on @/policy/actions (KeepsActionKind) — erased at runtime, so
 * the mutual policy<->types reference creates no import cycle.
 */
import type { KeepsActionKind } from "@/policy/actions";

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
};

/** The decision the policy gate returns (mirrors AuthorizationResult from @/policy/actions). */
export type PolicyDecision = {
  result: "allowed" | "needs_approval" | "denied";
  reason?: string;
};
