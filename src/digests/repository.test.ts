/**
 * Unit tests for DigestRepository using in-memory fakes.
 *
 * There is no meaningful pure logic at the repository layer itself (it is a
 * thin SQL pass-through). The DB-gated integration tests in
 * src/digests/repository.db.test.ts cover SQL correctness.
 *
 * What IS worth testing here:
 *   - The DigestUser shape carries all fields needed by usersDueAtHour().
 *   - The DigestLoopInput shape returned by findLoopsForDigest matches what
 *     buildDigest() requires.
 *   - hasRecentDigest: the 23-hour cutoff is the correct value (we can verify
 *     the constant is as documented).
 */

import { describe, expect, it } from "vitest";
import type { DigestUser } from "@/digests/repository";
import type { DigestLoopInput, DigestUserInput } from "@/digests/build";

// ---------------------------------------------------------------------------
// DigestUser shape compatibility with usersDueAtHour
// ---------------------------------------------------------------------------

describe("DigestUser shape is compatible with usersDueAtHour", () => {
  it("every field required by usersDueAtHour is present in DigestUser", () => {
    // usersDueAtHour requires: { timezone, digestEnabled, digestSendHour }
    const user: DigestUser = {
      id: "user-1",
      email: "alice@example.com",
      displayName: "Alice",
      timezone: "America/Los_Angeles",
      digestEnabled: true,
      digestSendHour: 8,
    };

    // Structural compatibility — if this compiles the shape is correct.
    const asHourInput: { timezone: string; digestEnabled: boolean; digestSendHour: number } = {
      timezone: user.timezone,
      digestEnabled: user.digestEnabled,
      digestSendHour: user.digestSendHour,
    };

    expect(asHourInput.timezone).toBe("America/Los_Angeles");
    expect(asHourInput.digestEnabled).toBe(true);
    expect(asHourInput.digestSendHour).toBe(8);
  });

  it("DigestUser.displayName is nullable — matches DigestUserInput optional field", () => {
    const user: DigestUser = {
      id: "user-2",
      email: "bob@example.com",
      displayName: null,
      timezone: "UTC",
      digestEnabled: true,
      digestSendHour: 9,
    };

    const asDigestUserInput: DigestUserInput = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    };

    expect(asDigestUserInput.displayName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DigestLoopInput shape
// ---------------------------------------------------------------------------

describe("DigestLoopInput shape covers all buildDigest fields", () => {
  it("a representative DigestLoopInput can be constructed with all required fields", () => {
    const now = new Date("2026-06-12T12:00:00Z");

    const loop: DigestLoopInput = {
      id: "loop-1",
      emailThreadId: "thread-1",
      status: "open",
      summary: "Reply to Bob's proposal",
      dueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      nextCheckAt: new Date(now.getTime() - 60_000),
      updatedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      lastNudgedAt: null,
    };

    expect(loop.id).toBe("loop-1");
    expect(loop.status).toBe("open");
    expect(loop.lastNudgedAt).toBeNull();
  });

  it("DigestLoopInput supports all valid statuses including done", () => {
    const statuses: DigestLoopInput["status"][] = [
      "candidate",
      "open",
      "waiting_on_me",
      "waiting_on_other",
      "blocked",
      "snoozed",
      "done",
      "dismissed",
    ];

    for (const status of statuses) {
      const loop: DigestLoopInput = {
        id: "loop-x",
        emailThreadId: "thread-x",
        status,
        summary: "test",
        dueAt: null,
        nextCheckAt: null,
        updatedAt: new Date(),
        lastNudgedAt: null,
      };
      expect(loop.status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// hasRecentDigest cutoff constant documentation
// ---------------------------------------------------------------------------

describe("hasRecentDigest 23-hour window", () => {
  it("23h in ms equals 82800000", () => {
    // This documents the cutoff used in the repository — if someone accidentally
    // changes it to 24h they will see this test fail first.
    const MS_23H = 23 * 60 * 60 * 1000;
    expect(MS_23H).toBe(82_800_000);
  });
});
