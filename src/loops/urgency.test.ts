import { describe, expect, it } from "vitest";
import type { LoopStatus } from "@/agent/schemas";
import { deriveUrgency } from "@/loops/urgency";

const now = new Date("2026-06-12T12:00:00.000Z");

describe("deriveUrgency", () => {
  it("returns overdue when dueAt is in the past", () => {
    const result = deriveUrgency(
      {
        status: "open",
        dueAt: new Date("2026-06-11T12:00:00.000Z"),
        nextCheckAt: new Date("2026-06-10T12:00:00.000Z"),
      },
      now,
    );

    expect(result).toBe("overdue");
  });

  it("returns due_soon when nextCheckAt <= now <= dueAt", () => {
    const result = deriveUrgency(
      {
        status: "open",
        dueAt: new Date("2026-06-13T12:00:00.000Z"),
        nextCheckAt: new Date("2026-06-12T00:00:00.000Z"),
      },
      now,
    );

    expect(result).toBe("due_soon");
  });

  it("treats now exactly equal to nextCheckAt and before dueAt as due_soon", () => {
    const result = deriveUrgency(
      {
        status: "waiting_on_me",
        dueAt: new Date("2026-06-13T12:00:00.000Z"),
        nextCheckAt: now,
      },
      now,
    );

    expect(result).toBe("due_soon");
  });

  it("returns null when the check window has not opened yet", () => {
    const result = deriveUrgency(
      {
        status: "open",
        dueAt: new Date("2026-06-20T12:00:00.000Z"),
        nextCheckAt: new Date("2026-06-15T12:00:00.000Z"),
      },
      now,
    );

    expect(result).toBeNull();
  });

  it("returns null when there is no timing information", () => {
    const result = deriveUrgency(
      { status: "open", dueAt: null, nextCheckAt: null },
      now,
    );

    expect(result).toBeNull();
  });

  it("returns null for terminal statuses even when overdue by date", () => {
    expect(
      deriveUrgency(
        {
          status: "done",
          dueAt: new Date("2026-06-01T12:00:00.000Z"),
          nextCheckAt: null,
        },
        now,
      ),
    ).toBeNull();

    expect(
      deriveUrgency(
        {
          status: "dismissed",
          dueAt: new Date("2026-06-01T12:00:00.000Z"),
          nextCheckAt: null,
        },
        now,
      ),
    ).toBeNull();
  });

  it("rejects removed lifecycle statuses at the type level", () => {
    // @ts-expect-error "due_soon" is no longer a valid stored LoopStatus (AR-6).
    const removed: LoopStatus = "due_soon";
    // @ts-expect-error "overdue" is no longer a valid stored LoopStatus (AR-6).
    const alsoRemoved: LoopStatus = "overdue";

    // Reference the values so they are not flagged as unused; the type guard
    // above is the actual assertion under test.
    expect([removed, alsoRemoved]).toHaveLength(2);
  });
});
