/**
 * NudgeType — the allowed values for nudges.nudge_type (text column in the DB).
 *
 * The column is intentionally stored as `text` rather than a Postgres enum so that
 * new nudge kinds can be added without a migration.  This union type is the
 * application-level contract; callers MUST use one of these values.
 *
 * Values:
 *   private_reply   — a one-on-one reply to a loop extraction email, asking the user
 *                     to confirm/dismiss/correct a candidate loop.
 *   nudge           — a periodic check-in for an open/active loop whose next_check_at
 *                     has elapsed.
 *   digest          — a daily summary digest grouping all of a user's active loops.
 *   approval        — an outbound approval-request email containing approve/edit/cancel
 *                     links for a pending draft action.
 *   expiry          — a notification email sent when an approval request expires without
 *                     a decision.
 */
export type NudgeType = "private_reply" | "nudge" | "digest" | "approval" | "expiry";

/**
 * Type guard: returns true if the given string is a valid NudgeType.
 * Useful when reading nudge_type back from the database (text column).
 */
export function isNudgeType(value: string): value is NudgeType {
  return (
    value === "private_reply" ||
    value === "nudge" ||
    value === "digest" ||
    value === "approval" ||
    value === "expiry"
  );
}
