/**
 * Report email reply builder — pure string functions, no I/O, no model, no DB.
 *
 * Produces a { subject, textBody, html } triple from a report sections input and a
 * model-authored (or deterministic fallback) summary.
 *
 * Keeps is plain-text-first: textBody is canonical. html is an enhancement (seafoam button).
 */

export type ReportEmailKind = "insights" | "waiting_on" | "stale" | "weekly" | "entity";

/**
 * Minimal input type — structurally compatible with ReportSections from
 * src/reports/query.ts (not imported to avoid coupling the build during
 * parallel development).
 */
export type ReportEmailInput = {
  kind: ReportEmailKind;
  scope: { entity?: string } & Record<string, unknown>;
  totalOpen: number;
  /** Structurally compatible with ReportSections.sections */
  sections: { key: string; title: string; rows: { loop: { summary: string } }[] }[];
  /** The signed /r/<token> URL */
  link: string;
  /** Model-authored summary (or deterministic fallback from caller) */
  summary: { headline: string; bullets: string[] };
};

// ---------------------------------------------------------------------------
// Subject line
// ---------------------------------------------------------------------------

/**
 * Build the email subject line for a given report kind.
 *
 * Entity kind interpolates scope.entity; falls back to the insights subject
 * when scope.entity is falsy.
 */
function buildSubject(kind: ReportEmailKind, scope: ReportEmailInput["scope"]): string {
  switch (kind) {
    case "insights":
      return "Your Keeps insights";
    case "waiting_on":
      return "What you are waiting on";
    case "stale":
      return "Stale loops";
    case "weekly":
      return "Weekly summary";
    case "entity":
      return scope.entity ? `Loops for ${scope.entity}` : "Your Keeps insights";
  }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/**
 * Collect the first up-to-3 row summaries across all sections in order,
 * skipping empty sections.
 */
function firstRowSummaries(
  sections: ReportEmailInput["sections"],
  max: number,
): string[] {
  const results: string[] = [];
  for (const section of sections) {
    for (const row of section.rows) {
      if (results.length >= max) break;
      results.push(row.loop.summary);
    }
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Build the plain-text email body.
 *
 * Shape (roadmap example):
 * ```
 * You have <N> open loops.
 *
 * Most important:
 * 1. <bullet 1>
 * 2. <bullet 2>
 * 3. <bullet 3>
 *
 * Private view: <link>
 *
 * Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.
 * ```
 *
 * Rules:
 * - First line: summary.headline if non-empty, else deterministic fallback.
 * - Bullets: summary.bullets if non-empty, else first ≤3 row summaries.
 * - Zero items: "Nothing needs your attention right now." (footer omitted).
 * - Footer included only when at least one bullet/row is listed.
 * - No trailing newline.
 */
function buildTextBody(input: ReportEmailInput): string {
  const { totalOpen, sections, link, summary } = input;

  // First line
  const firstLine =
    summary.headline.trim().length > 0
      ? summary.headline.trim()
      : `You have ${totalOpen} open loop${totalOpen === 1 ? "" : "s"}.`;

  // Determine bullets to display
  const modelBullets = summary.bullets.filter((b) => b.trim().length > 0);
  const bullets =
    modelBullets.length > 0 ? modelBullets : firstRowSummaries(sections, 3);

  const hasItems = bullets.length > 0;

  const parts: string[] = [];

  // First line
  parts.push(firstLine);

  // Items block or empty state
  if (hasItems) {
    parts.push("Most important:\n" + bullets.map((b, i) => `${i + 1}. ${b}`).join("\n"));
  } else {
    parts.push("Nothing needs your attention right now.");
  }

  // Private view link (always present)
  parts.push(`Private view: ${link}`);

  // Commandable footer (only when items exist)
  if (hasItems) {
    parts.push("Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.");
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

import { renderButtonEmailHtml } from "@/email/button-html";

/**
 * Build a report email from the given input.
 *
 * Returns a { subject, textBody, html } triple suitable for sending via the email
 * delivery layer. textBody is canonical (plain-text-first); html is an enhancement
 * with a square seafoam "View your report" button.
 */
export function buildReportEmail(input: ReportEmailInput): {
  subject: string;
  textBody: string;
  html: string;
} {
  const textBody = buildTextBody(input);
  const html = renderButtonEmailHtml({
    paragraphs: [
      input.summary.headline.trim().length > 0
        ? input.summary.headline.trim()
        : `You have ${input.totalOpen} open loop${input.totalOpen === 1 ? "" : "s"}.`,
      "Your private report is ready — tap below to view it.",
    ],
    button: { label: "View your report", url: input.link },
    footnote:
      'This private link is valid for 7 days. Reply with commands like "done 1, snooze 2 until Monday" to act on these loops.',
  });
  return {
    subject: buildSubject(input.kind, input.scope),
    textBody,
    html,
  };
}
