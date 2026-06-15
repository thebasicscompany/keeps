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

function commandPrefix(provider: ConnectorProvider): string {
  return provider === "slack" ? "@Slack" : "@Calendar";
}

export function buildConnectorMissingEmail(input: ConnectorMissingEmailInput): {
  subject: string;
  textBody: string;
  html: string;
} {
  const label = providerLabel(input.provider);
  const prefix = commandPrefix(input.provider);

  const subject = `Connect your ${label}`;

  // IMPORTANT: I don't keep the request pending across the connect, so the user
  // must SEND IT AGAIN once connected — a "done"/"I connected it" reply gets
  // read as a new note, not a retry. Say that explicitly.
  const resend =
    `Once you're connected, send me the request again — reply to this email starting with ` +
    `"${prefix} …" and I'll take care of it right away. (Just telling me you've connected won't ` +
    `trigger it on its own — I need the request itself.)`;

  const textBody = [
    `You asked me to ${input.commandSummary}, but your ${label} isn't connected yet.`,
    "",
    `Connect ${label}: ${input.connectUrl}`,
    "",
    resend,
  ].join("\n");

  const html = renderButtonEmailHtml({
    paragraphs: [
      `You asked me to ${input.commandSummary}, but your ${label} isn't connected yet.`,
      resend,
    ],
    button: { label: `Connect ${label}`, url: input.connectUrl },
  });

  return { subject, textBody, html };
}
