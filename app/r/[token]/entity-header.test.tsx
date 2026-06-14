/**
 * Render test for the EntityHeader component (Phase 7 C2).
 *
 * Verifies that the entity name, recency, and open/closed counts render correctly
 * via renderToStaticMarkup (no DOM, no browser required).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityHeader } from "@/reports/components/EntityHeader";

// Mock next/navigation so the component (and any transitive import) doesn't blow up
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/r/test-token",
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = new Date("2026-06-14T12:00:00.000Z");

describe("EntityHeader — render", () => {
  it("renders the entity display name", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{ entity: "Acme Corp", entityId: "eid-123", entityKind: "company" }}
        totalOpen={3}
        totalClosed={1}
        now={NOW}
      />,
    );
    expect(html).toContain("Acme Corp");
  });

  it("shows open and closed counts", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{ entity: "Dana Client", entityId: "eid-456", entityKind: "person" }}
        totalOpen={2}
        totalClosed={4}
        now={NOW}
      />,
    );
    expect(html).toContain("2 open");
    expect(html).toContain("4 closed");
  });

  it("renders singular 'open' / 'closed' labels for count of 1", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{ entity: "Solo Entity", entityId: "eid-789" }}
        totalOpen={1}
        totalClosed={1}
        now={NOW}
      />,
    );
    expect(html).toContain("1 open");
    expect(html).toContain("1 closed");
  });

  it("renders firstSeenAt date when present in scope", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{
          entity: "Acme Corp",
          entityId: "eid-123",
          firstSeenAt: "2026-01-15T08:00:00.000Z",
        }}
        totalOpen={1}
        totalClosed={0}
        now={NOW}
      />,
    );
    expect(html).toContain("First seen");
    expect(html).toContain("Jan 15, 2026");
  });

  it("renders lastSeenAt relative time when present in scope", () => {
    // 3 days before NOW
    const lastSeenIso = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{
          entity: "Acme Corp",
          entityId: "eid-123",
          lastSeenAt: lastSeenIso,
        }}
        totalOpen={0}
        totalClosed={2}
        now={NOW}
      />,
    );
    expect(html).toContain("Last active");
    expect(html).toContain("3 days ago");
  });

  it("shows 'Company' badge for company entities", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{ entity: "Acme Corp", entityId: "eid-123", entityKind: "company" }}
        totalOpen={0}
        totalClosed={0}
        now={NOW}
      />,
    );
    expect(html).toContain("Company");
  });

  it("does NOT show 'Company' badge for person entities", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{ entity: "Dana Client", entityId: "eid-456", entityKind: "person" }}
        totalOpen={1}
        totalClosed={0}
        now={NOW}
      />,
    );
    expect(html).not.toContain("Company");
  });

  it("omits recency block when neither firstSeenAt nor lastSeenAt is present", () => {
    const html = renderToStaticMarkup(
      <EntityHeader
        scope={{ entity: "Unknown Entity", entityId: "eid-000" }}
        totalOpen={0}
        totalClosed={0}
        now={NOW}
      />,
    );
    expect(html).not.toContain("First seen");
    expect(html).not.toContain("Last active");
  });
});
