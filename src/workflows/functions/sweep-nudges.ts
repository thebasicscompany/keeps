/**
 * sweep-nudges — Inngest cron function (every 10 minutes).
 *
 * Architecture mirrors send-activation-email.ts:
 *   - Pure core `sweepNudges` over the NudgeRepository port (fully testable with fakes).
 *   - Inngest wrapper: mints `now` inside step 1, runs the core, then batches
 *     `step.sendEvent` of loop.nudge_due outside any step (per AR-5, no step.sleepUntil).
 *
 * AR-5 compliance: NO step.sleepUntil anywhere. The cron sweep + per-loop event
 * consumption by send-nudge is the scheduling mechanism.
 */

import { MAX_NUDGES_PER_USER_PER_DAY } from "@/nudges/policy";
import type { NudgeCandidate, NudgeRepository } from "@/nudges/repository";
import { DrizzleNudgeRepository } from "@/nudges/repository";
import { enforceDailyCap, isEligibleForNudge } from "@/nudges/selectors";
import { nextLocalHourInstant, startOfLocalDay } from "@/users/timezone";
import type { EventMap } from "@/workflows/events";
import { inngest } from "@/workflows/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape expected by Inngest's step.sendEvent — { name, data } envelope. */
export type NudgeDueEvent = { name: "loop.nudge_due"; data: EventMap["loop.nudge_due"] };

export type SweepNudgesResult = {
  /** loop.nudge_due events ready for batched sendEvent. */
  events: NudgeDueEvent[];
  /** Loop ids whose next_check_at was deferred (over daily cap). */
  deferredLoopIds: string[];
  /** Total candidates loaded from DB before eligibility re-filter. */
  candidateCount: number;
};

// ---------------------------------------------------------------------------
// Pure core — fully testable with in-memory fakes
// ---------------------------------------------------------------------------

/**
 * Core sweep logic. Takes the repository and current timestamp; returns the
 * events to emit and the loop ids that were deferred.
 *
 * Steps:
 *  1. findNudgeCandidates(now) — cheap SQL pre-filter.
 *  2. Re-filter with isEligibleForNudge (the pure selector is authoritative).
 *  3. Group by userId.
 *  4. Per user: count nudges sent today; apply enforceDailyCap.
 *  5. toDefer → deferLoopNextCheck to tomorrow local 9 AM.
 *  6. toNudge → produce loop.nudge_due payloads.
 */
export async function sweepNudges(options: {
  repository: NudgeRepository;
  now: Date;
}): Promise<SweepNudgesResult> {
  const { repository, now } = options;

  // 1. Cheap SQL pre-filter
  const candidates = await repository.findNudgeCandidates(now);
  const candidateCount = candidates.length;

  // 2. Re-filter with the pure eligibility selector
  const eligible = candidates.filter((c) => isEligibleForNudge(c, { now }));

  // 3. Group by userId
  const byUser = new Map<string, NudgeCandidate[]>();
  for (const candidate of eligible) {
    const existing = byUser.get(candidate.userId) ?? [];
    existing.push(candidate);
    byUser.set(candidate.userId, existing);
  }

  const events: NudgeDueEvent[] = [];
  const deferredLoopIds: string[] = [];

  // 4. Per-user cap enforcement
  for (const [userId, userCandidates] of byUser) {
    // All candidates in this group share the same userTimezone (joined from users).
    const userTimezone = userCandidates[0]?.userTimezone ?? "UTC";

    const startOfDay = startOfLocalDay(userTimezone, now);
    const sentTodayCount = await repository.countNudgesSentSince(userId, startOfDay);

    const { toNudge, toDefer } = enforceDailyCap(userCandidates, {
      sentTodayCount,
      cap: MAX_NUDGES_PER_USER_PER_DAY,
    });

    // 5. Defer over-cap loops: push next_check_at to tomorrow local 9 AM
    for (const loop of toDefer) {
      const deferUntil = nextLocalHourInstant(userTimezone, now, 9);
      await repository.deferLoopNextCheck({
        loopId: loop.id,
        nextCheckAt: deferUntil,
        now,
      });
      deferredLoopIds.push(loop.id);
    }

    // 6. Build loop.nudge_due events for eligible loops
    for (const loop of toNudge) {
      const reason: EventMap["loop.nudge_due"]["reason"] =
        loop.status === "candidate" ? "candidate_re_ask" : "next_check_due";

      events.push({
        name: "loop.nudge_due",
        data: {
          userId,
          loopId: loop.id,
          reason,
          scheduledFor: now.toISOString(),
        },
      });
    }
  }

  return { events, deferredLoopIds, candidateCount };
}

// ---------------------------------------------------------------------------
// Inngest wrapper
// ---------------------------------------------------------------------------

export const sweepNudgesFunction = inngest.createFunction(
  {
    id: "sweep-nudges",
    triggers: { cron: "*/10 * * * *" },
    retries: 2,
  },
  async ({ step }) => {
    // Step 1: mint now inside step.run so it is memoized across re-executions.
    // DB writes (deferral) are fine in the bookkeeping cron step.
    const result = await step.run("sweep", async () => {
      const now = new Date();
      return sweepNudges({
        repository: new DrizzleNudgeRepository(),
        now,
      });
    });

    // Emit all loop.nudge_due events in a single batched call — outside any step.
    if (result.events.length > 0) {
      await step.sendEvent("emit-nudge-due", result.events);
    }

    // Operability E4: log the count of rows processed.
    console.log(
      `[sweep-nudges] candidates=${result.candidateCount} toNudge=${result.events.length} deferred=${result.deferredLoopIds.length}`,
    );

    return {
      candidateCount: result.candidateCount,
      nudgeEventCount: result.events.length,
      deferredCount: result.deferredLoopIds.length,
    };
  },
);
