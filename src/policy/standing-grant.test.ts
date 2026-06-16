import { describe, it, expect } from "vitest";
import { authorize, toPolicyActionKind, type AuthorizationContext } from "@/policy/actions";
import type { StandingGrantContext } from "@/automation/types";

const NOW = new Date("2026-06-15T12:00:00Z");

function grant(over: Partial<StandingGrantContext> = {}): StandingGrantContext {
  return {
    recipeKey: "stale_loop_followup",
    status: "active",
    allowedActionKinds: [
      "send_private_email_to_user",
      "create_private_report",
      "send_slack_message",
      "create_calendar_event",
    ],
    blockedActionKinds: [],
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    caps: {},
    capUsage: {},
    ...over,
  };
}

function authz(action: string, g: StandingGrantContext) {
  const ctx: AuthorizationContext = { userId: "u1", standingGrant: g };
  return authorize(action, ctx, { now: NOW });
}

describe("authorize() — standing-grant truth table (Phase V2)", () => {
  it("private kinds → allowed", () => {
    expect(authz("send_private_email_to_user", grant()).result).toBe("allowed");
    expect(authz("create_private_report", grant()).result).toBe("allowed");
  });

  it("Slack send → needs_approval (SR8); slack_dm alias is identical", () => {
    expect(authz("send_slack_message", grant()).result).toBe("needs_approval");
    expect(authz("slack_dm", grant())).toEqual(authz("send_slack_message", grant()));
  });

  it("self-only calendar (no attendees) allowed; with attendees → needs_approval", () => {
    expect(authz("create_calendar_event", grant({ hasAttendees: false })).result).toBe("allowed");
    expect(authz("create_calendar_event", grant({ hasAttendees: true })).result).toBe("needs_approval");
    expect(authz("calendar_event", grant({ hasAttendees: true })).result).toBe("needs_approval");
  });

  it("third-party email / share / reveal → denied (never grantable, even if listed)", () => {
    const g = grant({ allowedActionKinds: ["send_email", "share_loop", "reveal_source"] });
    expect(authz("send_email", g).result).toBe("denied");
    expect(authz("share_loop", g).result).toBe("denied");
    expect(authz("reveal_source", g).result).toBe("denied");
  });

  it("unknown recipe → denied (SR1)", () => {
    expect(authz("create_private_report", grant({ recipeKey: "ghost_recipe" })).result).toBe("denied");
  });

  it("non-active grant → denied (paused/revoked/expired/pending)", () => {
    for (const status of ["paused", "revoked", "expired", "pending"] as const) {
      expect(authz("create_private_report", grant({ status })).result).toBe("denied");
    }
  });

  it("grant past expiry (expiresAt <= now) → denied", () => {
    expect(
      authz("create_private_report", grant({ expiresAt: new Date("2020-01-01T00:00:00Z") })).result,
    ).toBe("denied");
  });

  it("blocked beats allowed (SR2)", () => {
    expect(authz("create_private_report", grant({ blockedActionKinds: ["create_private_report"] })).result).toBe(
      "denied",
    );
  });

  it("action not in allowed envelope → denied", () => {
    expect(
      authz("create_private_report", grant({ allowedActionKinds: ["send_private_email_to_user"] })).result,
    ).toBe("denied");
  });

  it("cap exhausted → denied; under cap → allowed", () => {
    const exhausted = grant({
      caps: { create_private_report: { limit: 2, window: "day" } },
      capUsage: { create_private_report: 2 },
    });
    expect(authz("create_private_report", exhausted).result).toBe("denied");
    const underCap = grant({
      caps: { create_private_report: { limit: 2, window: "day" } },
      capUsage: { create_private_report: 1 },
    });
    expect(authz("create_private_report", underCap).result).toBe("allowed");
  });

  it("toPolicyActionKind maps connector aliases", () => {
    expect(toPolicyActionKind("slack_dm")).toBe("send_slack_message");
    expect(toPolicyActionKind("calendar_event")).toBe("create_calendar_event");
    expect(toPolicyActionKind("create_private_report")).toBe("create_private_report");
  });

  it("legacy AR-7 path unchanged when no standingGrant", () => {
    expect(authorize("send_slack_message", { userId: "u1" }).result).toBe("needs_approval");
    expect(authorize("create_private_report", { userId: "u1" }).result).toBe("allowed");
  });
});

describe("authorize() — zone-aware SR8 (Wave 2; targetZone supplied)", () => {
  it("outward kind to a reachable zone → needs_approval (in_scope / external_counterparty)", () => {
    expect(authz("send_slack_message", grant({ targetZone: "in_scope" })).result).toBe("needs_approval");
    expect(authz("send_slack_message", grant({ targetZone: "external_counterparty" })).result).toBe(
      "needs_approval",
    );
  });

  it("outward kind across a boundary → DENIED (the leak surface) — stricter than the kind-only default", () => {
    expect(authz("send_slack_message", grant({ targetZone: "cross_scope_internal" })).result).toBe("denied");
    expect(authz("send_slack_message", grant({ targetZone: "external_unscoped" })).result).toBe("denied");
    expect(
      authz("create_calendar_event", grant({ targetZone: "cross_scope_internal", hasAttendees: true })).result,
    ).toBe("denied");
  });

  it("private kinds stay allowed in every zone", () => {
    expect(authz("create_private_report", grant({ targetZone: "external_unscoped" })).result).toBe("allowed");
    expect(authz("send_private_email_to_user", grant({ targetZone: "cross_scope_internal" })).result).toBe(
      "allowed",
    );
  });

  it("zone path still respects the allowed envelope + caps", () => {
    expect(
      authz(
        "send_slack_message",
        grant({ targetZone: "in_scope", allowedActionKinds: ["send_private_email_to_user"] }),
      ).result,
    ).toBe("denied");
    const capped = grant({
      targetZone: "in_scope",
      caps: { create_private_report: { limit: 1, window: "day" } },
      capUsage: { create_private_report: 1 },
    });
    expect(authz("create_private_report", capped).result).toBe("denied");
  });
});
