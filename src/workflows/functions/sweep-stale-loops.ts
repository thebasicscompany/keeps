/**
 * sweep-stale-loops (Wave 3) — hourly cron that fires the stale-loop-followup recipe.
 *
 * Mirrors sweep-nudges: a PURE core over a repository port (testable with a fake) + a thin Inngest
 * wrapper that mints `now` in step.run and batches step.sendEvent. Finds active loops with no
 * recent activity whose owner has an ACTIVE stale_loop_followup grant, and emits one
 * `automation.triggered` per loop with a deterministic per-day idempotency key (so a loop triggers
 * at most once per day; the planner + unique idempotency_key dedupe the rest).
 *
 * AR-5: no step.sleepUntil. Per-action caps are enforced downstream by the planner (cap gate),
 * so the sweep can over-emit safely — duplicates dedupe and over-cap triggers skip at plan time.
 */
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loops, standingGrants } from "@/db/schema";
import { inngest } from "@/workflows/client";
import type { EventMap } from "@/workflows/events";

const STALE_THRESHOLD_DAYS = 7;
const ACTIVE_LOOP_STATUSES = ["open", "waiting_on_me", "waiting_on_other"] as const;

export type StaleLoopCandidate = {
  loopId: string;
  userId: string;
  summary: string;
  standingGrantId: string;
  staleDays: number;
};

export interface StaleLoopRepository {
  findStaleLoopCandidates(now: Date): Promise<StaleLoopCandidate[]>;
}

export type AutomationTriggeredEvent = {
  name: "automation.triggered";
  data: EventMap["automation.triggered"];
};

/** PURE: candidates → one automation.triggered per loop, with a deterministic per-day idempotency key. */
export async function sweepStaleLoops(options: {
  repository: StaleLoopRepository;
  now: Date;
}): Promise<{ events: AutomationTriggeredEvent[]; candidateCount: number }> {
  const candidates = await options.repository.findStaleLoopCandidates(options.now);
  const dayBucket = options.now.toISOString().slice(0, 10);
  const events: AutomationTriggeredEvent[] = candidates.map((c) => ({
    name: "automation.triggered",
    data: {
      userId: c.userId,
      recipeKey: "stale_loop_followup",
      triggerKind: "loop_stale",
      triggerRef: c.loopId,
      idempotencyKey: `automation:stale_loop_followup:${c.loopId}:${dayBucket}`,
      standingGrantId: c.standingGrantId,
      context: { staleDays: c.staleDays },
    },
  }));
  return { events, candidateCount: candidates.length };
}

export class DrizzleStaleLoopRepository implements StaleLoopRepository {
  async findStaleLoopCandidates(now: Date): Promise<StaleLoopCandidate[]> {
    const threshold = new Date(now.getTime() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const rows = await getDb()
      .select({
        loopId: loops.id,
        userId: loops.userId,
        summary: loops.summary,
        grantId: standingGrants.id,
        scope: standingGrants.scope,
      })
      .from(loops)
      .innerJoin(
        standingGrants,
        and(
          eq(standingGrants.userId, loops.userId),
          eq(standingGrants.recipeKey, "stale_loop_followup"),
          eq(standingGrants.status, "active"),
        ),
      )
      .where(
        and(
          inArray(loops.status, [...ACTIVE_LOOP_STATUSES]),
          lt(loops.updatedAt, threshold),
          or(isNull(standingGrants.expiresAt), gt(standingGrants.expiresAt, now)),
        ),
      );

    return rows.map((r) => {
      const scope = (r.scope as { staleDays?: number } | null) ?? {};
      return {
        loopId: r.loopId,
        userId: r.userId,
        summary: r.summary,
        standingGrantId: r.grantId,
        staleDays: typeof scope.staleDays === "number" ? scope.staleDays : STALE_THRESHOLD_DAYS,
      };
    });
  }
}

export const sweepStaleLoopsFunction = inngest.createFunction(
  { id: "sweep-stale-loops", triggers: { cron: "0 * * * *" }, retries: 2 },
  async ({ step }) => {
    const result = await step.run("sweep", async () => {
      const now = new Date();
      return sweepStaleLoops({ repository: new DrizzleStaleLoopRepository(), now });
    });
    if (result.events.length > 0) {
      await step.sendEvent("emit-stale-loop-triggers", result.events);
    }
    console.log(
      `[sweep-stale-loops] candidates=${result.candidateCount} triggered=${result.events.length}`,
    );
    return { candidateCount: result.candidateCount, triggered: result.events.length };
  },
);
