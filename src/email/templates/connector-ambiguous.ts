/**
 * Email sent when a connector command matches multiple recipients and Keeps cannot
 * determine which one the user meant.
 *
 * Pure: no I/O. Returns { subject, textBody } — callers in Wave D wire the sender.
 */

export interface AmbiguousCandidate {
  name: string;
  email: string | null;
}

export interface ConnectorAmbiguousEmailInput {
  recipientNameText: string;
  candidates: AmbiguousCandidate[];
  commandSummary: string;
}

export function buildConnectorAmbiguousEmail(input: ConnectorAmbiguousEmailInput): {
  subject: string;
  textBody: string;
} {
  const { recipientNameText, candidates, commandSummary } = input;
  const count = candidates.length;

  const subject = `Who did you mean? ${recipientNameText}`;

  // Numbered candidate list — stable insertion order, 1-indexed.
  const candidateLines = candidates.map((c, i) => {
    const ordinal = i + 1;
    const emailPart = c.email ? ` (${c.email})` : "";
    return `  ${ordinal}. ${c.name}${emailPart}`;
  });

  const textBody = [
    `I found ${count} ${count === 1 ? "person" : "people"} matching "${recipientNameText}" for: ${commandSummary}`,
    "",
    ...candidateLines,
    "",
    "Reply with the number of the person you meant, or their email address, and I'll continue.",
  ].join("\n");

  return { subject, textBody };
}
