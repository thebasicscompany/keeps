/**
 * Quiet hours (Wave C, SR7) — pure, tz-aware. A quiet window may wrap midnight
 * (e.g. 21:00 → 08:00). Used at plan time (defer proactive email) and re-checked at execute.
 * Explicit-command recipes pass empty quiet hours (the user is actively asking).
 */
import type { QuietHours } from "@/automation/types";

/** Local hour [0-23] for `now` in the given IANA tz (defaults to UTC; falls back on error). */
function localHour(now: Date, tz?: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz || "UTC",
    });
    const part = fmt.formatToParts(now).find((p) => p.type === "hour");
    const h = part ? Number(part.value) : now.getUTCHours();
    return Number.isNaN(h) || h === 24 ? 0 : h;
  } catch {
    return now.getUTCHours();
  }
}

export function inQuietHours(input: { quietHours?: QuietHours; now: Date; tz?: string }): boolean {
  const qh = input.quietHours;
  if (!qh || qh.startHour === undefined || qh.endHour === undefined) return false;
  const hour = localHour(input.now, qh.tz ?? input.tz);
  const { startHour, endHour } = qh;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wraps midnight.
  return hour >= startHour || hour < endHour;
}

/** The next Date at which the active window resumes (= `now` if already active). */
export function nextActiveAfter(input: { quietHours?: QuietHours; now: Date; tz?: string }): Date {
  if (!inQuietHours(input)) return input.now;
  let cursor = new Date(input.now.getTime());
  // Hour-step (<=24 iterations) until outside quiet hours — deterministic + tz-correct.
  for (let i = 0; i < 24; i++) {
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    if (!inQuietHours({ quietHours: input.quietHours, now: cursor, tz: input.tz })) return cursor;
  }
  return cursor;
}
