/**
 * app/settings/privacy/retention.ts
 *
 * Pure mapping between UI select labels / values and the
 * users.rawEmailRetentionDays column value (integer | null).
 *
 * null means "until I delete" (never scrubbed by the cron).
 *
 * Exported as a standalone module so unit tests can import it
 * without pulling in any server / React / DB dependencies.
 */

export interface RetentionOption {
  /** The value submitted by the HTML select (string, because FormData). */
  selectValue: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** The value written to users.rawEmailRetentionDays (null = never). */
  days: number | null;
}

export const RETENTION_OPTIONS: RetentionOption[] = [
  { selectValue: "30",   label: "30 days",        days: 30  },
  { selectValue: "90",   label: "90 days",        days: 90  },
  { selectValue: "365",  label: "1 year (365 days)", days: 365 },
  { selectValue: "null", label: "Until I delete", days: null },
];

/**
 * Convert a select value string ("30" | "90" | "365" | "null") to the
 * column value (number | null). Returns null for unknown values.
 */
export function selectValueToDays(selectValue: string): number | null {
  const option = RETENTION_OPTIONS.find((o) => o.selectValue === selectValue);
  return option ? option.days : null;
}

/**
 * Convert a column value (number | null) to the matching select value string.
 * Falls back to "30" (the column default) when no match is found.
 */
export function daysToSelectValue(days: number | null): string {
  if (days === null) return "null";
  const option = RETENTION_OPTIONS.find((o) => o.days === days);
  return option ? option.selectValue : "30";
}
