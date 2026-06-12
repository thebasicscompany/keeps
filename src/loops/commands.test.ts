import { describe, expect, it } from "vitest";
import { parseLoopReplyCommand } from "@/loops/commands";

/**
 * C4 additive parser forms. These cover ONLY the new "done N" / "snooze N ..." forms and
 * timezone-aware reminder resolution; the legacy forms (confirm/correct/dismiss/mark N
 * done/remind) keep their existing coverage in service.test.ts and must parse identically.
 */
describe("parseLoopReplyCommand — C4 additive forms", () => {
  it("parses 'done N' as mark_done with the ordinal (alias of 'mark N done')", () => {
    expect(parseLoopReplyCommand("done 2")).toMatchObject({ type: "mark_done", loopOrdinal: 2 });
    expect(parseLoopReplyCommand("DONE 1")).toMatchObject({ type: "mark_done", loopOrdinal: 1 });
  });

  it("keeps 'mark N done' parsing identically", () => {
    expect(parseLoopReplyCommand("mark 3 done")).toMatchObject({ type: "mark_done", loopOrdinal: 3 });
  });

  it("parses 'snooze N until <text>' as snooze with ordinal N and the time text", () => {
    const result = parseLoopReplyCommand("snooze 1 until Monday");
    expect(result).toMatchObject({ type: "snooze", loopOrdinal: 1, remindAtText: "Monday" });
  });

  it("parses 'snooze N <text>' (no 'until') as snooze with ordinal N", () => {
    const result = parseLoopReplyCommand("snooze 2 tomorrow");
    expect(result).toMatchObject({ type: "snooze", loopOrdinal: 2, remindAtText: "tomorrow" });
  });

  it("leaves unrelated text as unknown", () => {
    expect(parseLoopReplyCommand("here is a brain dump of my week").type).toBe("unknown");
  });

  it("without a timezone, snooze-until resolves to UTC 9 AM (legacy behavior preserved)", () => {
    // 2026-06-12 is a Friday (UTC). Next Monday at 09:00 UTC is 2026-06-15.
    const now = new Date("2026-06-12T09:00:00.000Z");
    const result = parseLoopReplyCommand("snooze 1 until Monday", { now });
    expect(result.type).toBe("snooze");
    if (result.type === "snooze") {
      expect(result.remindAt?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
    }
  });

  it("resolves 'snooze 1 until Monday' to the user-local Monday 9 AM for America/Los_Angeles", () => {
    // now: Fri 2026-06-12 16:00Z = 09:00 PDT (UTC-7). Next Monday local 9 AM = 2026-06-15
    // 09:00 PDT = 2026-06-15T16:00:00Z.
    const now = new Date("2026-06-12T16:00:00.000Z");
    const result = parseLoopReplyCommand("snooze 1 until Monday", {
      now,
      timezone: "America/Los_Angeles",
    });
    expect(result.type).toBe("snooze");
    if (result.type === "snooze") {
      expect(result.remindAt?.toISOString()).toBe("2026-06-15T16:00:00.000Z");
    }
  });

  it("resolves 'remind me tomorrow' to user-local 9 AM tomorrow for America/Los_Angeles", () => {
    // now: 2026-06-12T16:00:00Z = 09:00 PDT. Tomorrow local 9 AM = 2026-06-13T16:00:00Z.
    const now = new Date("2026-06-12T16:00:00.000Z");
    const result = parseLoopReplyCommand("remind me tomorrow", {
      now,
      timezone: "America/Los_Angeles",
    });
    expect(result.type).toBe("snooze");
    if (result.type === "snooze") {
      expect(result.remindAt?.toISOString()).toBe("2026-06-13T16:00:00.000Z");
    }
  });

  it("falls back to UTC behavior for an unknown timezone", () => {
    const now = new Date("2026-06-12T09:00:00.000Z");
    const result = parseLoopReplyCommand("snooze 1 until Monday", { now, timezone: "Not/AZone" });
    expect(result.type).toBe("snooze");
    if (result.type === "snooze") {
      expect(result.remindAt?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
    }
  });
});
