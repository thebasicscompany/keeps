/**
 * Email sent when the user's connector account is missing for the requested provider.
 *
 * Pure: no I/O. Returns { subject, textBody, html } — callers in Wave D wire the sender.
 */

// Canonical provider union lives in @/agent/schemas — re-exported here so the
// template modules stay import-light for callers.
export type { ConnectorProvider } from "@/agent/schemas";
import type { ConnectorProvider } from "@/agent/schemas";
import { renderButtonEmailHtml } from "@/email/button-html";

export interface ConnectorMissingEmailInput {
  provider: ConnectorProvider;
  commandSummary: string;
  connectUrl: string;
}

function providerLabel(provider: ConnectorProvider): string {
  return provider === "slack" ? "Slack" : "Google Calendar";
}

export function buildConnectorMissingEmail(input: ConnectorMissingEmailInput): {
  subject: string;
  textBody: string;
  html: string;
} {
  const label = providerLabel(input.provider);

  const subject = `Connect your ${label}`;

  const textBody = [
    `You asked me to ${input.commandSummary}, but your ${label} isn't connected yet.`,
    "",
    `Connect ${label}: ${input.connectUrl}`,
    "",
    "Once you're connected, email me again and I'll take care of it.",
  ].join("\n");

  const html = renderButtonEmailHtml({
    paragraphs: [
      `You asked me to ${input.commandSummary}, but your ${label} isn't connected yet.`,
      "Once you're connected, email me again and I'll take care of it.",
    ],
    button: { label: `Connect ${label}`, url: input.connectUrl },
  });

  return { subject, textBody, html };
}
