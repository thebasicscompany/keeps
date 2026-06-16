/**
 * Recipe registry (Wave C) — the code-defined catalog of every V2 automation.
 *
 * Recipes are CODE, not DB rows: a grant can only target a key that exists here, and a
 * grant is valid only if it stays inside the recipe's declared envelope (deny-by-default,
 * SR1/SR2). `isKnownRecipe` keeps the Wave B signature stable so `authorize()` never changes.
 *
 * SR5 boundary: this module is pure + model-free. It declares WHAT a recipe may read/do;
 * the model never decides permission.
 */
import { z } from "zod";
import type { KeepsActionKind } from "@/policy/actions";
import type { GrantCaps, QuietHours, RecipeKey } from "@/automation/types";

export const RECIPE_KEYS = [
  "pre_meeting_brief",
  "post_meeting_prompt",
  "stale_loop_followup",
  "self_only_calendar_reminder",
] as const;

const RECIPE_KEY_SET: ReadonlySet<string> = new Set(RECIPE_KEYS);

export function isKnownRecipe(recipeKey: string): recipeKey is RecipeKey {
  return RECIPE_KEY_SET.has(recipeKey);
}

export type RecipeTriggerKind = "calendar_event" | "loop_stale" | "explicit_command" | "cron";

export type RecipeDefinition = {
  key: RecipeKey;
  displayName: string;
  description: string;
  triggerKind: RecipeTriggerKind;
  /** Human-readable list of what this recipe reads (drives grant-disclosure UX). */
  declaredReads: string[];
  /** Action kinds this recipe MAY perform — the envelope a grant must stay within. */
  allowedActionKinds: KeepsActionKind[];
  /** Action kinds this recipe must NEVER perform (a grant must block at least these). */
  blockedActionKinds: KeepsActionKind[];
  /** Allowed kinds that still escalate to per-run approval (externally visible, SR8). */
  approvalRequiredActionKinds: KeepsActionKind[];
  /** Zod schema validating a grant's scope object for this recipe (strict → SR1). */
  scopeSchema: z.ZodTypeAny;
  defaultCaps: GrantCaps;
  defaultQuietHours: QuietHours;
  /** Default grant lifetime: 90d private, 30d connector-writing (Open Q1). */
  defaultExpiryDays: number;
};

export const RECIPE_REGISTRY: Readonly<Record<RecipeKey, RecipeDefinition>> = Object.freeze({
  pre_meeting_brief: {
    key: "pre_meeting_brief",
    displayName: "Pre-meeting brief",
    description: "Private brief before a meeting with someone you have open loops with.",
    triggerKind: "calendar_event",
    declaredReads: [
      "calendar event metadata (title, attendees, start/end) — never the description/body",
      "loops, loop events, and source evidence already visible to you for attendee entities",
    ],
    allowedActionKinds: ["send_private_email_to_user", "create_private_report"],
    blockedActionKinds: ["send_email", "send_slack_message", "create_calendar_event", "share_loop", "reveal_source"],
    approvalRequiredActionKinds: [],
    scopeSchema: z.object({ leadMinutes: z.number().int().min(5).max(480).optional() }).strict(),
    defaultCaps: { send_private_email_to_user: { limit: 10, window: "day" } },
    defaultQuietHours: { startHour: 21, endHour: 8 },
    defaultExpiryDays: 90,
  },
  post_meeting_prompt: {
    key: "post_meeting_prompt",
    displayName: "Post-meeting capture prompt",
    description: "Private prompt after a meeting asking whether there are commitments to capture.",
    triggerKind: "calendar_event",
    declaredReads: [
      "calendar event metadata only — never the description/body",
      "whether a related loop was already captured (absence signal)",
    ],
    allowedActionKinds: ["send_private_email_to_user"],
    blockedActionKinds: ["send_email", "send_slack_message", "create_calendar_event", "share_loop", "reveal_source"],
    approvalRequiredActionKinds: [],
    scopeSchema: z.object({ lookbackMinutes: z.number().int().min(5).max(480).optional() }).strict(),
    defaultCaps: { send_private_email_to_user: { limit: 10, window: "day" } },
    defaultQuietHours: { startHour: 21, endHour: 8 },
    defaultExpiryDays: 90,
  },
  stale_loop_followup: {
    key: "stale_loop_followup",
    displayName: "Stale-loop follow-up draft",
    description: "Drafts a follow-up for a loop with no activity; private by default, external sends need approval.",
    triggerKind: "loop_stale",
    declaredReads: ["loop summary", "source evidence", "entity context", "recent loop events"],
    allowedActionKinds: [
      "send_private_email_to_user",
      "create_private_report",
      "send_slack_message",
      "create_calendar_event",
    ],
    blockedActionKinds: ["send_email", "share_loop", "reveal_source"],
    approvalRequiredActionKinds: ["send_slack_message", "create_calendar_event"],
    scopeSchema: z.object({ staleDays: z.number().int().min(1).max(90).optional() }).strict(),
    defaultCaps: {
      send_private_email_to_user: { limit: 5, window: "day" },
      create_private_report: { limit: 5, window: "day" },
    },
    defaultQuietHours: { startHour: 21, endHour: 8 },
    defaultExpiryDays: 30,
  },
  self_only_calendar_reminder: {
    key: "self_only_calendar_reminder",
    displayName: "Self-only calendar reminders",
    description: "Creates a self-only calendar reminder when you explicitly ask with @Calendar.",
    triggerKind: "explicit_command",
    declaredReads: ["your explicit @Calendar command", "your connected calendar account"],
    allowedActionKinds: ["create_calendar_event"],
    blockedActionKinds: ["send_email", "send_slack_message", "share_loop", "reveal_source"],
    approvalRequiredActionKinds: [],
    scopeSchema: z
      .object({
        maxDurationMinutes: z.number().int().min(5).max(240).optional(),
        maxLookaheadDays: z.number().int().min(1).max(365).optional(),
      })
      .strict(),
    defaultCaps: { create_calendar_event: { limit: 20, window: "day" } },
    // Explicit user command → exempt from quiet hours (the user is actively asking).
    defaultQuietHours: {},
    defaultExpiryDays: 30,
  },
});

export function getRecipe(key: string): RecipeDefinition | null {
  return isKnownRecipe(key) ? RECIPE_REGISTRY[key] : null;
}
