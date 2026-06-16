/**
 * sweep-calendar-recipes (Wave D) — the autonomous triggers for the two calendar recipes.
 *
 * Mirrors sweep-stale-loops: a PURE core over a repository port + a thin Inngest wrapper. Every
 * ~10 min it finds users who (a) have an ACTIVE, unexpired grant for the recipe and (b) have a
 * connected calendar, reads their calendar (metadata only), and emits one `automation.triggered`
 * per qualifying user — pre-filtering on a real candidate so we don't spam skipped runs. The
 * planner re-loads fresh context and applies the caps/quiet-hours gates; the unique idempotency
 * key (per user + event + local day) makes a recipe fire at most once a day for a given meeting.
 */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, standingGrants } from "@/db/schema";
import { inngest } from "@/workflows/client";
import { loadPreMeetingCandidate, loadPostMeetingCandidate } from "@/automation/calendar-context";
import type { EventMap } from "@/workflows/events";
import type { RecipeKey } from "@/automation/types";

type CalendarRecipeKey = Extract<RecipeKey, "pre_meeting_brief" | "post_meeting_prompt">;

export type CalendarGrantUser = { userId: string; standingGrantId: string };

export interface CalendarSweepRepository {
  /** Users with an active, unexpired grant for `recipeKey` AND a connected calendar. */
  findEligibleUsers(recipeKey: CalendarRecipeKey, now: Date): Promise<CalendarGrantUser[]>;
}

export type AutomationTriggeredEvent = {
  name: "automation.triggered";
  data: EventMap["automation.triggered"];
};

/** PURE-ish core: eligible users → one automation.triggered per user with a real candidate. */
export async function sweepCalendarRecipe(options: {
  recipeKey: CalendarRecipeKey;
  repository: CalendarSweepRepository;
  now: Date;
}): Promise<{ events: AutomationTriggeredEvent[]; eligibleCount: number }> {
  const { recipeKey, repository, now } = options;
  const users = await repository.findEligibleUsers(recipeKey, now);
  const dayBucket = now.toISOString().slice(0, 10);
  const events: AutomationTriggeredEvent[] = [];

  for (const u of users) {
    const candidate =
      recipeKey === "pre_meeting_brief"
        ? await loadPreMeetingCandidate({ userId: u.userId, now })
        : await loadPostMeetingCandidate({ userId: u.userId, now });
    if (!candidate.candidate) continue;
    const eventId = candidate.candidate.calendarEventId;
    events.push({
      name: "automation.triggered",
      data: {
        userId: u.userId,
        recipeKey,
        triggerKind: "calendar_event",
        triggerRef: eventId,
        idempotencyKey: `automation:${recipeKey}:${eventId}:${dayBucket}`,
        standingGrantId: u.standingGrantId,
        context: {},
      },
    });
  }
  return { events, eligibleCount: users.length };
}

export class DrizzleCalendarSweepRepository implements CalendarSweepRepository {
  async findEligibleUsers(recipeKey: CalendarRecipeKey, now: Date): Promise<CalendarGrantUser[]> {
    const rows = await getDb()
      .select({ userId: standingGrants.userId, grantId: standingGrants.id })
      .from(standingGrants)
      .innerJoin(
        connectorAccounts,
        and(
          eq(connectorAccounts.userId, standingGrants.userId),
          eq(connectorAccounts.provider, "google_calendar"),
          eq(connectorAccounts.status, "active"),
        ),
      )
      .where(
        and(
          eq(standingGrants.recipeKey, recipeKey),
          eq(standingGrants.status, "active"),
          or(isNull(standingGrants.expiresAt), gt(standingGrants.expiresAt, now)),
        ),
      );
    return rows.map((r) => ({ userId: r.userId, standingGrantId: r.grantId }));
  }
}

function makeCalendarSweepFunction(id: string, recipeKey: CalendarRecipeKey) {
  return inngest.createFunction(
    { id, triggers: { cron: "*/10 * * * *" }, retries: 2 },
    async ({ step }) => {
      const result = await step.run("sweep", async () => {
        const now = new Date();
        return sweepCalendarRecipe({ recipeKey, repository: new DrizzleCalendarSweepRepository(), now });
      });
      if (result.events.length > 0) {
        await step.sendEvent("emit-calendar-triggers", result.events);
      }
      console.log(`[${id}] eligible=${result.eligibleCount} triggered=${result.events.length}`);
      return { eligibleCount: result.eligibleCount, triggered: result.events.length };
    },
  );
}

export const sweepPreMeetingFunction = makeCalendarSweepFunction("sweep-pre-meeting", "pre_meeting_brief");
export const sweepPostMeetingFunction = makeCalendarSweepFunction("sweep-post-meeting", "post_meeting_prompt");
