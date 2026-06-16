import type { ApprovalRequest, Draft } from "@/db/schema";
import { testActionHandler } from "@/approvals/actions/test-action";
import { sendSlackMessageHandler } from "@/approvals/actions/connector-actions";

/**
 * The plug-in contract every approved action runs through. A handler receives the draft
 * (its `payload` carries the action-specific arguments) and the approval that authorized it,
 * performs its side effect, and returns `{ ok: true, detail? }`. Throwing signals a failure
 * the execute funnel will audit and rethrow (Inngest owns retries).
 */
export type ActionHandler = (input: {
  draft: Draft;
  approval: ApprovalRequest;
}) => Promise<{ ok: true; detail?: unknown }>;

/**
 * Registry of `action_kind` → handler. Phase 4 registers `send_slack_message` /
 * `create_calendar_event` here WITHOUT touching execute.ts — the funnel only ever calls
 * `getAction`. Phase 3 registers only the `test_action` fixture.
 */
const registry = new Map<string, ActionHandler>();

export function registerAction(actionKind: string, handler: ActionHandler): void {
  registry.set(actionKind, handler);
}

export function getAction(actionKind: string): ActionHandler | undefined {
  return registry.get(actionKind);
}

registerAction("test_action", testActionHandler);
// Wave D approve→execute: an automation-escalated self-DM Slack message, executed on approval.
registerAction("send_slack_message", sendSlackMessageHandler);
