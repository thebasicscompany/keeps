import { describe, it, expect } from "vitest";
import {
  sweepSuppressedTimeouts,
  type SuppressedTimeoutRepository,
} from "./sweep-suppressed-timeout";

const DAY = 24 * 60 * 60 * 1000;

describe("sweepSuppressedTimeouts", () => {
  it("promotes every suppressed loop past the timeout (never dismisses), now-7d cutoff", async () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const promoted: string[] = [];

    const repository: SuppressedTimeoutRepository = {
      async listSuppressedAwaitingConfirm({ olderThan }) {
        expect(olderThan.getTime()).toBe(now.getTime() - 7 * DAY);
        return [
          { loopId: "l1", userId: "u1", suggestedAt: new Date("2026-06-01T00:00:00Z"), candidateLoopId: "c1" },
          { loopId: "l2", userId: "u1", suggestedAt: new Date("2026-06-02T00:00:00Z"), candidateLoopId: null },
        ];
      },
      async promoteSuppressedLoop({ loopId, commandText }) {
        expect(commandText).toContain("7d");
        promoted.push(loopId);
      },
    };

    const result = await sweepSuppressedTimeouts({ repository, now });

    expect(result.promoted).toBe(2);
    expect(result.loopIds).toEqual(["l1", "l2"]);
    expect(promoted).toEqual(["l1", "l2"]);
  });

  it("honors a custom timeoutDays and no-ops on an empty candidate set", async () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const repository: SuppressedTimeoutRepository = {
      async listSuppressedAwaitingConfirm({ olderThan }) {
        expect(olderThan.getTime()).toBe(now.getTime() - 3 * DAY);
        return [];
      },
      async promoteSuppressedLoop() {
        throw new Error("should not promote when no candidates");
      },
    };

    const result = await sweepSuppressedTimeouts({ repository, now, timeoutDays: 3 });

    expect(result.promoted).toBe(0);
    expect(result.loopIds).toEqual([]);
  });
});
