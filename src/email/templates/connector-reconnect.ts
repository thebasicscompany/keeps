/**
 * Email sent when Keeps loses access to a connector (Nango auth_error / refresh_error).
 *
 * Pure: no I/O. Returns { subject, textBody } — callers in Wave D wire the sender.
 */

import type { ConnectorProvider } from "./connector-missing";

export { type ConnectorProvider } from "./connector-missing";

export interface ConnectorReconnectEmailInput {
  provider: ConnectorProvider;
  reason: string | null;
  reconnectUrl: string;
}

function providerLabel(provider: ConnectorProvider): string {
  return provider === "slack" ? "Slack" : "Google Calendar";
}

export function buildConnectorReconnectEmail(input: ConnectorReconnectEmailInput): {
  subject: string;
  textBody: string;
} {
  const label = providerLabel(input.provider);

  const subject = `Reconnect your ${label}`;

  const reasonClause = input.reason ? ` (${input.reason})` : "";

  const textBody = [
    `Keeps lost access to your ${label}${reasonClause}. Reconnect to continue using connector commands.`,
    "",
    `Reconnect: ${input.reconnectUrl}`,
  ].join("\n");

  return { subject, textBody };
}
