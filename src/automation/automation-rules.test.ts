import { describe, it, expect } from "vitest";
import { RECIPE_REGISTRY, RECIPE_KEYS, getRecipe } from "@/automation/recipe-registry";
import { scopeMatches } from "@/automation/scope";
import { capStatus } from "@/automation/caps";
import { inQuietHours, nextActiveAfter } from "@/automation/quiet-hours";

describe("recipe registry shape", () => {
  it("every recipe: non-empty allowed, allowed ∩ blocked = ∅, approval ⊆ allowed, valid expiry", () => {
    for (const key of RECIPE_KEYS) {
      const r = RECIPE_REGISTRY[key];
      expect(r.key).toBe(key);
      expect(r.allowedActionKinds.length).toBeGreaterThan(0);
      const blocked = new Set<string>(r.blockedActionKinds);
      for (const a of r.allowedActionKinds) expect(blocked.has(a)).toBe(false);
      for (const a of r.approvalRequiredActionKinds) expect(r.allowedActionKinds).toContain(a);
      expect([90, 30]).toContain(r.defaultExpiryDays);
    }
  });

  it("private recipes block every external/connector kind", () => {
    for (const key of ["pre_meeting_brief", "post_meeting_prompt"] as const) {
      const blocked = new Set<string>(getRecipe(key)!.blockedActionKinds);
      for (const k of [
        "send_email",
        "send_slack_message",
        "create_calendar_event",
        "share_loop",
        "reveal_source",
      ]) {
        expect(blocked.has(k)).toBe(true);
      }
    }
  });
});

describe("scopeMatches (SR2, fail-closed)", () => {
  it("unknown recipe → no match", () => {
    expect(scopeMatches({ recipeKey: "ghost", grantScope: {} }).matches).toBe(false);
  });
  it("self-only calendar rejects attendees + over-bounds, accepts compliant target", () => {
    expect(
      scopeMatches({
        recipeKey: "self_only_calendar_reminder",
        grantScope: {},
        target: { attendees: ["a@b.com"] },
      }).matches,
    ).toBe(false);
    expect(
      scopeMatches({
        recipeKey: "self_only_calendar_reminder",
        grantScope: { maxDurationMinutes: 60 },
        target: { attendees: [], durationMinutes: 120 },
      }).matches,
    ).toBe(false);
    expect(
      scopeMatches({
        recipeKey: "self_only_calendar_reminder",
        grantScope: {},
        target: { attendees: [], durationMinutes: 30, lookaheadDays: 10 },
      }).matches,
    ).toBe(true);
  });
  it("unparseable scope → no match", () => {
    expect(scopeMatches({ recipeKey: "stale_loop_followup", grantScope: { staleDays: -5 } }).matches).toBe(false);
  });
});

describe("capStatus (SR7)", () => {
  it("no cap → ok; under → ok; at/over → not ok", () => {
    expect(capStatus({ caps: {}, actionKind: "create_private_report", recentCount: 100 }).ok).toBe(true);
    expect(
      capStatus({ caps: { create_private_report: { limit: 3, window: "day" } }, actionKind: "create_private_report", recentCount: 2 }).ok,
    ).toBe(true);
    expect(
      capStatus({ caps: { create_private_report: { limit: 3, window: "day" } }, actionKind: "create_private_report", recentCount: 3 }).ok,
    ).toBe(false);
  });
});

describe("inQuietHours / nextActiveAfter (SR7)", () => {
  const qh = { startHour: 21, endHour: 8, tz: "UTC" };
  it("wrap-midnight window 21->8 (UTC)", () => {
    expect(inQuietHours({ quietHours: qh, now: new Date("2026-06-15T23:00:00Z") })).toBe(true);
    expect(inQuietHours({ quietHours: qh, now: new Date("2026-06-15T03:00:00Z") })).toBe(true);
    expect(inQuietHours({ quietHours: qh, now: new Date("2026-06-15T12:00:00Z") })).toBe(false);
  });
  it("empty quiet hours → never quiet (explicit recipes are exempt)", () => {
    expect(inQuietHours({ quietHours: {}, now: new Date("2026-06-15T03:00:00Z") })).toBe(false);
  });
  it("nextActiveAfter: now when active; later & outside-window when quiet", () => {
    const active = new Date("2026-06-15T12:00:00Z");
    expect(nextActiveAfter({ quietHours: qh, now: active })).toEqual(active);
    const quiet = new Date("2026-06-15T23:00:00Z");
    const next = nextActiveAfter({ quietHours: qh, now: quiet });
    expect(next.getTime()).toBeGreaterThan(quiet.getTime());
    expect(inQuietHours({ quietHours: qh, now: next })).toBe(false);
  });
});
