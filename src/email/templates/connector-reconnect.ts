/**
 * Email sent when Keeps loses access to a connector (Nango auth_error / refresh_error).
 *
 * Pure: no I/O. Returns { subject, textBody, html } — callers in Wave D wire the sender.
 */

import type { ConnectorProvider } from "./connector-missing";
import { renderButtonEmailHtml } from "@/email/button-html";

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
  html: string;
} {
  const label = providerLabel(input.provider);

  const subject = `Reconnect your ${label}`;

  const reasonClause = input.reason ? ` (${input.reason})` : "";

  const textBody = [
    `Keeps lost access to your ${label}${reasonClause}. Reconnect to continue using connector commands.`,
    "",
    `Reconnect: ${input.reconnectUrl}`,
  ].join("\n");

  const html = renderButtonEmailHtml({
    paragraphs: [
      `Keeps lost access to your ${label}${reasonClause}. Reconnect to continue using connector commands.`,
    ],
    button: { label: `Reconnect ${label}`, url: input.reconnectUrl },
  });

  return { subject, textBody, html };
}
