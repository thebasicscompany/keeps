import { nextWeekdayAtLocalHour, tomorrowAtLocalHour } from "@/users/timezone";

export type LoopReplyCommand =
  | {
      type: "confirm";
      rawText: string;
    }
  | {
      type: "correction";
      rawText: string;
      correctionText: string | null;
    }
  | {
      type: "dismiss";
      rawText: string;
      loopOrdinal: number;
    }
  | {
      type: "snooze";
      rawText: string;
      loopOrdinal: number | null;
      remindAtText: string;
      remindAt: Date | null;
    }
  | {
      type: "mark_done";
      rawText: string;
      loopOrdinal: number;
    }
  | {
      type: "unknown";
      rawText: string;
    };

export function parseLoopReplyCommand(
  text: string,
  options: { now?: Date; timezone?: string } = {},
): LoopReplyCommand {
  const rawText = text.trim();
  const normalized = rawText.toLowerCase();
  const now = options.now ?? new Date();
  const timezone = options.timezone;

  if (/^confirm\b/.test(normalized)) {
    return {
      type: "confirm",
      rawText,
    };
  }

  if (/^correct\b/.test(normalized)) {
    const correctionText = rawText.replace(/^correct\b[:\s-]*/i, "").trim();

    return {
      type: "correction",
      rawText,
      correctionText: correctionText || null,
    };
  }

  const dismissMatch = normalized.match(/^dismiss\s+(\d+)\b/);
  if (dismissMatch?.[1]) {
    return {
      type: "dismiss",
      rawText,
      loopOrdinal: Number.parseInt(dismissMatch[1], 10),
    };
  }

  const markDoneMatch = normalized.match(/^mark\s+(\d+)\s+done\b/);
  if (markDoneMatch?.[1]) {
    return {
      type: "mark_done",
      rawText,
      loopOrdinal: Number.parseInt(markDoneMatch[1], 10),
    };
  }

  // "done <N>" — alias of "mark N done" (digest reply footer form: "done 2").
  const doneMatch = normalized.match(/^done\s+(\d+)\b/);
  if (doneMatch?.[1]) {
    return {
      type: "mark_done",
      rawText,
      loopOrdinal: Number.parseInt(doneMatch[1], 10),
    };
  }

  // "snooze <N> until <time-text>" and "snooze <N> <time-text>" — the digest reply
  // footer form ("snooze 1 until Monday"). The ordinal is required; "until" is optional
  // sugar that is stripped before resolving the reminder date.
  const snoozeMatch = rawText.match(/^snooze\s+(\d+)\s+(?:until\s+)?(.+)$/i);
  if (snoozeMatch?.[1] && snoozeMatch[2]) {
    const remindAtText = snoozeMatch[2].trim();

    return {
      type: "snooze",
      rawText,
      loopOrdinal: Number.parseInt(snoozeMatch[1], 10),
      remindAtText,
      remindAt: resolveReminderDate(remindAtText, now, timezone),
    };
  }

  const remindMatch = rawText.match(/^remind(?:\s+me)?(?:\s+(\d+))?\s+(.+)$/i);
  if (remindMatch?.[2]) {
    const remindAtText = remindMatch[2].trim();

    return {
      type: "snooze",
      rawText,
      loopOrdinal: remindMatch[1] ? Number.parseInt(remindMatch[1], 10) : null,
      remindAtText,
      remindAt: resolveReminderDate(remindAtText, now, timezone),
    };
  }

  return {
    type: "unknown",
    rawText,
  };
}

const REMINDER_HOUR = 9;

function resolveReminderDate(text: string, now: Date, timezone?: string): Date | null {
  const lower = text.toLowerCase();

  if (lower.includes("tomorrow")) {
    // Timezone-aware: tomorrow at 9 AM in the user's local zone (Deliverable #15).
    // Without a timezone, preserve the original UTC behavior exactly.
    if (timezone) {
      return tomorrowAtLocalHour(timezone, now, REMINDER_HOUR);
    }
    const date = atReminderHour(now);
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }

  const weekday = weekdayIndex(lower);
  if (weekday !== null) {
    if (timezone) {
      return nextWeekdayAtLocalHour(timezone, now, weekday, REMINDER_HOUR);
    }
    const date = atReminderHour(now);
    const currentWeekday = date.getUTCDay();
    let daysUntil = (weekday - currentWeekday + 7) % 7;

    if (daysUntil === 0) {
      daysUntil = 7;
    }

    date.setUTCDate(date.getUTCDate() + daysUntil);
    return date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function atReminderHour(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 9));
}

function weekdayIndex(value: string): number | null {
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const index = weekdays.findIndex((weekday) => value.includes(weekday));

  return index >= 0 ? index : null;
}
