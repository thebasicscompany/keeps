/**
 * Render smoke for the QualityDashboard presentational component.
 *
 * Node-compatible render via renderToStaticMarkup (no jsdom). No DB, no Clerk.
 * Exercises populated and empty-state branches.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QualityMetricsResult } from "@/admin/quality-metrics";
import { QualityDashboard } from "./page";

const EMPTY_DATA: QualityMetricsResult = {
  series: [],
  latestEvalRun: null,
};

const POPULATED_DATA: QualityMetricsResult = {
  series: [
    {
      metric: "draft_approval_rate",
      rows: [
        { date: "2026-06-11", value: 0.72, denominator: 50, metadata: {} },
        { date: "2026-06-12", value: 0.78, denominator: 54, metadata: {} },
      ],
    },
    {
      metric: "false_positive_nudge_rate",
      rows: [{ date: "2026-06-12", value: 0.05, denominator: null, metadata: {} }],
    },
  ],
  latestEvalRun: {
    id: "run-1",
    mode: "deterministic",
    gitSha: "abc123",
    modelId: "claude-haiku",
    caseCount: 30,
    precision: 0.91,
    recall: 0.87,
    lowConfidenceHandlingRate: 0.1,
    falsePositiveRate: 0.03,
    createdAt: new Date("2026-06-12T10:00:00.000Z"),
  },
};

describe("QualityDashboard render smoke", () => {
  it("renders empty state correctly", () => {
    const html = renderToStaticMarkup(<QualityDashboard data={EMPTY_DATA} />);
    expect(html).toContain("No metrics yet.");
    expect(html).toContain("No eval runs recorded yet.");
  });

  it("renders metric names and values", () => {
    const html = renderToStaticMarkup(<QualityDashboard data={POPULATED_DATA} />);
    expect(html).toContain("draft_approval_rate");
    expect(html).toContain("false_positive_nudge_rate");
    expect(html).toContain("2026-06-11");
    expect(html).toContain("72.0%"); // 0.72 → 72.0%
    expect(html).toContain("78.0%");
    expect(html).toContain("5.0%");
  });

  it("renders bar sparklines", () => {
    const html = renderToStaticMarkup(<QualityDashboard data={POPULATED_DATA} />);
    // The bar function produces block chars.
    expect(html).toContain("█");
  });

  it("renders the latest eval run panel", () => {
    const html = renderToStaticMarkup(<QualityDashboard data={POPULATED_DATA} />);
    expect(html).toContain("deterministic");
    expect(html).toContain("abc123");
    expect(html).toContain("claude-haiku");
    expect(html).toContain("30"); // caseCount
    expect(html).toContain("91.0%"); // precision
    expect(html).toContain("87.0%"); // recall
    expect(html).toContain("2026-06-12T10:00:00.000Z");
  });
});
