/**
 * D5 — report component render smoke tests
 *
 * Node-compatible render smoke using `renderToStaticMarkup` from "react-dom/server".
 * No jsdom. next/navigation is mocked so the client RowActions component's
 * useRouter does not throw during SSR.
 *
 * Components under test: ReportHeader, ReportSection (→ LoopRow → SourceEvidenceChip).
 * RowActions is a "use client" component with useState/useRouter; it renders to a
 * button group in static markup (hooks are no-ops in renderToStaticMarkup).
 *
 * DEAD_END_COPY assertion: because app/r/[token]/page.tsx is an async Server Component
 * that depends on Clerk + Drizzle and cannot be rendered in Node, we assert the copy
 * constant's presence by reading the source file directly.
 */

import { vi } from "vitest";

// Mock next/navigation before any component imports
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

// Also mock next/server in case any transitively imported module uses it
vi.mock("next/server", () => ({}));

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ReportHeader } from "@/reports/components/ReportHeader";
import { ReportSection } from "@/reports/components/ReportSection";
import type { ReportSection as ReportSectionData, ReportRow, ReportLoop } from "@/reports/query";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TOKEN = "test-token-abc123";
const NOW = new Date("2026-06-13T12:00:00.000Z");

function makeLoop(overrides: Partial<ReportLoop> & { id: string }): ReportLoop {
  return {
    id: overrides.id,
    status: overrides.status ?? "open",
    summary: overrides.summary ?? `Summary ${overrides.id}`,
    ownerText: overrides.ownerText ?? null,
    requesterText: overrides.requesterText ?? null,
    dueAt: overrides.dueAt ?? null,
    confidence: overrides.confidence ?? 0.8,
    participants: overrides.participants ?? [],
    sourceQuote: overrides.sourceQuote ?? `"The quote for ${overrides.id}"`,
    sourceEvidenceId: overrides.sourceEvidenceId ?? `ev-${overrides.id}`,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-06-01T00:00:00.000Z"),
  };
}

function makeRow(loop: ReportLoop, overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    loop,
    dueRelativeMs: overrides.dueRelativeMs ?? null,
    importance: overrides.importance ?? 0.8,
  };
}

// One loop per section that will populate, one section intentionally empty
const NEEDS_YOU_LOOP = makeLoop({
  id: "L-needs-you",
  status: "waiting_on_me",
  summary: "Reply to Alice about contract",
  sourceQuote: "Please reply to Alice by end of week regarding the contract terms",
});

const DUE_SOON_LOOP = makeLoop({
  id: "L-due-soon",
  status: "open",
  summary: "Finish the proposal deck",
  sourceQuote: "Need the proposal deck done before the Friday meeting",
  dueAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
});

const OVERDUE_LOOP = makeLoop({
  id: "L-overdue",
  status: "open",
  summary: "Send quarterly report",
  sourceQuote: "Q2 report was due last week",
  dueAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
});

const WAITING_LOOP = makeLoop({
  id: "L-waiting",
  status: "waiting_on_other",
  summary: "Awaiting Bob's design review",
  sourceQuote: "Waiting on Bob to finish the design review before proceeding",
});

const RECENTLY_DONE_LOOP = makeLoop({
  id: "L-done",
  status: "done",
  summary: "Filed the legal docs",
  sourceQuote: "Legal docs have been filed with the court",
  updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
});

/** All 6 sections: stale is intentionally empty (no qualifying loops in fixture) */
const SIX_SECTIONS: ReportSectionData[] = [
  {
    key: "needs_you",
    title: "Needs you",
    rows: [makeRow(NEEDS_YOU_LOOP)],
  },
  {
    key: "due_soon",
    title: "Due soon",
    rows: [makeRow(DUE_SOON_LOOP, { dueRelativeMs: 3 * 24 * 60 * 60 * 1000 })],
  },
  {
    key: "overdue",
    title: "Overdue",
    rows: [makeRow(OVERDUE_LOOP, { dueRelativeMs: -2 * 24 * 60 * 60 * 1000 })],
  },
  {
    key: "waiting_on_others",
    title: "Waiting on others",
    rows: [makeRow(WAITING_LOOP)],
  },
  {
    // Intentionally empty to test collapse
    key: "stale",
    title: "Stale",
    rows: [],
  },
  {
    key: "recently_done",
    title: "Recently done",
    rows: [makeRow(RECENTLY_DONE_LOOP)],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("D5 — report component render smoke (renderToStaticMarkup)", () => {
  it("ReportHeader renders the kind label and open-loop count", () => {
    const html = renderToStaticMarkup(
      ReportHeader({ kind: "insights", scope: {}, totalOpen: 3, now: NOW }),
    );

    // Kind label
    expect(html).toContain("Insights");
    // Open loop count text
    expect(html).toContain("3 open loops");
  });

  it("ReportSection with canViewSensitiveEvidence=false shows sign-in lock link, hides source quote", () => {
    const section = SIX_SECTIONS[0]!; // needs_you section with NEEDS_YOU_LOOP
    const html = renderToStaticMarkup(
      ReportSection({ section, token: TOKEN, canViewSensitiveEvidence: false }),
    );

    // Should contain the sign-in affordance for anonymous viewers
    expect(html).toContain(`/sign-in?next=/r/${TOKEN}`);

    // Should NOT contain the actual source quote text
    expect(html).not.toContain("Please reply to Alice by end of week regarding the contract terms");
  });

  it("ReportSection with canViewSensitiveEvidence=true shows source quote, hides sign-in link", () => {
    const section = SIX_SECTIONS[0]!; // needs_you section with NEEDS_YOU_LOOP
    const html = renderToStaticMarkup(
      ReportSection({ section, token: TOKEN, canViewSensitiveEvidence: true }),
    );

    // Should contain the source quote
    expect(html).toContain("Please reply to Alice by end of week regarding the contract terms");

    // Should NOT contain the sign-in link
    expect(html).not.toContain("/sign-in?next=");
  });

  it("empty section renders the collapsed muted 'none' line and does not crash", () => {
    const emptySection = SIX_SECTIONS[4]!; // stale is empty
    expect(emptySection.rows).toHaveLength(0);

    const html = renderToStaticMarkup(
      ReportSection({ section: emptySection, token: TOKEN, canViewSensitiveEvidence: false }),
    );

    // Should contain the section title
    expect(html).toContain("Stale");
    // Should contain the "none" muted text
    expect(html).toContain("none");
    // Should NOT have any list items (Card list is absent for empty sections)
    expect(html).not.toContain("<ul");
  });

  it("renders all six sections and each non-empty section title appears in the output", () => {
    const htmls = SIX_SECTIONS.map((section) =>
      renderToStaticMarkup(
        ReportSection({ section, token: TOKEN, canViewSensitiveEvidence: false }),
      ),
    );

    // Check each section's title appears in its respective render
    const nonEmptySections = SIX_SECTIONS.filter((s) => s.rows.length > 0);
    for (const section of nonEmptySections) {
      const idx = SIX_SECTIONS.indexOf(section);
      expect(htmls[idx]).toContain(section.title);
    }

    // Empty section also contains its title
    const emptyIdx = SIX_SECTIONS.findIndex((s) => s.rows.length === 0);
    expect(htmls[emptyIdx]).toContain(SIX_SECTIONS[emptyIdx]!.title);
  });

  it("DEAD_END_COPY — the exact dead-end string is present in app/r/[token]/page.tsx source", () => {
    // The async Server Component page cannot be rendered in Node (it needs Clerk + Drizzle),
    // so we assert the copy constant by reading the source file directly.
    // __dirname in this test file = src/reports/__tests__
    // Navigate: ../../.. → project root, then app/r/[token]/page.tsx
    const pagePath = path.resolve(
      __dirname,
      "../../../app/r/[token]/page.tsx",
    );

    const source = readFileSync(pagePath, "utf-8");

    expect(source).toContain(
      'This Keeps view is no longer available. Email "what are my insights?" for a fresh link.',
    );
  });
});
