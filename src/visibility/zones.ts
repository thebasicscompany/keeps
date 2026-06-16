/**
 * SR8 zones (Wave 2) — the hierarchy-aware redefinition of "external visibility".
 *
 * The old SR8 classified an action purely by KIND (any send = external). Under org-owned
 * visibility that's wrong: "another person" is no longer uniformly external. The zone of an
 * outward action's RECIPIENT, relative to the viewer's relationship graph, decides whether it
 * auto-allows, escalates, or is denied. PURE + model-free; fails closed to the most-restricted
 * zone for anything unrecognized.
 *
 * Confirmed policy:
 *   (i)   in_scope             recipient + data within the viewer's visibility
 *   (ii)  cross_scope_internal a colleague in the org but outside the viewer's scope (LEAK SURFACE)
 *   (iiia)external_counterparty an external entity attached to a scope the viewer is in (client/partner)
 *   (iiib)external_unscoped    external with no relationship edge to any scope the viewer is in
 */
import type { ViewerScope } from "@/visibility/can-view";
import type { KeepsActionKind } from "@/policy/actions";

export type SR8Zone =
  | "in_scope"
  | "cross_scope_internal"
  | "external_counterparty"
  | "external_unscoped";

/** The recipient/target of an outward action, described against the relationship graph. */
export type ActionTarget =
  | { recipientKind: "self" }
  | { recipientKind: "internal"; orgId: string; userId: string; scopeIds?: string[] }
  | { recipientKind: "counterparty"; orgId: string; scopeIds: string[] }
  | { recipientKind: "external_unknown" };

/** Classify the SR8 zone of `target` relative to `viewer`. Total; fails closed to external_unscoped. */
export function classifyZone(viewer: ViewerScope, target: ActionTarget): SR8Zone {
  switch (target.recipientKind) {
    case "self":
      return "in_scope";
    case "internal": {
      // A different org entirely is external, never "cross-scope internal".
      if (target.orgId !== viewer.orgId) return "external_unscoped";
      if (
        target.userId === viewer.userId ||
        viewer.isOrgAdmin ||
        viewer.managedUserIds.has(target.userId) ||
        (target.scopeIds?.some((s) => viewer.scopeIds.has(s)) ?? false)
      ) {
        return "in_scope";
      }
      return "cross_scope_internal";
    }
    case "counterparty": {
      if (target.orgId !== viewer.orgId) return "external_unscoped";
      if (target.scopeIds.some((s) => viewer.scopeIds.has(s))) return "external_counterparty";
      return "external_unscoped";
    }
    default:
      return "external_unscoped";
  }
}

const PRIVATE_KINDS = new Set<KeepsActionKind>([
  "create_private_loop",
  "update_private_loop",
  "send_private_email_to_user",
  "create_private_report",
]);

export type ZoneDecision = "allowed" | "needs_approval" | "denied";

/**
 * The zone × action-kind policy table (the confirmed gate). PURE.
 *   - private kinds never leave the viewer's boundary → allowed (zone irrelevant)
 *   - reveal_source → denied in every zone (never auto-authorizable)
 *   - every other (outward) kind → escalate when the recipient is reachable within a shared scope
 *     (in_scope / external_counterparty); deny when the action would cross a boundary
 *     (cross_scope_internal / external_unscoped)
 */
export function zoneDecisionFor(actionKind: KeepsActionKind, zone: SR8Zone): ZoneDecision {
  if (PRIVATE_KINDS.has(actionKind)) return "allowed";
  if (actionKind === "reveal_source") return "denied";
  switch (zone) {
    case "in_scope":
    case "external_counterparty":
      return "needs_approval";
    case "cross_scope_internal":
    case "external_unscoped":
      return "denied";
  }
}

/**
 * Data-bounding (the leak guard from the client/partner case): every referenced resource must
 * live within a scope that connects the viewer and the recipient. Sending an Acme-scoped client
 * an Acme update is fine; folding in Beta-deal data is a leak even though the recipient is "known".
 * `connectingScopeIds` = viewer.scopeIds ∩ recipient.scopeIds. Returns false (a leak) if ANY
 * referenced resource shares no connecting scope. Fails closed when there is no connecting scope.
 */
export function dataWithinConnectingScope(
  connectingScopeIds: ReadonlySet<string>,
  referencedResourceScopeIds: string[][],
): boolean {
  if (connectingScopeIds.size === 0) return referencedResourceScopeIds.length === 0;
  return referencedResourceScopeIds.every((scopes) => scopes.some((s) => connectingScopeIds.has(s)));
}
