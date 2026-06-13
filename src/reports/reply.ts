/**
 * Report email reply builder — pure string functions, no I/O, no model, no DB.
 *
 * Produces a { subject, textBody } pair from a report sections input and a
 * model-authored (or deterministic fallback) summary.
 *
 * Keeps is plain-text-first: the output is plain text, not HTML.
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

/**
 * Build a report email from the given input.
 *
 * Returns a { subject, textBody } pair suitable for sending via the email
 * delivery layer.
 */
export function buildReportEmail(input: ReportEmailInput): {
  subject: string;
  textBody: string;
} {
  return {
    subject: buildSubject(input.kind, input.scope),
    textBody: buildTextBody(input),
  };
}
