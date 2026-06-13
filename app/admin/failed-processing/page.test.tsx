/**
 * Render smoke for the dead-letter admin table (FailedProcessingTable).
 *
 * Node-compatible render via renderToStaticMarkup (no jsdom). next/navigation is
 * mocked so the client RowActions component's useRouter does not throw during SSR.
 * Exercises both the populated and empty-state branches with injected rows — no DB.
 */

import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FailedProcessing } from "@/db/schema";
import { FailedProcessingTable } from "./page";

function makeRow(overrides: Partial<FailedProcessing> & { id: string }): FailedProcessing {
  return {
    id: overrides.id,
    inboundEmailId: overrides.inboundEmailId ?? "inbound-1",
    eventName: overrides.eventName ?? "email.received",
    eventPayload: overrides.eventPayload ?? { inboundEmailId: "inbound-1", subject: "Hi" },
    errorMessage: overrides.errorMessage ?? "route-email exploded",
    errorStack: overrides.errorStack ?? "Error: route-email exploded\n  at x",
    failedAt: overrides.failedAt ?? new Date("2026-06-13T12:00:00.000Z"),
    replayedAt: overrides.replayedAt ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
    notes: overrides.notes ?? null,
  };
}

describe("FailedProcessingTable render smoke", () => {
  it("renders rows with event name, error, and Replay/Resolve actions", () => {
    const html = renderToStaticMarkup(
      <FailedProcessingTable rows={[makeRow({ id: "fp-1" })]} />,
    );
    expect(html).toContain("email.received");
    expect(html).toContain("route-email exploded");
    expect(html).toContain("Replay");
    expect(html).toContain("Resolve");
    expect(html).toContain("inbound-1");
  });

  it("renders an empty state when there are no open rows", () => {
    const html = renderToStaticMarkup(<FailedProcessingTable rows={[]} />);
    expect(html).toContain("No open failures.");
  });

  it("tolerates a null inboundEmailId row", () => {
    const html = renderToStaticMarkup(
      <FailedProcessingTable rows={[makeRow({ id: "fp-2", inboundEmailId: null })]} />,
    );
    expect(html).toContain("email.received");
  });
});
