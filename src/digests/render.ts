/**
 * Digest email renderer.
 *
 * Produces plain-text-first email bodies matching the roadmap UX sample.
 * HTML body is a lightly-formatted equivalent of the text body.
 *
 * AR-9 requirements satisfied:
 *   1. Coverage line opens the digest: "Tracking N loops across M threads —
 *      Keeps sees only what you've shared."
 *   2. Capture prompt closes the digest: "What else is on your plate?
 *      Reply and I'll track it."
 *
 * Every rendered loop gets a sequential ordinal starting at ordinalStart
 * (default 1, spanning all sections in order).  The returned ordinalToLoopId
 * map is stored in nudges.metadata per AR-3.
 */

import type { DigestModel, DigestEntry } from "@/digests/build";

export interface RenderOptions {
  /**
   * Starting ordinal for the first rendered loop.
   * Defaults to 1.  Pass a higher value when composing multi-part digests.
   */
  ordinalStart?: number;
}

export interface RenderedDigestEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
  /** ordinal → loopId, for nudges.metadata (AR-3) */
  ordinalToLoopId: Record<number, string>;
}

// ---- helpers ----------------------------------------------------------------

function formatDate(d: Date | null): string {
  if (!d) return "";
  // e.g. "Mon Jun 12"
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function dueLabel(entry: DigestEntry): string {
  if (entry.dueAt) return ` (due ${formatDate(entry.dueAt)})`;
  return "";
}

// ---- text renderer ----------------------------------------------------------

interface SectionLines {
  ordinalOffset: number;
  lines: string[];
  map: Record<number, string>;
}

function renderSection(
  title: string,
  entries: DigestEntry[],
  ordinalOffset: number,
  entryFormatter: (entry: DigestEntry) => string,
): SectionLines {
  if (entries.length === 0) {
    return { ordinalOffset, lines: [], map: {} };
  }

  const lines: string[] = [];
  const map: Record<number, string> = {};

  lines.push(`${title}:`);

  for (const entry of entries) {
    const ordinal = ordinalOffset;
    map[ordinal] = entry.loopId;
    lines.push(`${ordinal}. ${entryFormatter(entry)}`);
    ordinalOffset += 1;
  }

  lines.push(""); // trailing blank line between sections
  return { ordinalOffset, lines, map };
}

/**
 * Render a DigestModel into email parts.
 *
 * Plain-text body format mirrors the roadmap UX sample:
 *
 *   Today in Keeps
 *
 *   Tracking 7 loops across 4 threads — Keeps sees only what you've shared.
 *
 *   Needs your attention:
 *   1. Acme discount decision is due today.
 *   ...
 *
 *   What else is on your plate? Reply and I'll track it.
 *
 *   Reply: snooze 1 until Monday | done 2 | insights
 */
export function renderDigestEmail(
  model: DigestModel,
  { ordinalStart = 1 }: RenderOptions = {},
): RenderedDigestEmail {
  const allOrdinalToLoopId: Record<number, string> = {};
  let ordinal = ordinalStart;

  const textLines: string[] = [];

  // ---- header ----
  textLines.push("Today in Keeps");
  textLines.push("");

  // ---- AR-9 coverage line ----
  const coverageLine =
    `Tracking ${model.totalActiveLoops} loop${model.totalActiveLoops === 1 ? "" : "s"} ` +
    `across ${model.distinctActiveThreads} thread${model.distinctActiveThreads === 1 ? "" : "s"} ` +
    `— Keeps sees only what you've shared.`;
  textLines.push(coverageLine);
  textLines.push("");

  const isEmpty =
    model.needsAttention.length === 0 &&
    model.waitingOnOthers.length === 0 &&
    model.dueSoon.length === 0 &&
    model.stale.length === 0 &&
    model.recentlyDone.length === 0;

  if (isEmpty) {
    textLines.push("Nothing to surface right now. You're all caught up.");
    textLines.push("");
  } else {
    // ---- Needs attention ----
    if (model.needsAttention.length > 0) {
      const sec = renderSection(
        "Needs your attention",
        model.needsAttention,
        ordinal,
        (e) => `${e.summary}${dueLabel(e)}`,
      );
      textLines.push(...sec.lines);
      Object.assign(allOrdinalToLoopId, sec.map);
      ordinal = sec.ordinalOffset;
    }

    // ---- Waiting on others ----
    if (model.waitingOnOthers.length > 0) {
      const sec = renderSection(
        "Waiting on others",
        model.waitingOnOthers,
        ordinal,
        (e) => e.summary,
      );
      textLines.push(...sec.lines);
      Object.assign(allOrdinalToLoopId, sec.map);
      ordinal = sec.ordinalOffset;
    }

    // ---- Due soon ----
    if (model.dueSoon.length > 0) {
      const sec = renderSection("Due soon", model.dueSoon, ordinal, (e) => {
        const label = e.dueAt ? ` — due ${formatDate(e.dueAt)}` : "";
        return `${e.summary}${label}`;
      });
      textLines.push(...sec.lines);
      Object.assign(allOrdinalToLoopId, sec.map);
      ordinal = sec.ordinalOffset;
    }

    // ---- Stale ----
    if (model.stale.length > 0) {
      const sec = renderSection("Stale", model.stale, ordinal, (e) => e.summary);
      textLines.push(...sec.lines);
      Object.assign(allOrdinalToLoopId, sec.map);
      ordinal = sec.ordinalOffset;
    }

    // ---- Recently done ----
    if (model.recentlyDone.length > 0) {
      const sec = renderSection("Recently done", model.recentlyDone, ordinal, (e) => e.summary);
      textLines.push(...sec.lines);
      Object.assign(allOrdinalToLoopId, sec.map);
      ordinal = sec.ordinalOffset;
    }
  }

  // ---- Phase 7 AR-9: auto-reconciliation summary line (optional) ----
  if (model.autoReconciled !== undefined) {
    const { advanced, closed } = model.autoReconciled;
    const parts: string[] = [];
    if (advanced > 0) parts.push(`${advanced} loop${advanced === 1 ? "" : "s"} advanced`);
    if (closed > 0) parts.push(`${closed} closed`);
    if (parts.length > 0) {
      textLines.push(`🔁 ${parts.join(" and ")} automatically from replies.`);
      textLines.push("");
    }
  }

  // ---- AR-9 capture prompt ----
  textLines.push("What else is on your plate? Reply and I'll track it.");
  textLines.push("");

  // ---- Footer with reply commands ----
  textLines.push("Reply: snooze 1 until Monday | done 2 | insights");

  const textBody = textLines.join("\n");

  // ---- Subject ----
  const totalRendered = ordinal - ordinalStart;
  const subject =
    totalRendered > 0
      ? `Keeps — ${totalRendered} loop${totalRendered === 1 ? "" : "s"} to look at`
      : "Keeps — you're all caught up";

  // ---- HTML body (light markup, same structure as text) ----
  const htmlBody = buildHtmlBody(model, allOrdinalToLoopId, ordinalStart, coverageLine, isEmpty);

  return {
    subject,
    textBody,
    htmlBody,
    ordinalToLoopId: allOrdinalToLoopId,
  };
}

// ---- HTML builder -----------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtmlBody(
  model: DigestModel,
  ordinalToLoopId: Record<number, string>,
  ordinalStart: number,
  coverageLine: string,
  isEmpty: boolean,
): string {
  // Build ordered list of entries for HTML section rendering using the same
  // ordinal progression that the text renderer computed.
  const parts: string[] = [];

  parts.push(`<div style="font-family:sans-serif;max-width:600px;color:#222">`);
  parts.push(`<h2 style="font-size:18px;margin-bottom:4px">Today in Keeps</h2>`);
  parts.push(`<p style="color:#666;font-size:13px;margin-top:0">${esc(coverageLine)}</p>`);

  if (isEmpty) {
    parts.push(`<p>Nothing to surface right now. You're all caught up.</p>`);
  } else {
    // We replay the same ordinal-assignment logic to keep HTML and text in sync
    let ordinal = ordinalStart;

    function renderHtmlSection(
      title: string,
      entries: DigestEntry[],
      fmt: (e: DigestEntry) => string,
    ): void {
      if (entries.length === 0) return;
      parts.push(`<h3 style="font-size:15px;margin-bottom:4px">${esc(title)}</h3>`);
      parts.push(`<ol start="${ordinal}" style="padding-left:20px;margin-top:0">`);
      for (const entry of entries) {
        parts.push(`<li>${esc(fmt(entry))}</li>`);
        ordinal += 1;
      }
      parts.push(`</ol>`);
    }

    if (model.needsAttention.length > 0) {
      renderHtmlSection("Needs your attention", model.needsAttention, (e) =>
        `${e.summary}${dueLabel(e)}`,
      );
    }
    if (model.waitingOnOthers.length > 0) {
      renderHtmlSection("Waiting on others", model.waitingOnOthers, (e) => e.summary);
    }
    if (model.dueSoon.length > 0) {
      renderHtmlSection("Due soon", model.dueSoon, (e) => {
        const label = e.dueAt ? ` — due ${formatDate(e.dueAt)}` : "";
        return `${e.summary}${label}`;
      });
    }
    if (model.stale.length > 0) {
      renderHtmlSection("Stale", model.stale, (e) => e.summary);
    }
    if (model.recentlyDone.length > 0) {
      renderHtmlSection("Recently done", model.recentlyDone, (e) => e.summary);
    }
  }

  // ---- Phase 7 AR-9: auto-reconciliation summary line (optional) ----
  if (model.autoReconciled !== undefined) {
    const { advanced, closed } = model.autoReconciled;
    const lineParts: string[] = [];
    if (advanced > 0) lineParts.push(`${advanced} loop${advanced === 1 ? "" : "s"} advanced`);
    if (closed > 0) lineParts.push(`${closed} closed`);
    if (lineParts.length > 0) {
      parts.push(
        `<p style="color:#555;font-size:13px">🔁 ${esc(lineParts.join(" and "))} automatically from replies.</p>`,
      );
    }
  }

  parts.push(
    `<p style="margin-top:20px"><strong>What else is on your plate? Reply and I'll track it.</strong></p>`,
  );
  parts.push(
    `<p style="color:#888;font-size:12px">Reply: snooze 1 until Monday | done 2 | insights</p>`,
  );
  parts.push(`</div>`);

  return parts.join("\n");
}
