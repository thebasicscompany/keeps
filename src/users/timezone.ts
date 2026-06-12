/**
 * Timezone helpers for per-user scheduling.
 *
 * All functions use `Intl.DateTimeFormat` with an IANA timezone string — no
 * extra dependencies. An unknown or invalid tz string falls back to 'UTC' and
 * never throws.
 *
 * All time-dependent functions take an injected `now: Date` argument so they
 * are fully unit-testable without mocking global `Date`.
 */

/**
 * Returns the local hour-of-day (0–23) for a given UTC instant in the
 * supplied IANA timezone. Falls back to 'UTC' if the tz string is unknown.
 */
export function localHourFor(userTimezone: string, now: Date): number {
  const tz = safeTimezone(userTimezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  if (!hourPart) {
    // Fallback: derive from UTC
    return now.getUTCHours();
  }

  // Intl "numeric" with hour12:false returns "0"–"23"; "24" can appear at
  // midnight in some locales — normalise it.
  const value = Number.parseInt(hourPart.value, 10);
  return value === 24 ? 0 : value;
}

/**
 * Returns the UTC `Date` instant at which the user's local calendar day that
 * contains `now` began (i.e. local midnight).
 *
 * For example, if `now` is 2026-06-12T03:00:00Z and `userTimezone` is
 * 'America/Los_Angeles' (UTC-7), the local day started at 2026-06-11T07:00:00Z
 * (which is 2026-06-11 00:00:00 local).
 */
export function startOfLocalDay(userTimezone: string, now: Date): Date {
  const tz = safeTimezone(userTimezone);

  // Break `now` down into local year/month/day components using Intl.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // en-CA gives "YYYY-MM-DD" which is trivially parseable.
  const localDateString = formatter.format(now); // e.g. "2026-06-12"
  const [yearStr, monthStr, dayStr] = localDateString.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10); // 1-based
  const day = Number.parseInt(dayStr, 10);

  // Find the UTC instant for local midnight by binary-searching or by using
  // a known anchor: construct an ISO string that Intl will interpret as that
  // local day's midnight.
  //
  // Strategy: we know the local date. We want the UTC time T such that
  // `formatter.format(T)` == the same date string AND the local time is
  // "00:00". We achieve this by constructing the ISO string with a timeZone
  // offset that we derive via Intl.
  //
  // Simpler approach: use the offset implied by comparing a UTC-midnight
  // candidate for the local date against the actual formatter output.
  return findLocalMidnightUtc(tz, year, month, day);
}

/**
 * Selects users from `allUsers` whose local hour-of-day right now equals
 * their `digestSendHour` and who have digests enabled.
 *
 * Generic over T so callers can pass their own user shapes without importing
 * a DB type.
 */
export function usersDueAtHour<
  T extends { timezone: string; digestEnabled: boolean; digestSendHour: number },
>(allUsers: T[], now: Date): T[] {
  return allUsers.filter((user) => {
    if (!user.digestEnabled) return false;
    return localHourFor(user.timezone, now) === user.digestSendHour;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `tz` if it is a valid IANA timezone string recognised by this
 * runtime; otherwise returns `'UTC'`.
 */
function safeTimezone(tz: string): string {
  try {
    // A RangeError is thrown for unknown timezone identifiers.
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * Finds the UTC instant corresponding to local midnight (00:00:00) on the
 * given local calendar date in `tz`.
 *
 * We use a refinement approach:
 *  1. Build an approximate UTC candidate from the UTC date at midnight.
 *  2. Ask Intl what local date that candidate represents.
 *  3. If the local date matches (and it's at or before the target local day),
 *     fine-tune with the offset.
 *
 * In practice we resolve this cleanly by constructing the Date from the
 * assumption that local midnight = UTC midnight ± offset, where offset we
 * derive by asking Intl for both the UTC and local representations of a
 * reference point.
 */
function findLocalMidnightUtc(
  tz: string,
  year: number,
  month: number, // 1-based
  day: number,
): Date {
  // Use a timestamp near noon UTC on that calendar date as a reference —
  // it is virtually impossible for a timezone offset to shift noon by a full
  // day, so the local date at noon-UTC will equal the target local date.
  const noonUtcMs = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const noonUtc = new Date(noonUtcMs);

  // Determine the UTC offset (in minutes) at noonUtc in the target timezone.
  // Strategy: format noonUtc both as UTC and in the target tz, compute delta.
  const offsetMs = getOffsetMsAtInstant(tz, noonUtc);

  // Local midnight = UTC midnight - offset
  // i.e., UTC time when local clock reads 00:00 is:  00:00 UTC - (-offsetFromUtc)
  // offset = localTime - utcTime  →  localTime = utcTime + offset
  // We want utcTime such that utcTime + offset = 00:00 local
  //   → utcTime = -offset  (relative to local midnight as UTC midnight)
  const utcMidnightForLocalDate = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const candidateMs = utcMidnightForLocalDate - offsetMs;

  // Verify and correct: DST transitions can land exactly at midnight and shift
  // by an hour. Re-check by formatting `candidateMs` and adjusting if needed.
  const candidate = new Date(candidateMs);
  return verifyAndCorrectMidnight(tz, candidate, year, month, day);
}

/**
 * Returns the offset (in milliseconds, local - UTC) for a given timezone at a
 * specific instant.
 *
 * Approach: format the instant in UTC and in the target tz using the same
 * numeric parts, then compute the difference.
 */
function getOffsetMsAtInstant(tz: string, instant: Date): number {
  // Extract local numeric date/time parts via Intl.
  const localParts = getDateTimeParts(tz, instant);
  const utcParts = getDateTimeParts("UTC", instant);

  const localMs = partsToMs(localParts);
  const utcMs = partsToMs(utcParts);

  return localMs - utcMs;
}

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getDateTimeParts(tz: string, instant: Date): DateTimeParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    const v = Number.parseInt(part?.value ?? "0", 10);
    // Intl sometimes returns 24 for midnight with hour12:false
    return type === "hour" && v === 24 ? 0 : v;
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function partsToMs(p: DateTimeParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}

/**
 * Verifies that `candidate` maps to local midnight in `tz` for the target
 * date. If the local hour is non-zero (can happen when DST transition lands at
 * midnight), nudge by ±1 hour until we find the correct instant.
 */
function verifyAndCorrectMidnight(
  tz: string,
  candidate: Date,
  year: number,
  month: number, // 1-based
  day: number,
): Date {
  const localParts = getDateTimeParts(tz, candidate);

  // Happy path: candidate's local date matches and hour is 0.
  if (
    localParts.year === year &&
    localParts.month === month &&
    localParts.day === day &&
    localParts.hour === 0 &&
    localParts.minute === 0
  ) {
    return candidate;
  }

  // DST correction: try ±1h and ±2h (some half-hour zones might need ±30min
  // but those are handled by the offset calculation; ±1h covers DST spring).
  for (const deltaHours of [-1, 1, -2, 2]) {
    const adjusted = new Date(candidate.getTime() + deltaHours * 60 * 60 * 1000);
    const p = getDateTimeParts(tz, adjusted);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === 0 &&
      p.minute === 0
    ) {
      return adjusted;
    }
  }

  // Fallback: return the original candidate — close enough for daily cap math.
  return candidate;
}
