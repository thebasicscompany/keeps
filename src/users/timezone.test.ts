import { describe, expect, it } from "vitest";
import { localHourFor, nextLocalHourInstant, startOfLocalDay, usersDueAtHour } from "@/users/timezone";

// ---------------------------------------------------------------------------
// localHourFor
// ---------------------------------------------------------------------------

describe("localHourFor", () => {
  it("returns the correct UTC hour for UTC timezone", () => {
    const now = new Date("2026-06-12T15:00:00.000Z");
    expect(localHourFor("UTC", now)).toBe(15);
  });

  it("returns the correct local hour for America/Los_Angeles (UTC-7 in summer)", () => {
    // 2026-06-12 is in PDT (UTC-7)
    // 15:00 UTC → 08:00 PDT
    const now = new Date("2026-06-12T15:00:00.000Z");
    expect(localHourFor("America/Los_Angeles", now)).toBe(8);
  });

  it("returns the correct local hour for Europe/London in summer (BST = UTC+1)", () => {
    // 2026-06-12 is in BST (UTC+1)
    // 15:00 UTC → 16:00 BST
    const now = new Date("2026-06-12T15:00:00.000Z");
    expect(localHourFor("Europe/London", now)).toBe(16);
  });

  it("returns the correct local hour for Europe/London in winter (GMT = UTC+0)", () => {
    // 2026-12-12 is in GMT (UTC+0)
    const now = new Date("2026-12-12T15:00:00.000Z");
    expect(localHourFor("Europe/London", now)).toBe(15);
  });

  it("returns UTC hour for an unknown/invalid timezone string (fallback)", () => {
    const now = new Date("2026-06-12T15:00:00.000Z");
    expect(localHourFor("Invalid/Timezone_XYZ", now)).toBe(15);
  });

  it("handles midnight UTC correctly", () => {
    const midnight = new Date("2026-06-12T00:00:00.000Z");
    expect(localHourFor("UTC", midnight)).toBe(0);
  });

  // DST spring-forward for America/Los_Angeles: 2026-03-08 02:00 → 03:00
  it("returns correct hour just before LA spring-forward (still PST = UTC-8)", () => {
    // 2026-03-08T09:59:00Z → 01:59 PST (UTC-8)
    const before = new Date("2026-03-08T09:59:00.000Z");
    expect(localHourFor("America/Los_Angeles", before)).toBe(1);
  });

  it("returns correct hour just after LA spring-forward (now PDT = UTC-7)", () => {
    // 2026-03-08T10:00:00Z → 03:00 PDT (UTC-7) — clocks jumped from 02:00 to 03:00
    const after = new Date("2026-03-08T10:00:00.000Z");
    expect(localHourFor("America/Los_Angeles", after)).toBe(3);
  });

  // DST fall-back for America/Los_Angeles: 2026-11-01 02:00 → 01:00
  it("returns correct hour just before LA fall-back (still PDT = UTC-7)", () => {
    // 2026-11-01T08:59:00Z → 01:59 PDT (UTC-7)
    const before = new Date("2026-11-01T08:59:00.000Z");
    expect(localHourFor("America/Los_Angeles", before)).toBe(1);
  });

  it("returns correct hour just after LA fall-back (now PST = UTC-8)", () => {
    // 2026-11-01T09:00:00Z → 01:00 PST (UTC-8) — clocks fell from 02:00 back to 01:00
    const after = new Date("2026-11-01T09:00:00.000Z");
    expect(localHourFor("America/Los_Angeles", after)).toBe(1);
  });

  // DST spring-forward for Europe/London: 2026-03-29 01:00 UTC → 02:00 BST
  it("returns correct hour just before London spring-forward (still GMT = UTC+0)", () => {
    // 2026-03-29T00:59:00Z → 00:59 GMT
    const before = new Date("2026-03-29T00:59:00.000Z");
    expect(localHourFor("Europe/London", before)).toBe(0);
  });

  it("returns correct hour just after London spring-forward (now BST = UTC+1)", () => {
    // 2026-03-29T01:00:00Z → 02:00 BST — clocks jumped from 01:00 to 02:00
    const after = new Date("2026-03-29T01:00:00.000Z");
    expect(localHourFor("Europe/London", after)).toBe(2);
  });

  // DST fall-back for Europe/London: 2026-10-25 02:00 BST → 01:00 GMT
  it("returns correct hour just before London fall-back (still BST = UTC+1)", () => {
    // 2026-10-25T00:59:00Z → 01:59 BST
    const before = new Date("2026-10-25T00:59:00.000Z");
    expect(localHourFor("Europe/London", before)).toBe(1);
  });

  it("returns correct hour just after London fall-back (now GMT = UTC+0)", () => {
    // 2026-10-25T01:00:00Z → 01:00 GMT
    const after = new Date("2026-10-25T01:00:00.000Z");
    expect(localHourFor("Europe/London", after)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// startOfLocalDay
// ---------------------------------------------------------------------------

describe("startOfLocalDay", () => {
  it("returns UTC midnight for UTC timezone", () => {
    const now = new Date("2026-06-12T15:30:00.000Z");
    const result = startOfLocalDay("UTC", now);
    expect(result.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });

  it("returns correct UTC instant for America/Los_Angeles in summer (PDT = UTC-7)", () => {
    // 2026-06-12 local day starts at 07:00 UTC (midnight local PDT)
    const now = new Date("2026-06-12T15:30:00.000Z"); // local: 08:30 PDT
    const result = startOfLocalDay("America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-06-12T07:00:00.000Z");
  });

  it("returns correct UTC instant for America/Los_Angeles in winter (PST = UTC-8)", () => {
    // 2026-01-12 local day starts at 08:00 UTC (midnight local PST)
    const now = new Date("2026-01-12T15:30:00.000Z"); // local: 07:30 PST
    const result = startOfLocalDay("America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-01-12T08:00:00.000Z");
  });

  it("returns correct UTC instant for Europe/London in summer (BST = UTC+1)", () => {
    // 2026-06-12 local day starts at 23:00 UTC previous day (midnight local BST)
    const now = new Date("2026-06-12T15:30:00.000Z"); // local: 16:30 BST
    const result = startOfLocalDay("Europe/London", now);
    expect(result.toISOString()).toBe("2026-06-11T23:00:00.000Z");
  });

  it("returns correct UTC instant for Europe/London in winter (GMT = UTC+0)", () => {
    // 2026-01-12 local day starts at 00:00 UTC
    const now = new Date("2026-01-12T15:30:00.000Z");
    const result = startOfLocalDay("Europe/London", now);
    expect(result.toISOString()).toBe("2026-01-12T00:00:00.000Z");
  });

  it("falls back to UTC for an unknown timezone", () => {
    const now = new Date("2026-06-12T15:30:00.000Z");
    const result = startOfLocalDay("Unknown/Tz_XYZ", now);
    expect(result.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });

  // DST boundary: America/Los_Angeles spring-forward 2026-03-08
  it("returns the correct start-of-day during LA spring-forward night", () => {
    // 2026-03-08 in LA starts at 08:00 UTC (PST = UTC-8)
    // After 02:00 local (= 10:00 UTC) clocks jump to 03:00 (PDT = UTC-7)
    const now = new Date("2026-03-08T20:00:00.000Z"); // 13:00 PDT
    const result = startOfLocalDay("America/Los_Angeles", now);
    // Local midnight for 2026-03-08 is 08:00 UTC (PST, before the jump)
    expect(result.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  // DST boundary: America/Los_Angeles fall-back 2026-11-01
  it("returns the correct start-of-day during LA fall-back night", () => {
    // 2026-11-01 in LA: clocks fall back at 02:00 PDT → 01:00 PST
    // Local midnight is still at 07:00 UTC (PDT = UTC-7 at midnight)
    const now = new Date("2026-11-01T20:00:00.000Z"); // afternoon PST
    const result = startOfLocalDay("America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  // DST boundary: Europe/London spring-forward 2026-03-29
  it("returns the correct start-of-day during London spring-forward night", () => {
    // 2026-03-29 in London: clocks go from GMT to BST at 01:00 UTC
    // Local midnight for 2026-03-29 is 00:00 UTC (GMT = UTC+0)
    const now = new Date("2026-03-29T15:00:00.000Z"); // 16:00 BST
    const result = startOfLocalDay("Europe/London", now);
    expect(result.toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });

  // DST boundary: Europe/London fall-back 2026-10-25
  it("returns the correct start-of-day during London fall-back night", () => {
    // 2026-10-25 in London: clocks fall from BST to GMT at 02:00 local
    // Local midnight for 2026-10-25 is 23:00 UTC on 2026-10-24 (BST = UTC+1)
    const now = new Date("2026-10-25T12:00:00.000Z"); // noon GMT
    const result = startOfLocalDay("Europe/London", now);
    expect(result.toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// usersDueAtHour
// ---------------------------------------------------------------------------

describe("usersDueAtHour", () => {
  const makeUser = (
    overrides: Partial<{
      timezone: string;
      digestEnabled: boolean;
      digestSendHour: number;
      id: string;
    }>,
  ) => ({
    id: "user-1",
    timezone: "UTC",
    digestEnabled: true,
    digestSendHour: 8,
    ...overrides,
  });

  it("returns users whose local hour matches digestSendHour", () => {
    // 08:00 UTC = 08:00 for UTC users with digestSendHour = 8
    const now = new Date("2026-06-12T08:00:00.000Z");
    const user = makeUser({ digestSendHour: 8 });
    const result = usersDueAtHour([user], now);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(user);
  });

  it("excludes users whose digestEnabled is false", () => {
    const now = new Date("2026-06-12T08:00:00.000Z");
    const user = makeUser({ digestEnabled: false, digestSendHour: 8 });
    const result = usersDueAtHour([user], now);
    expect(result).toHaveLength(0);
  });

  it("excludes users whose local hour does not match digestSendHour", () => {
    const now = new Date("2026-06-12T08:00:00.000Z");
    const user = makeUser({ digestSendHour: 9 });
    const result = usersDueAtHour([user], now);
    expect(result).toHaveLength(0);
  });

  it("selects by local timezone — LA user at 15:00 UTC (08:00 PDT) gets digest", () => {
    // 15:00 UTC = 08:00 PDT (UTC-7 in summer)
    const now = new Date("2026-06-12T15:00:00.000Z");
    const laUser = makeUser({
      id: "la-user",
      timezone: "America/Los_Angeles",
      digestSendHour: 8,
    });
    const utcUser = makeUser({
      id: "utc-user",
      timezone: "UTC",
      digestSendHour: 8,
    });
    const result = usersDueAtHour([laUser, utcUser], now);
    // utcUser: 15:00 UTC ≠ 8 → excluded; laUser: 08:00 PDT = 8 → included
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("la-user");
  });

  it("handles empty list", () => {
    const now = new Date("2026-06-12T08:00:00.000Z");
    expect(usersDueAtHour([], now)).toHaveLength(0);
  });

  it("falls back to UTC for a user with an invalid timezone", () => {
    const now = new Date("2026-06-12T08:00:00.000Z"); // 08:00 UTC
    const user = makeUser({ timezone: "Invalid/Tz_XYZ", digestSendHour: 8 });
    const result = usersDueAtHour([user], now);
    // UTC fallback → local hour = 8 = digestSendHour → included
    expect(result).toHaveLength(1);
  });

  it("handles multiple users with different timezones and send hours correctly", () => {
    // now = 08:00 UTC = 01:00 PDT (UTC-7) = 09:00 BST (UTC+1)
    const now = new Date("2026-06-12T08:00:00.000Z");
    const users = [
      makeUser({ id: "utc8", timezone: "UTC", digestSendHour: 8 }), // 08:00 UTC = 8 ✓
      makeUser({ id: "la1", timezone: "America/Los_Angeles", digestSendHour: 1 }), // 01:00 PDT = 1 ✓
      makeUser({ id: "lon9", timezone: "Europe/London", digestSendHour: 9 }), // 09:00 BST = 9 ✓
      makeUser({ id: "la8", timezone: "America/Los_Angeles", digestSendHour: 8 }), // 01:00 PDT ≠ 8 ✗
    ];
    const result = usersDueAtHour(users, now);
    const ids = result.map((u) => u.id);
    expect(ids).toContain("utc8");
    expect(ids).toContain("la1");
    expect(ids).toContain("lon9");
    expect(ids).not.toContain("la8");
  });
});

// ---------------------------------------------------------------------------
// nextLocalHourInstant
// ---------------------------------------------------------------------------

describe("nextLocalHourInstant", () => {
  it("returns tomorrow 9 AM UTC when tz is UTC", () => {
    // now = 2026-06-12T12:00:00Z (local: 2026-06-12 12:00 UTC)
    // next local day = 2026-06-13; 9 AM local = 2026-06-13T09:00:00Z
    const now = new Date("2026-06-12T12:00:00.000Z");
    const result = nextLocalHourInstant("UTC", now, 9);
    expect(result.toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("returns tomorrow 9 AM LA time in PDT (UTC-7)", () => {
    // now = 2026-06-12T15:00:00Z = 2026-06-12 08:00 PDT
    // next local day (LA) = 2026-06-13; midnight local = 2026-06-13T07:00:00Z
    // 9 AM local = 2026-06-13T07:00:00Z + 9h = 2026-06-13T16:00:00Z
    const now = new Date("2026-06-12T15:00:00.000Z");
    const result = nextLocalHourInstant("America/Los_Angeles", now, 9);
    expect(result.toISOString()).toBe("2026-06-13T16:00:00.000Z");
  });

  it("returns tomorrow 9 AM LA time in PST (UTC-8) during winter", () => {
    // now = 2026-01-12T15:00:00Z = 2026-01-12 07:00 PST
    // next local day = 2026-01-13; midnight local = 2026-01-13T08:00:00Z
    // 9 AM local = 2026-01-13T08:00:00Z + 9h = 2026-01-13T17:00:00Z
    const now = new Date("2026-01-12T15:00:00.000Z");
    const result = nextLocalHourInstant("America/Los_Angeles", now, 9);
    expect(result.toISOString()).toBe("2026-01-13T17:00:00.000Z");
  });

  it("returns tomorrow 9 AM London time in BST (UTC+1)", () => {
    // now = 2026-06-12T15:00:00Z = 2026-06-12 16:00 BST
    // next local day = 2026-06-13; midnight local = 2026-06-12T23:00:00Z
    // 9 AM local = 2026-06-12T23:00:00Z + 9h = 2026-06-13T08:00:00Z
    const now = new Date("2026-06-12T15:00:00.000Z");
    const result = nextLocalHourInstant("Europe/London", now, 9);
    expect(result.toISOString()).toBe("2026-06-13T08:00:00.000Z");
  });

  it("always returns FOLLOWING day even when called at exactly the target hour", () => {
    // now = 2026-06-12T09:00:00Z = exactly 9 AM UTC
    // must still return 2026-06-13T09:00:00Z (following day)
    const now = new Date("2026-06-12T09:00:00.000Z");
    const result = nextLocalHourInstant("UTC", now, 9);
    expect(result.toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("works for hour=0 (midnight) on the following day", () => {
    const now = new Date("2026-06-12T12:00:00.000Z");
    const result = nextLocalHourInstant("UTC", now, 0);
    expect(result.toISOString()).toBe("2026-06-13T00:00:00.000Z");
  });

  it("falls back to UTC for an unknown timezone", () => {
    const now = new Date("2026-06-12T12:00:00.000Z");
    const result = nextLocalHourInstant("Invalid/TZ_XYZ", now, 9);
    // UTC fallback: next day 9 AM UTC
    expect(result.toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("handles month rollover correctly (last day of June)", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const result = nextLocalHourInstant("UTC", now, 9);
    expect(result.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });

  it("handles year rollover correctly (last day of December)", () => {
    const now = new Date("2026-12-31T12:00:00.000Z");
    const result = nextLocalHourInstant("UTC", now, 9);
    expect(result.toISOString()).toBe("2027-01-01T09:00:00.000Z");
  });

  // DST: LA spring-forward 2026-03-08 02:00 PST → 03:00 PDT
  // Spring-forward at 02:00 PST = 10:00 UTC on 2026-03-08.
  // 9 AM is AFTER the spring-forward (clocks already jumped), so 9 AM is in PDT (UTC-7).
  // 9 AM PDT = 09:00 local - (-7h offset) = 16:00 UTC.
  it("is DST-correct when the next day is a spring-forward day (LA 2026-03-08)", () => {
    // now = 2026-03-07T20:00:00Z (12:00 PST on March 7)
    const now = new Date("2026-03-07T20:00:00.000Z");
    // next local day = 2026-03-08; 9 AM on that day is PDT (UTC-7) = 16:00 UTC
    const result = nextLocalHourInstant("America/Los_Angeles", now, 9);
    expect(result.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  // DST: LA fall-back 2026-11-01 02:00 PDT → 01:00 PST
  // Fall-back at 02:00 PDT = 09:00 UTC. 9 AM is AFTER the fall-back, in PST (UTC-8).
  // 9 AM PST = 17:00 UTC. (The "first" 9 AM, since after fall-back the clock
  // hasn't reached 9 AM yet when it falls back at 02:00 → 01:00.)
  it("is DST-correct when the next day is a fall-back day (LA 2026-11-01)", () => {
    // now = 2026-10-31T20:00:00Z (afternoon PDT on Oct 31)
    const now = new Date("2026-10-31T20:00:00.000Z");
    // next local day = 2026-11-01; 9 AM is in PST (UTC-8) = 17:00 UTC
    const result = nextLocalHourInstant("America/Los_Angeles", now, 9);
    expect(result.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
});
