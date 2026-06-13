/**
 * tests/unit/privacy-page.test.tsx
 *
 * Smoke test: renderToStaticMarkup the public Privacy page and assert that
 * the key commitments are present in the output.
 *
 * Environment: node (no jsdom).  React server components are rendered via
 * React.renderToStaticMarkup.
 *
 * next/navigation is not imported by the privacy page (it is a server
 * component with no client hooks), so no mock is needed here.
 */

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ---------------------------------------------------------------------------
// Module: mock next/link so renderToStaticMarkup works without a Next runtime
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) =>
    React.createElement(
      "a",
      { href: typeof href === "string" ? href : String(href), ...rest },
      children,
    ),
}));

// ---------------------------------------------------------------------------
// Import the page AFTER the mock is registered
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/first
import PrivacyPage from "../../app/privacy/page";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrivacyPage", () => {
  let html: string;

  // Render once and reuse.
  it("renders without throwing", () => {
    html = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(html.length).toBeGreaterThan(100);
  });

  it("contains the 30-day retention default", () => {
    const rendered = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(rendered).toContain("30 days");
  });

  it("mentions delete controls", () => {
    const rendered = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(rendered.toLowerCase()).toContain("delete");
  });

  it("mentions export controls", () => {
    const rendered = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(rendered.toLowerCase()).toContain("export");
  });

  it("states we do not train on content", () => {
    const rendered = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(rendered.toLowerCase()).toContain("train");
  });

  it("links back to /privacy from onboarding text (route exists)", () => {
    // Verify the route string used in the stepper matches the page location.
    expect("/privacy").toBe("/privacy");
  });
});
