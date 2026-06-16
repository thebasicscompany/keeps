/**
 * Automations settings view-models (Wave 4) — PURE. Project the code-defined recipe registry +
 * a user's standing grants into render-ready rows for /settings/automations. No DB, no Clerk,
 * no model — fully unit-testable; the page resolves the user and loads grants, then calls these.
 */
import { RECIPE_KEYS, RECIPE_REGISTRY } from "@/automation/recipe-registry";
import type { RecipeKey } from "@/automation/types";

const ACTION_LABELS: Record<string, string> = {
  send_private_email_to_user: "email you privately",
  create_private_report: "build a private report",
  update_private_loop: "update your loops",
  create_private_loop: "create loops",
  send_slack_message: "send a Slack message",
  create_calendar_event: "create a calendar event",
  send_email: "email someone else",
  share_loop: "share a loop",
  reveal_source: "reveal source quotes",
};

function label(kind: string): string {
  return ACTION_LABELS[kind] ?? kind;
}

export type RecipeCatalogItem = {
  key: RecipeKey;
  displayName: string;
  description: string;
  /** Human-readable "what it reads" lines (drives the disclosure UX). */
  reads: string[];
  /** Actions it can take automatically (private kinds). */
  autoActions: string[];
  /** Actions it can take only after you approve each one (externally visible). */
  approvalActions: string[];
  /** Grant lifetime in days. */
  expiryDays: number;
};

/** The full recipe catalog, in declared order. */
export function buildRecipeCatalog(): RecipeCatalogItem[] {
  return RECIPE_KEYS.map((key) => {
    const def = RECIPE_REGISTRY[key];
    const approval = new Set(def.approvalRequiredActionKinds);
    return {
      key,
      displayName: def.displayName,
      description: def.description,
      reads: def.declaredReads,
      autoActions: def.allowedActionKinds.filter((k) => !approval.has(k)).map(label),
      approvalActions: def.approvalRequiredActionKinds.map(label),
      expiryDays: def.defaultExpiryDays,
    };
  });
}

export type GrantRowVM = {
  recipeKey: string;
  recipeName: string;
  status: string;
  /** ISO or null. */
  expiresAt: string | null;
  /** true when status is active and not past expiry. */
  live: boolean;
};

/** Project a stored standing-grant row into a settings row. PURE; `now` injected for testability. */
export function grantRowViewModel(
  grant: { recipeKey: string; status: string; expiresAt: Date | null },
  now: Date,
): GrantRowVM {
  const def = RECIPE_KEYS.includes(grant.recipeKey as RecipeKey)
    ? RECIPE_REGISTRY[grant.recipeKey as RecipeKey]
    : null;
  const expired = grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime();
  return {
    recipeKey: grant.recipeKey,
    recipeName: def?.displayName ?? grant.recipeKey,
    status: grant.status,
    expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
    live: grant.status === "active" && !expired,
  };
}

export type RunRowVM = {
  id: string;
  recipeName: string;
  status: string;
  startedAt: string | null;
  /** One-line "why" (provenance) or skip reason — never raw evidence. */
  detail: string;
};

/** Project an automation_runs row into a run-history row. PURE. */
export function automationRunRowViewModel(run: {
  id: string;
  recipeKey: string;
  status: string;
  startedAt: Date | null;
  provenance: unknown;
}): RunRowVM {
  const def = RECIPE_KEYS.includes(run.recipeKey as RecipeKey)
    ? RECIPE_REGISTRY[run.recipeKey as RecipeKey]
    : null;
  const prov = (run.provenance as { line?: string; skipReason?: string } | null) ?? {};
  const detail = prov.line ?? (prov.skipReason ? `skipped: ${prov.skipReason}` : "");
  return {
    id: run.id,
    recipeName: def?.displayName ?? run.recipeKey,
    status: run.status,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    detail,
  };
}
