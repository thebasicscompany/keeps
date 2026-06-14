/**
 * Render smoke test for the ReconciliationsTable presentational component.
 *
 * Node-compatible render via renderToStaticMarkup (no jsdom). next/navigation is
 * mocked so any client component useRouter calls don't throw during SSR.
 * No DB, no Clerk.
 */

import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/admin/reconciliations",
}));

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReconciliationRow } from "@/admin/reconciliations";
import { ReconciliationsTable } from "./page";

function makeRow(overrides: Partial<ReconciliationRow> & { id: string }): ReconciliationRow {
  return {
    id: overrides.id,
    loopId: overrides.loopId ?? "loop-uuid-1",
    loopSummary: overrides.loopSummary ?? "Send Maya the deck by Friday.",
    eventType: overrides.eventType ?? "reconciled",
    metadata: overrides.metadata ?? {
      action: "update",
      reason: "Reply confirmed the deck was sent.",
      evidence: "Got it, sending over now.",
    },
    createdAt: overrides.createdAt ?? new Date("2026-06-14T10:00:00.000Z"),
  };
}

describe("ReconciliationsTable render smoke", () => {
  it("renders empty state when no events", () => {
    const html = renderToStaticMarkup(<ReconciliationsTable rows={[]} />);
    expect(html).toContain("No reconciliation events yet.");
  });

  it("renders decision label for a reconciled/update row", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({
            id: "e-1",
            eventType: "reconciled",
            metadata: { action: "update", reason: "Reply confirmed.", evidence: "Done!" },
          }),
        ]}
      />,
    );
    expect(html).toContain("Auto-updated");
  });

  it("renders decision label for a reconciled/close row", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({
            id: "e-2",
            eventType: "reconciled",
            metadata: { action: "close", reason: "Thread resolved.", evidence: "All done." },
          }),
        ]}
      />,
    );
    expect(html).toContain("Auto-closed");
  });

  it("renders Asked label for reconcile_suggested", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({
            id: "e-3",
            eventType: "reconcile_suggested",
            metadata: {
              reason: "Possible duplicate — asked user.",
              evidence: "Looks similar to loop-uuid-1.",
            },
          }),
        ]}
      />,
    );
    expect(html).toContain("Asked");
  });

  it("renders Superseded label for superseded events", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({
            id: "e-4",
            eventType: "superseded",
            metadata: { reason: "User confirmed duplicate.", evidence: "Yes, same thread." },
          }),
        ]}
      />,
    );
    expect(html).toContain("Superseded");
  });

  it("renders the loop summary", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[makeRow({ id: "e-5", loopSummary: "Acme contract follow-up" })]}
      />,
    );
    expect(html).toContain("Acme contract follow-up");
  });

  it("renders the reason text", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({
            id: "e-6",
            metadata: { action: "update", reason: "Reply confirmed the task is done.", evidence: "ok" },
          }),
        ]}
      />,
    );
    expect(html).toContain("Reply confirmed the task is done.");
  });

  it("renders the evidence text", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({
            id: "e-7",
            metadata: {
              action: "update",
              reason: "Some reason.",
              evidence: "The reply said: sending it now.",
            },
          }),
        ]}
      />,
    );
    expect(html).toContain("The reply said: sending it now.");
  });

  it("renders the timestamp", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[makeRow({ id: "e-8", createdAt: new Date("2026-06-14T10:00:00.000Z") })]}
      />,
    );
    expect(html).toContain("2026-06-14T10:00:00.000Z");
  });

  it("renders multiple rows", () => {
    const html = renderToStaticMarkup(
      <ReconciliationsTable
        rows={[
          makeRow({ id: "e-9", loopSummary: "First loop", eventType: "reconciled",
            metadata: { action: "update", reason: "r1", evidence: "e1" } }),
          makeRow({ id: "e-10", loopSummary: "Second loop", eventType: "reconcile_suggested",
            metadata: { reason: "r2", evidence: "e2" } }),
        ]}
      />,
    );
    expect(html).toContain("First loop");
    expect(html).toContain("Second loop");
    expect(html).toContain("Auto-updated");
    expect(html).toContain("Asked");
  });
});
