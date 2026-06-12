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

export function requiresApproval(action: KeepsActionKind): boolean {
  return externalActions.has(action);
}

export function assertApprovalAllowed(action: KeepsActionKind, approvalId?: string | null) {
  if (requiresApproval(action) && !approvalId) {
    throw new Error(`Action "${action}" requires an approval_request before execution.`);
  }
}
