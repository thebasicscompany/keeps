/**
 * Digest sweep cron — fires hourly at minute 0.
 *
 * Each run:
 *   1. Mints `now` inside the first step (Inngest determinism rule — all
 *      time-based values must be minted inside step.run and read from its
 *      memoised return value).
 *   2. Fetches all digest-enabled users via the DigestRepository port.
 *   3. Filters to those whose local hour equals their `digestSendHour` using
 *      the pure `usersDueAtHour` helper (no SQL timezone math).
 *   4. Pre-filters with a cheap `hasRecentDigest` check (this is a hint;
 *      `send-digest` rechecks authoritatively inside its own step).
 *   5. Emits one `digest.daily_due` event per eligible user in a single
 *      batched `step.sendEvent`.
 *
 * AR-5: NO `step.sleepUntil` anywhere in this file.
 * Gotcha 1 (determinism): `now` is minted once in step 1 and threaded through
 *   every time-dependent call.
 */

import { inngest } from "@/workflows/client";
import type { DigestRepository, DigestUser } from "@/digests/repository";
import { DrizzleDigestRepository } from "@/digests/repository";
import { usersDueAtHour } from "@/users/timezone";
import type { EventMap } from "@/workflows/events";

// ---------------------------------------------------------------------------
// Ports — so tests can inject fakes (mirroring send-activation-email.ts)
// ---------------------------------------------------------------------------

export interface SweepDigestsRepository {
  findDigestEnabledUsers(): Promise<DigestUser[]>;
  hasRecentDigest(userId: string, now: Date): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Pure core — injectable for tests
// ---------------------------------------------------------------------------

export interface SweepDigestsResult {
  processed: number;
  emitted: number;
  events: Array<{ name: "digest.daily_due"; data: EventMap["digest.daily_due"] }>;
}

/**
 * Pure sweep logic. Returns the events to emit (caller batches them).
 * `repository` is injected so tests use in-memory fakes.
 * `now` must come from a memoised Inngest step.
 */
export async function sweepDigests(options: {
  repository: SweepDigestsRepository;
  now: Date;
}): Promise<SweepDigestsResult> {
  const { repository, now } = options;

  // All digest-enabled users.
  const allUsers = await repository.findDigestEnabledUsers();

  // Filter to those whose local hour matches their digest_send_hour right now.
  const dueUsers = usersDueAtHour(allUsers, now);

  const events: Array<{ name: "digest.daily_due"; data: EventMap["digest.daily_due"] }> = [];

  for (const user of dueUsers) {
    // Cheap pre-filter: skip if they recently got a digest. `send-digest`
    // rechecks this authoritatively before actually sending.
    const alreadySent = await repository.hasRecentDigest(user.id, now);
    if (alreadySent) {
      continue;
    }

    // Derive the user-local calendar date (YYYY-MM-DD) from `now`.
    const localDateIso = toLocalDateIso(user.timezone, now);

    events.push({
      name: "digest.daily_due",
      data: { userId: user.id, localDateIso },
    });
  }

  return {
    processed: dueUsers.length,
    emitted: events.length,
    events,
  };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding of ports to the pure core
// ---------------------------------------------------------------------------

export const sweepDigestsFunction = inngest.createFunction(
  {
    id: "sweep-digests",
    triggers: { cron: "0 * * * *" },
    retries: 2,
  },
  async ({ step }) => {
    // Step 1: mint `now` + run pure sweep logic.
    // `now` is minted inside this step so it is memoised across re-executions
    // (Inngest determinism: anything time-based MUST come from inside step.run).
    const sweepResult = await step.run("sweep-digest-users", async () => {
      const now = new Date();
      return sweepDigests({
        repository: new DrizzleDigestRepository(),
        now,
      });
    });

    // Operability: log processed/emitted counts.
    console.log(
      `[sweep-digests] processed=${sweepResult.processed} emitted=${sweepResult.emitted}`,
    );

    // Step 2: emit all events in a single batched call.
    if (sweepResult.events.length > 0) {
      await step.sendEvent("emit-digest-due-events", sweepResult.events);
    }

    return {
      ok: true,
      processed: sweepResult.processed,
      emitted: sweepResult.emitted,
    };
  },
);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the user-local calendar date as "YYYY-MM-DD" for the given UTC
 * instant. Uses `Intl.DateTimeFormat` with the IANA timezone string.
 *
 * Example: `now = 2026-06-12T03:00:00Z`, `tz = "America/Los_Angeles"` (UTC-7)
 * → the local time is 2026-06-11T20:00:00 Pacific → returns "2026-06-11".
 */
export function toLocalDateIso(timezone: string, now: Date): string {
  const tz = safeTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA locale produces "YYYY-MM-DD" — stable and trivially parseable.
  return formatter.format(now);
}

function safeTimezone(tz: string): string {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}
