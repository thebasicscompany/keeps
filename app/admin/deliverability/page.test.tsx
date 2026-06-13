/**
 * Render smoke for the DeliverabilityTable presentational component.
 *
 * Node-compatible render via renderToStaticMarkup (no jsdom). next/navigation is
 * mocked so the client ReactivateButton's useRouter does not throw during SSR.
 * No DB, no Clerk.
 */

import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SuppressedUser } from "@/admin/deliverability-admin";
import { DeliverabilityTable } from "./page";

function makeUser(overrides: Partial<SuppressedUser> & { id: string }): SuppressedUser {
  return {
    id: overrides.id,
    email: overrides.email ?? "user@example.com",
    outboundEmailState: overrides.outboundEmailState ?? "bounced",
    updatedAt: overrides.updatedAt ?? new Date("2026-06-10T08:00:00.000Z"),
  };
}

describe("DeliverabilityTable render smoke", () => {
  it("renders empty state when no suppressed users", () => {
    const html = renderToStaticMarkup(<DeliverabilityTable rows={[]} />);
    expect(html).toContain("No suppressed users.");
  });

  it("renders email, state, and updatedAt for a bounced user", () => {
    const html = renderToStaticMarkup(
      <DeliverabilityTable
        rows={[
          makeUser({ id: "u-1", email: "alice@example.com", outboundEmailState: "bounced" }),
        ]}
      />,
    );
    expect(html).toContain("alice@example.com");
    expect(html).toContain("bounced");
    expect(html).toContain("2026-06-10T08:00:00.000Z");
    expect(html).toContain("Reactivate");
  });

  it("renders complained and suppressed states", () => {
    const html = renderToStaticMarkup(
      <DeliverabilityTable
        rows={[
          makeUser({ id: "u-2", outboundEmailState: "complained" }),
          makeUser({ id: "u-3", outboundEmailState: "suppressed" }),
        ]}
      />,
    );
    expect(html).toContain("complained");
    expect(html).toContain("suppressed");
  });

  it("renders multiple rows correctly", () => {
    const html = renderToStaticMarkup(
      <DeliverabilityTable
        rows={[
          makeUser({ id: "u-4", email: "a@example.com", outboundEmailState: "bounced" }),
          makeUser({ id: "u-5", email: "b@example.com", outboundEmailState: "complained" }),
        ]}
      />,
    );
    expect(html).toContain("a@example.com");
    expect(html).toContain("b@example.com");
  });
});
