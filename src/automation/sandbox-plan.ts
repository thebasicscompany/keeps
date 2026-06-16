/**
 * Sandbox plan (Wave C, FR5/SR5/SR6) — the stored "what this run intends to do" object,
 * built BEFORE any execution or approval. `requiresApproval` is DETERMINISTIC (computed from
 * the recipe's approval-required set ∩ intended actions) so a hostile model draft can never
 * flip it. `contextUsed` carries IDs only — never raw source-evidence bodies.
 */
import { getRecipe } from "@/automation/recipe-registry";
import { assertProvenancePresent, provenanceLineFor, type ProvenanceContext } from "@/automation/provenance";
import type { KeepsActionKind } from "@/policy/actions";
import type { RecipeKey } from "@/automation/types";

export type IntendedAction = {
  kind: KeepsActionKind;
  /** IDs + non-secret refs only (e.g. { loopId, channelHint }). Never tokens or evidence bodies. */
  target: Record<string, unknown>;
};

export type SandboxPlan = {
  recipeKey: RecipeKey;
  triggerKind: string;
  triggerRef?: string;
  contextUsed: {
    loopIds?: string[];
    entityIds?: string[];
    eventIds?: string[];
    calendarEventId?: string;
  };
  intendedActions: IntendedAction[];
  generatedContent?: { subject?: string; body?: string };
  provenanceLine: string;
  requiresApproval: boolean;
};

export function buildSandboxPlan(input: {
  recipeKey: RecipeKey;
  triggerKind: string;
  triggerRef?: string;
  contextUsed?: SandboxPlan["contextUsed"];
  intendedActions: IntendedAction[];
  provenanceContext?: ProvenanceContext;
  /** Injected model draft (SR5: the model only fills content, never the approval decision). */
  draft?: { subject?: string; body?: string };
}): SandboxPlan {
  const recipe = getRecipe(input.recipeKey);
  if (!recipe) throw new Error(`buildSandboxPlan: unknown recipe ${input.recipeKey}`);

  const approvalSet = new Set<KeepsActionKind>(recipe.approvalRequiredActionKinds);
  const requiresApproval = input.intendedActions.some((a) => approvalSet.has(a.kind));

  const provenanceLine = provenanceLineFor(input.recipeKey, input.provenanceContext ?? {});
  assertProvenancePresent(provenanceLine);

  return {
    recipeKey: input.recipeKey,
    triggerKind: input.triggerKind,
    triggerRef: input.triggerRef,
    contextUsed: input.contextUsed ?? {},
    intendedActions: input.intendedActions,
    generatedContent: input.draft,
    provenanceLine,
    requiresApproval,
  };
}
