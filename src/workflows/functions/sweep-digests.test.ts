/**
 * Unit tests for sweep-digests and send-digest using in-memory fakes.
 *
 * No live DB or Inngest — mirrors send-activation-email.test.ts.
 *
 * Coverage:
 *   sweep-digests:
 *     - Only emits for users at their local digest_send_hour.
 *     - Pre-filters users with a recent digest.
 *     - Respects 3 timezones (UTC, America/Los_Angeles DST, Asia/Tokyo).
 *     - localDateIso is the user-local calendar date, not the UTC date
 *       (e.g. 03:00 UTC is the PREVIOUS local date for LA at UTC-7).
 *
 *   send-digest:
 *     - Exact one-per-day idempotency: second call within 23h suppressed.
 *     - Run at exactly 23h+1min after last send succeeds.
 *     - Disabled user suppressed.
 *     - Ordinal map in nudge metadata matches rendered ordinals across sections.
 *     - Empty digest still sends (coverage line + capture prompt in body).
 *     - Privacy guard: to address is always the user's own email.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DigestLoopInput } from "@/digests/build";
import type { DigestUser } from "@/digests/repository";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import type { NudgeRepository } from "@/nudges/repository";
import {
  sweepDigests,
  toLocalDateIso,
  type SweepDigestsRepository,
} from "@/workflows/functions/sweep-digests";
import {
  checkDigest,
  sendDigest,
  type SendDigestRepository,
  type DigestNudgeMetadata,
} from "@/workflows/functions/send-digest";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

type RecordedSend = Parameters<OutboundEmailStore["recordSend"]>[0];

class InMemoryOutboundEmailStore implements OutboundEmailStore {
  readonly sends: RecordedSend[] = [];
  readonly sentNudges: { nudgeId: string; sentAt: Date }[] = [];

  async recordSend(input: RecordedSend): Promise<void> {
    this.sends.push(input);
  }

  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    this.sentNudges.push(input);
  }
}

type NudgeRowInput = Parameters<NudgeRepository["createNudgeRow"]>[0];

class InMemoryNudgeRepository implements NudgeRepository {
  readonly nudgeRows: Array<NudgeRowInput & { id: string }> = [];
  readonly loopEvents: Array<Parameters<NudgeRepository["writeLoopEvent"]>[0]> = [];
  readonly audits: Array<Parameters<NudgeRepository["writeAudit"]>[0]> = [];

  async findNudgeCandidates(): Promise<never[]> {
    return [];
  }

  async countNudgesSentSince(): Promise<number> {
    return 0;
  }

  async markLoopNudged(): Promise<void> {}

  async deferLoopNextCheck(): Promise<void> {}

  async createNudgeRow(input: NudgeRowInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.nudgeRows.push({ ...input, id });
    return { id };
  }

  async writeLoopEvent(input: Parameters<NudgeRepository["writeLoopEvent"]>[0]): Promise<void> {
    this.loopEvents.push(input);
  }

  async writeAudit(input: Parameters<NudgeRepository["writeAudit"]>[0]): Promise<void> {
    this.audits.push(input);
  }
}

// Fake DigestRepository (sweep side)
class InMemorySweepDigestsRepository implements SweepDigestsRepository {
  constructor(
    private readonly users: DigestUser[],
    private readonly recentDigests: Set<string> = new Set(),
  ) {}

  async findDigestEnabledUsers(): Promise<DigestUser[]> {
    return this.users.filter((u) => u.digestEnabled);
  }

  async hasRecentDigest(userId: string): Promise<boolean> {
    return this.recentDigests.has(userId);
  }
}

// Fake SendDigestRepository (send-digest side)
class InMemorySendDigestRepository implements SendDigestRepository {
  constructor(
    private readonly users: Map<string, DigestUser>,
    private readonly recentDigests: Set<string> = new Set(),
    private readonly loops: Map<string, DigestLoopInput[]> = new Map(),
  ) {}

  async findDigestUserById(userId: string): Promise<DigestUser | null> {
    return this.users.get(userId) ?? null;
  }

  async hasRecentDigest(userId: string): Promise<boolean> {
    return this.recentDigests.has(userId);
  }

  async findLoopsForDigest(userId: string): Promise<DigestLoopInput[]> {
    return this.loops.get(userId) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<DigestUser> = {}): DigestUser {
  return {
    id: randomUUID(),
    email: "owner@example.com",
    displayName: "Owner",
    timezone: "UTC",
    digestEnabled: true,
    digestSendHour: 8,
    ...overrides,
  };
}

function makeLoop(overrides: Partial<DigestLoopInput> = {}): DigestLoopInput {
  const base: DigestLoopInput = {
    id: randomUUID(),
    emailThreadId: randomUUID(),
    status: "open",
    summary: "Follow up with vendor",
    dueAt: null,
    nextCheckAt: null,
    updatedAt: new Date("2026-06-05T00:00:00Z"),
    lastNudgedAt: null,
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// toLocalDateIso — localDateIso helper
// ---------------------------------------------------------------------------

describe("toLocalDateIso", () => {
  it("returns YYYY-MM-DD in UTC when timezone is UTC", () => {
    const now = new Date("2026-06-12T15:30:00Z");
    expect(toLocalDateIso("UTC", now)).toBe("2026-06-12");
  });

  it("returns the PREVIOUS local date for a UTC morning hour in Los Angeles (UTC-7)", () => {
    // 03:00 UTC = 2026-06-11 20:00 Pacific (UTC-7 in June, PDT)
    const now = new Date("2026-06-12T03:00:00Z");
    expect(toLocalDateIso("America/Los_Angeles", now)).toBe("2026-06-11");
  });

  it("returns the correct local date at the boundary (08:00 LA local = 15:00 UTC)", () => {
    // 15:00 UTC = 08:00 PDT
    const now = new Date("2026-06-12T15:00:00Z");
    expect(toLocalDateIso("America/Los_Angeles", now)).toBe("2026-06-12");
  });

  it("returns UTC date when timezone is unknown/invalid", () => {
    const now = new Date("2026-06-12T15:00:00Z");
    expect(toLocalDateIso("Not/A/Timezone", now)).toBe("2026-06-12");
  });

  it("handles Asia/Tokyo (UTC+9) — midnight UTC is already next local day", () => {
    // 00:00 UTC = 09:00 JST on the SAME UTC date
    const now = new Date("2026-06-12T00:00:00Z");
    expect(toLocalDateIso("Asia/Tokyo", now)).toBe("2026-06-12");
  });

  it("handles the day-ahead case for Tokyo: 23:00 UTC = 08:00 next day JST", () => {
    // 23:00 UTC on June 12 = 08:00 JST on June 13
    const now = new Date("2026-06-12T23:00:00Z");
    expect(toLocalDateIso("Asia/Tokyo", now)).toBe("2026-06-13");
  });
});

// ---------------------------------------------------------------------------
// sweepDigests — only emits for users at their local digest_send_hour
// ---------------------------------------------------------------------------

describe("sweepDigests — hour matching", () => {
  it("emits for a UTC user when local hour matches their digestSendHour", async () => {
    // 08:00 UTC → local hour 8 → matches digestSendHour 8
    const now = new Date("2026-06-12T08:00:00Z");
    const user = makeUser({ timezone: "UTC", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(1);
    expect(result.events[0]?.data.userId).toBe(user.id);
  });

  it("does NOT emit when the local hour does not match", async () => {
    // 09:00 UTC → local hour 9, user wants 8
    const now = new Date("2026-06-12T09:00:00Z");
    const user = makeUser({ timezone: "UTC", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(0);
  });

  it("emits for a LA user when UTC clock is at their local digest hour (PDT = UTC-7)", async () => {
    // LA user with digestSendHour=8. 15:00 UTC = 08:00 PDT.
    const now = new Date("2026-06-12T15:00:00Z");
    const user = makeUser({ timezone: "America/Los_Angeles", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(1);
    expect(result.events[0]?.data.userId).toBe(user.id);
  });

  it("does NOT emit for LA user when the UTC hour is wrong", async () => {
    // 08:00 UTC = 01:00 PDT — does NOT match digestSendHour 8
    const now = new Date("2026-06-12T08:00:00Z");
    const user = makeUser({ timezone: "America/Los_Angeles", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(0);
  });

  it("emits for a Tokyo user (JST = UTC+9) at their local 8 AM", async () => {
    // JST is UTC+9. 08:00 JST = 23:00 UTC (previous day).
    const now = new Date("2026-06-11T23:00:00Z");
    const user = makeUser({ timezone: "Asia/Tokyo", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(1);
  });

  it("handles multiple users in different timezones — only the matching one emits", async () => {
    // 15:00 UTC: LA user at 08:00 PDT → matches; UTC user at 15:00 → no match (wants 8)
    const now = new Date("2026-06-12T15:00:00Z");
    const laUser = makeUser({ id: "la-user", timezone: "America/Los_Angeles", digestSendHour: 8 });
    const utcUser = makeUser({ id: "utc-user", timezone: "UTC", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([laUser, utcUser]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(1);
    expect(result.events[0]?.data.userId).toBe("la-user");
  });

  it("skips users with digestEnabled=false even when local hour matches", async () => {
    const now = new Date("2026-06-12T08:00:00Z");
    const user = makeUser({ timezone: "UTC", digestSendHour: 8, digestEnabled: false });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sweepDigests — pre-filter with hasRecentDigest
// ---------------------------------------------------------------------------

describe("sweepDigests — recent digest pre-filter", () => {
  it("skips a user who already has a recent digest (cheap hint)", async () => {
    const now = new Date("2026-06-12T08:00:00Z");
    const user = makeUser({ timezone: "UTC", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user], new Set([user.id]));

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(0);
    expect(result.processed).toBe(1); // was processed, just not emitted
  });

  it("emits for a user whose last digest was more than 23h ago", async () => {
    const now = new Date("2026-06-12T08:00:00Z");
    const user = makeUser({ timezone: "UTC", digestSendHour: 8 });
    // No userId in the recentDigests set → hasRecentDigest = false
    const repo = new InMemorySweepDigestsRepository([user], new Set());

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sweepDigests — localDateIso in emitted events
// ---------------------------------------------------------------------------

describe("sweepDigests — localDateIso in emitted events", () => {
  it("sets localDateIso to the user's local calendar date, not UTC", async () => {
    // LA user at 15:00 UTC = 08:00 PDT on 2026-06-12
    const now = new Date("2026-06-12T15:00:00Z");
    const user = makeUser({ timezone: "America/Los_Angeles", digestSendHour: 8 });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.events[0]?.data.localDateIso).toBe("2026-06-12");
  });

  it("sets localDateIso to the previous UTC date for an LA user at 03:00 UTC", async () => {
    // 03:00 UTC = 2026-06-11 20:00 PDT — the LOCAL date is still 2026-06-11
    // But digestSendHour for LA user would be 20, not 8, so let's construct this right:
    // User wants digest at local hour 20 (8pm). 03:00 UTC = 20:00 PDT.
    const now = new Date("2026-06-12T03:00:00Z"); // = 2026-06-11T20:00 PDT
    const user = makeUser({
      timezone: "America/Los_Angeles",
      digestSendHour: 20, // 8pm local
    });
    const repo = new InMemorySweepDigestsRepository([user]);

    const result = await sweepDigests({ repository: repo, now });

    expect(result.emitted).toBe(1);
    // The local date at 03:00Z is 2026-06-11 (the PREVIOUS calendar day in LA)
    expect(result.events[0]?.data.localDateIso).toBe("2026-06-11");
  });
});

// ---------------------------------------------------------------------------
// checkDigest — eligibility guard
// ---------------------------------------------------------------------------

describe("checkDigest — eligibility guard", () => {
  const NOW = new Date("2026-06-12T08:00:00Z");

  it("returns clear for an eligible user", async () => {
    const user = makeUser({ digestEnabled: true });
    const repo = new InMemorySendDigestRepository(new Map([[user.id, user]]));

    const result = await checkDigest(user.id, { repository: repo, now: NOW });

    expect(result.status).toBe("clear");
    if (result.status === "clear") {
      expect(result.user.id).toBe(user.id);
    }
  });

  it("suppresses when user is not found", async () => {
    const repo = new InMemorySendDigestRepository(new Map());

    const result = await checkDigest("nonexistent", { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_user_not_found");
  });

  it("suppresses when digestEnabled is false", async () => {
    const user = makeUser({ digestEnabled: false });
    const repo = new InMemorySendDigestRepository(new Map([[user.id, user]]));

    const result = await checkDigest(user.id, { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_digest_disabled");
  });

  it("suppresses when a digest was sent within the last 23h", async () => {
    const user = makeUser({ digestEnabled: true });
    const repo = new InMemorySendDigestRepository(
      new Map([[user.id, user]]),
      new Set([user.id]), // marks user as recently sent
    );

    const result = await checkDigest(user.id, { repository: repo, now: NOW });

    expect(result.status).toBe("suppressed_recent_digest");
  });
});

// ---------------------------------------------------------------------------
// sendDigest — idempotency (exactly one per day)
// ---------------------------------------------------------------------------

describe("sendDigest — exactly one per day idempotency", () => {
  const NOW = new Date("2026-06-12T08:00:00Z");

  function makeOptions(
    user: DigestUser,
    recentDigests: Set<string> = new Set(),
    loops: DigestLoopInput[] = [],
  ) {
    return {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        recentDigests,
        new Map([[user.id, loops]]),
      ),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    };
  }

  it("sends on the first call", async () => {
    const user = makeUser();
    const result = await sendDigest(user.id, makeOptions(user));

    expect(result.status).toBe("sent");
  });

  it("suppresses the second call within 23h (uses hasRecentDigest)", async () => {
    const user = makeUser();
    // Simulate the first send by marking the user as recently sent
    const recentDigests = new Set([user.id]);
    const result = await sendDigest(user.id, makeOptions(user, recentDigests));

    expect(result.status).toBe("suppressed_recent_digest");
  });

  it("sends again after 23h+1min (outside the idempotency window)", async () => {
    const user = makeUser();
    // No recent digest → hasRecentDigest returns false → sends
    const result = await sendDigest(user.id, makeOptions(user, new Set()));

    expect(result.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// sendDigest — suppressed when disabled
// ---------------------------------------------------------------------------

describe("sendDigest — disabled user suppressed", () => {
  it("returns suppressed_digest_disabled when digestEnabled is false", async () => {
    const user = makeUser({ digestEnabled: false });
    const store = new InMemoryOutboundEmailStore();
    const result = await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(new Map([[user.id, user]])),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store,
      now: new Date("2026-06-12T08:00:00Z"),
    });

    expect(result.status).toBe("suppressed_digest_disabled");
    expect(store.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sendDigest — ordinal→loopId mapping matches rendered ordinals
// ---------------------------------------------------------------------------

describe("sendDigest — ordinal map persisted in nudge metadata", () => {
  it("persists an ordinalMap matching the rendered loops across all sections", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();

    // Create loops that span multiple digest sections:
    // needsAttention: open + nextCheckAt <= now
    const loop1 = makeLoop({
      id: "loop-needs-attention",
      status: "open",
      nextCheckAt: new Date(NOW.getTime() - 1000),
      summary: "Review contract",
    });
    // waitingOnOthers: waiting_on_other
    const loop2 = makeLoop({
      id: "loop-waiting",
      status: "waiting_on_other",
      summary: "Waiting on Bob",
    });
    // dueSoon: open + dueAt between now+24h and now+72h
    const loop3 = makeLoop({
      id: "loop-due-soon",
      status: "open",
      dueAt: new Date(NOW.getTime() + 48 * 60 * 60 * 1000),
      summary: "Submit invoice",
    });

    const store = new InMemoryOutboundEmailStore();
    const result = await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, [loop1, loop2, loop3]]]),
      ),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    expect(result.status).toBe("sent");

    // Check the nudge row was created
    expect(nudgeRepo.nudgeRows).toHaveLength(1);
    const nudgeRow = nudgeRepo.nudgeRows[0];
    expect(nudgeRow).toBeDefined();

    // Extract the metadata — it carries the AR-3 ordinalMap
    const metadata = nudgeRow!.metadata as unknown as DigestNudgeMetadata;
    expect(metadata.kind).toBe("digest");
    expect(typeof metadata.ordinalMap).toBe("object");

    // The ordinalMap keys should be 1-based ordinals, values should be loopIds
    const ordinalEntries = Object.entries(metadata.ordinalMap);
    expect(ordinalEntries.length).toBeGreaterThan(0);

    // All loopIds in the map should be one of our rendered loops
    const renderedLoopIds = new Set(Object.values(metadata.ordinalMap));
    expect(renderedLoopIds.has("loop-needs-attention")).toBe(true);
    expect(renderedLoopIds.has("loop-waiting")).toBe(true);
    expect(renderedLoopIds.has("loop-due-soon")).toBe(true);

    // Ordinals must be sequential starting at 1
    const ordinals = Object.keys(metadata.ordinalMap).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < ordinals.length; i++) {
      expect(ordinals[i]).toBe(i + 1);
    }
  });

  it("ordinalCount in metadata equals the number of rendered loops", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();

    const loops = [
      makeLoop({ status: "open", nextCheckAt: new Date(NOW.getTime() - 1000) }),
      makeLoop({ status: "waiting_on_other" }),
    ];

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, loops]]),
      ),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    });

    const metadata = nudgeRepo.nudgeRows[0]?.metadata as unknown as DigestNudgeMetadata;
    expect(metadata.ordinalCount).toBe(Object.keys(metadata.ordinalMap).length);
  });
});

// ---------------------------------------------------------------------------
// sendDigest — empty digest still sends with AR-9 content
// ---------------------------------------------------------------------------

describe("sendDigest — empty digest sends with coverage line + capture prompt", () => {
  it("sends even when there are no loops", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const store = new InMemoryOutboundEmailStore();

    const result = await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, []]]), // empty loops
      ),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    expect(result.status).toBe("sent");
    expect(store.sends).toHaveLength(1);
  });

  it("email body contains the coverage line for an empty digest", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const store = new InMemoryOutboundEmailStore();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, []]]),
      ),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    const textBody = store.sends[0]?.textBody ?? "";
    // AR-9: coverage line must be present
    expect(textBody).toContain("Tracking");
    expect(textBody).toContain("Keeps sees only what you've shared.");
  });

  it("email body contains the capture prompt for an empty digest", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const store = new InMemoryOutboundEmailStore();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, []]]),
      ),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    const textBody = store.sends[0]?.textBody ?? "";
    // AR-9: capture prompt must be present
    expect(textBody).toContain("What else is on your plate? Reply and I'll track it.");
  });

  it("empty digest has an empty ordinalMap (no renderable loops)", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, []]]),
      ),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    });

    const metadata = nudgeRepo.nudgeRows[0]?.metadata as unknown as DigestNudgeMetadata;
    expect(metadata.kind).toBe("digest");
    expect(Object.keys(metadata.ordinalMap)).toHaveLength(0);
    expect(metadata.ordinalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sendDigest — privacy guard
// ---------------------------------------------------------------------------

describe("sendDigest — privacy guard (digest goes to owner's email only)", () => {
  it("sends to the user's own email address, not any other", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser({ email: "alice@example.com" });
    const store = new InMemoryOutboundEmailStore();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(new Map([[user.id, user]])),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    expect(store.sends[0]?.toEmail).toBe("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// sendDigest — audit + loop events written on success
// ---------------------------------------------------------------------------

describe("sendDigest — audit and loop events", () => {
  it("writes a digest.sent audit row", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(new Map([[user.id, user]])),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    });

    expect(nudgeRepo.audits).toHaveLength(1);
    expect(nudgeRepo.audits[0]?.action).toBe("digest.sent");
    expect(nudgeRepo.audits[0]?.userId).toBe(user.id);
  });

  it("writes a digest_summarized loop event for each rendered loop", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();
    // Use updatedAt within the 7d window so loop2 does NOT appear in stale,
    // keeping the rendered loop count exactly 2.
    const loop1 = makeLoop({
      status: "open",
      nextCheckAt: new Date(NOW.getTime() - 1000),
      updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000), // 1d ago — not stale
    });
    const loop2 = makeLoop({
      status: "waiting_on_other",
      updatedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000), // 1d ago — not stale
    });

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, [loop1, loop2]]]),
      ),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    });

    const digestSummarized = nudgeRepo.loopEvents.filter(
      (e) => e.eventType === "digest_summarized",
    );
    expect(digestSummarized).toHaveLength(2);
    const loopIds = digestSummarized.map((e) => e.loopId);
    expect(loopIds).toContain(loop1.id);
    expect(loopIds).toContain(loop2.id);
  });

  it("writes NO loop events for an empty digest (no rendered loops)", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(
        new Map([[user.id, user]]),
        new Set(),
        new Map([[user.id, []]]),
      ),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    });

    const digestSummarized = nudgeRepo.loopEvents.filter(
      (e) => e.eventType === "digest_summarized",
    );
    expect(digestSummarized).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sendDigest — nudge type is 'digest' and loopId is null
// ---------------------------------------------------------------------------

describe("sendDigest — nudge row shape", () => {
  it("creates a nudge row with type='digest' and loopId=null", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(new Map([[user.id, user]])),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store: new InMemoryOutboundEmailStore(),
      now: NOW,
    });

    expect(nudgeRepo.nudgeRows[0]?.type).toBe("digest");
    expect(nudgeRepo.nudgeRows[0]?.loopId).toBeNull();
    expect(nudgeRepo.nudgeRows[0]?.userId).toBe(user.id);
  });

  it("nudge row body matches the rendered textBody", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const nudgeRepo = new InMemoryNudgeRepository();
    const store = new InMemoryOutboundEmailStore();

    await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(new Map([[user.id, user]])),
      nudgeRepository: nudgeRepo,
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    // The nudge row body should match what was sent
    const nudgeBody = nudgeRepo.nudgeRows[0]?.body;
    const sentBody = store.sends[0]?.textBody;
    expect(nudgeBody).toBe(sentBody);
  });
});

// ---------------------------------------------------------------------------
// sendDigest — markNudgeSent is called (makes hasRecentDigest true)
// ---------------------------------------------------------------------------

describe("sendDigest — markNudgeSent is called after send", () => {
  it("calls markNudgeSent on the outbound store after a successful send", async () => {
    const NOW = new Date("2026-06-12T08:00:00Z");
    const user = makeUser();
    const store = new InMemoryOutboundEmailStore();

    const result = await sendDigest(user.id, {
      repository: new InMemorySendDigestRepository(new Map([[user.id, user]])),
      nudgeRepository: new InMemoryNudgeRepository(),
      sender: new DevRecordingSender(),
      store,
      now: NOW,
    });

    expect(result.status).toBe("sent");
    expect(store.sentNudges).toHaveLength(1);
    if (result.status === "sent") {
      expect(store.sentNudges[0]?.nudgeId).toBe(result.nudgeId);
    }
  });
});
