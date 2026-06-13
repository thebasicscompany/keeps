/**
 * Approval email for connector actions (Slack DM and Calendar event).
 *
 * For slack_dm: full approval gate — shows exactly what will be sent and to whom,
 * with approve/cancel links and the standard reply-command footer.
 *
 * For calendar_event: confirmation-window pattern — "I'll add this in 15 minutes
 * unless you cancel", cancel link, and a trimmed reply footer (cancel / edit).
 *
 * Pure: no I/O. Returns { subject, textBody } — callers in Wave D wire the sender.
 *
 * SECURITY: the plaintext token appears ONLY inside the approve/cancel URLs (rule 7).
 * It is never echoed separately in the body.
 */

import { buildApprovalLinks } from "@/approvals/links";

export type ConnectorApprovalAction =
  | {
      kind: "slack_dm";
      recipientName: string;
      recipientSlackHandleOrEmail: string | null;
      message: string;
    }
  | {
      kind: "calendar_event";
      title: string;
      whenLocal: string;
      durationMinutes: number | null;
    };

export interface ConnectorApprovalEmailInput {
  approvalId: string;
  token: string;
  appUrl: string;
  action: ConnectorApprovalAction;
}

function buildSlackDmApprovalEmail(
  approveUrl: string,
  cancelUrl: string,
  action: Extract<ConnectorApprovalAction, { kind: "slack_dm" }>,
): { subject: string; textBody: string } {
  const recipientLine = action.recipientSlackHandleOrEmail
    ? `To: ${action.recipientName} (${action.recipientSlackHandleOrEmail})`
    : `To: ${action.recipientName}`;

  // Indent the verbatim message so it visually stands apart from surrounding text.
  const indentedMessage = action.message
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

  const subject = `Approval needed: Slack message to ${action.recipientName}`;

  const textBody = [
    "Keeps will send this Slack message on your behalf:",
    "",
    recipientLine,
    "",
    indentedMessage,
    "",
    `Approve: ${approveUrl}`,
    `Cancel:  ${cancelUrl}`,
    "",
    "Or just reply to this email:",
    "  reply  approve            — send it",
    "  reply  reject             — don't send it",
    "  reply  edit: <changes>    — tell me what to change",
  ].join("\n");

  return { subject, textBody };
}

function buildCalendarEventApprovalEmail(
  cancelUrl: string,
  action: Extract<ConnectorApprovalAction, { kind: "calendar_event" }>,
): { subject: string; textBody: string } {
  const durationLine =
    action.durationMinutes !== null
      ? `Duration: ${action.durationMinutes} minutes`
      : null;

  const subject = `Confirm: calendar event — ${action.title}`;

  const lines = [
    "I'll add this to your calendar in 15 minutes unless you cancel:",
    "",
    `Event: ${action.title}`,
    `When:  ${action.whenLocal}`,
  ];

  if (durationLine) {
    lines.push(durationLine);
  }

  lines.push(
    "",
    `Cancel: ${cancelUrl}`,
    "",
    "Or just reply to this email:",
    "  reply  cancel             — don't add it",
    "  reply  edit: <changes>    — tell me what to change",
  );

  return { subject, textBody: lines.join("\n") };
}

export function buildConnectorApprovalEmail(input: ConnectorApprovalEmailInput): {
  subject: string;
  textBody: string;
} {
  const { approveUrl, cancelUrl } = buildApprovalLinks({
    approvalId: input.approvalId,
    token: input.token,
    appUrl: input.appUrl,
  });

  if (input.action.kind === "slack_dm") {
    return buildSlackDmApprovalEmail(approveUrl, cancelUrl, input.action);
  }

  // calendar_event: confirmation-window pattern — approve link is not used
  // (execution fires automatically after the timeout unless cancelled).
  return buildCalendarEventApprovalEmail(cancelUrl, input.action);
}
