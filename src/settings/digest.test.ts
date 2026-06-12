/**
 * src/settings/digest.test.ts
 *
 * Unit tests for the pure validateDigestPrefs function.
 * No server actions, no DB, no HTTP — just logic.
 */

import { describe, expect, it } from "vitest";
import { validateDigestPrefs, formatSendHour } from "@/settings/digest";

// ---------------------------------------------------------------------------
// validateDigestPrefs — valid inputs
// ---------------------------------------------------------------------------

describe("validateDigestPrefs — valid inputs", () => {
  it("accepts a valid hour, timezone, and enabled=true", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 8,
      timezone: "America/New_York",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.digestEnabled).toBe(true);
      expect(result.value.digestSendHour).toBe(8);
      expect(result.value.timezone).toBe("America/New_York");
    }
  });

  it("accepts hour=0 (midnight) and enabled=false", () => {
    const result = validateDigestPrefs({
      digestEnabled: false,
      digestSendHour: 0,
      timezone: "UTC",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.digestEnabled).toBe(false);
      expect(result.value.digestSendHour).toBe(0);
    }
  });

  it("accepts hour=23 (the maximum)", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 23,
      timezone: "UTC",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.digestSendHour).toBe(23);
    }
  });

  it("accepts digestEnabled as the string 'on' (HTML checkbox default)", () => {
    const result = validateDigestPrefs({
      digestEnabled: "on",
      digestSendHour: 8,
      timezone: "UTC",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.digestEnabled).toBe(true);
    }
  });

  it("treats a missing digestEnabled (not 'on' and not true) as false", () => {
    const result = validateDigestPrefs({
      digestEnabled: undefined,
      digestSendHour: 8,
      timezone: "UTC",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.digestEnabled).toBe(false);
    }
  });

  it("accepts numeric strings for digestSendHour (form data is always strings)", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: "14",
      timezone: "UTC",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.digestSendHour).toBe(14);
    }
  });

  it("trims whitespace from the timezone string", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 8,
      timezone: "  UTC  ",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.timezone).toBe("UTC");
    }
  });

  it("accepts all 24 valid hours 0-23 without error", () => {
    for (let h = 0; h <= 23; h++) {
      const result = validateDigestPrefs({
        digestEnabled: true,
        digestSendHour: h,
        timezone: "UTC",
      });
      expect(result.valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateDigestPrefs — invalid digestSendHour
// ---------------------------------------------------------------------------

describe("validateDigestPrefs — invalid digestSendHour", () => {
  it("rejects hour=24", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 24,
      timezone: "UTC",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      const hourError = result.errors.find((e) => e.field === "digestSendHour");
      expect(hourError).toBeDefined();
    }
  });

  it("rejects hour=-1", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: -1,
      timezone: "UTC",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects a fractional hour (8.5)", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 8.5,
      timezone: "UTC",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects a non-numeric string for hour", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: "morning",
      timezone: "UTC",
    });

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateDigestPrefs — invalid timezone
// ---------------------------------------------------------------------------

describe("validateDigestPrefs — invalid timezone", () => {
  it("rejects an unknown timezone string", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 8,
      timezone: "Fake/Timezone",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      const tzError = result.errors.find((e) => e.field === "timezone");
      expect(tzError).toBeDefined();
    }
  });

  it("rejects an empty string timezone", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 8,
      timezone: "",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects a numeric timezone", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 8,
      timezone: 5,
    });

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateDigestPrefs — multiple errors
// ---------------------------------------------------------------------------

describe("validateDigestPrefs — multiple simultaneous errors", () => {
  it("reports both digestSendHour and timezone errors when both are invalid", () => {
    const result = validateDigestPrefs({
      digestEnabled: true,
      digestSendHour: 99,
      timezone: "Not/A/Timezone",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBe(2);
      expect(result.errors.some((e) => e.field === "digestSendHour")).toBe(true);
      expect(result.errors.some((e) => e.field === "timezone")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatSendHour
// ---------------------------------------------------------------------------

describe("formatSendHour", () => {
  it("formats hour 0 as midnight", () => {
    const label = formatSendHour(0);
    // Expect AM indicator and 12 for midnight in 12-hour format.
    expect(label).toMatch(/12:00\s*AM/i);
  });

  it("formats hour 12 as noon", () => {
    const label = formatSendHour(12);
    expect(label).toMatch(/12:00\s*PM/i);
  });

  it("formats hour 8 as 8 AM", () => {
    const label = formatSendHour(8);
    expect(label).toMatch(/8:00\s*AM/i);
  });

  it("formats hour 17 as 5 PM", () => {
    const label = formatSendHour(17);
    expect(label).toMatch(/5:00\s*PM/i);
  });

  it("returns a string for all 24 hours", () => {
    for (let h = 0; h <= 23; h++) {
      expect(typeof formatSendHour(h)).toBe("string");
    }
  });
});
