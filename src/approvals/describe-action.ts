/**
 * src/approvals/describe-action.ts
 *
 * Pure, dependency-free helper that converts an (actionKind, payload) pair
 * into a human-readable title + row list.  No JSON.stringify ever reaches the
 * output — that is the invariant this module exists to guarantee.
 */

// ---------------------------------------------------------------------------
// Internal keys that are always stripped from user-visible output
// ---------------------------------------------------------------------------

const INTERNAL_KEYS = new Set([
  "token",
  "tokenHash",
  "id",
  "userId",
  "draftId",
  "kind",
  "channel", // Slack channel id — internal resolver field
]);

// ---------------------------------------------------------------------------
// Friendly value formatter
// ---------------------------------------------------------------------------

/**
 * Destination object shape as stored in the connector payload.
 */
interface Destination {
  kind: "person" | "self";
  nameText: string | null;
  emailText: string | null;
}

function isDestination(v: unknown): v is Destination {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    (obj.kind === "person" || obj.kind === "self") &&
    ("nameText" in obj || "emailText" in obj)
  );
}

/**
 * Recursively format a value into a human-readable string.
 * Depth-limited to prevent infinite recursion on deeply-nested structures.
 * NEVER produces a raw `{...}` or `[...]` JSON dump.
 */
function friendlyValue(value: unknown, depth = 0): string {
  // Null / undefined / empty string
  if (value === null || value === undefined || value === "") return "—";

  // Scalars
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "object") return String(value);

  // Destination shape — most important nested object in this codebase
  if (isDestination(value)) {
    if (value.kind === "self") return "yourself";
    const name = value.nameText?.trim() || null;
    const email = value.emailText?.trim() || null;
    if (name && email) return `${name} (${email})`;
    return name ?? email ?? "—";
  }

  // Array
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    const items = value.map((item) => friendlyValue(item, depth + 1));
    const joined = items.join(", ");
    return items.length > 1 ? `${joined} (${items.length})` : joined;
  }

  // Generic object — depth-limited key: value pairs
  if (depth >= 3) return "[object]";

  const obj = value as Record<string, unknown>;
  const pairs = Object.entries(obj)
    .filter(([k]) => !INTERNAL_KEYS.has(k))
    .map(([k, v]) => `${humanizeKey(k)}: ${friendlyValue(v, depth + 1)}`);

  return pairs.length > 0 ? pairs.join("; ") : "—";
}

// ---------------------------------------------------------------------------
// Key humaniser (camelCase / snake_case → "Title Case")
// ---------------------------------------------------------------------------

function humanizeKey(key: string): string {
  // snake_case → spaces
  const spaced = key.replace(/_/g, " ");
  // camelCase → spaces (e.g. eventTitle → event Title)
  const withCamel = spaced.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Title-case the first word
  return withCamel.charAt(0).toUpperCase() + withCamel.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Date/time formatter (Intl — built-in, no extra deps)
// ---------------------------------------------------------------------------

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "time to be confirmed";
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return iso;
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(dt);
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export interface DescribeActionRow {
  label: string;
  value: string;
}

export interface DescribeActionResult {
  title: string;
  rows: DescribeActionRow[];
}

// ---------------------------------------------------------------------------
// Per-kind handlers
// ---------------------------------------------------------------------------

function describeSlackDm(payload: Record<string, unknown>): DescribeActionResult {
  const destination = payload.destination as Destination | undefined;
  const recipientName = (payload.recipientName as string | null) ?? null;
  const recipientEmail = (payload.recipientEmail as string | null) ?? null;
  const message = (payload.message as string | null) ?? null;

  // Build "To" value: prefer explicit recipient fields; fall back to destination.
  let toValue: string;
  if (recipientName && recipientEmail) {
    toValue = `${recipientName} (${recipientEmail})`;
  } else if (recipientName) {
    toValue = recipientName;
  } else if (recipientEmail) {
    toValue = recipientEmail;
  } else if (destination) {
    toValue = friendlyValue(destination);
  } else {
    toValue = "—";
  }

  const rows: DescribeActionRow[] = [
    { label: "To", value: toValue },
    { label: "Message", value: message ?? "—" },
  ];

  return { title: "Send a Slack message", rows };
}

function describeCalendarEvent(payload: Record<string, unknown>): DescribeActionResult {
  const eventTitle = (payload.eventTitle as string | null) ?? null;
  const whenAt = (payload.whenAt as string | null) ?? null;
  const durationMinutes = (payload.durationMinutes as number | null) ?? null;
  const reminderMinutesBefore = (payload.reminderMinutesBefore as number | null) ?? null;
  const attendees = (payload.attendees as string[] | null) ?? null;

  const rows: DescribeActionRow[] = [
    { label: "Event", value: eventTitle ?? "—" },
    { label: "When", value: formatDateTime(whenAt) },
  ];

  if (durationMinutes !== null) {
    rows.push({ label: "Duration", value: `${durationMinutes} minutes` });
  }

  if (attendees && attendees.length > 0) {
    const names = attendees.join(", ");
    rows.push({ label: "Attendees", value: `${names} (${attendees.length})` });
  }

  if (reminderMinutesBefore !== null) {
    rows.push({ label: "Reminder", value: `${reminderMinutesBefore} min before` });
  }

  return { title: "Add a calendar event", rows };
}

function describeTestAction(payload: Record<string, unknown>): DescribeActionResult {
  const rows: DescribeActionRow[] = Object.entries(payload)
    .filter(([k]) => !INTERNAL_KEYS.has(k))
    .map(([k, v]) => ({
      label: humanizeKey(k),
      value: typeof v === "object" ? friendlyValue(v) : String(v ?? "—"),
    }));

  return { title: "Test action", rows };
}

function describeUnknown(actionKind: string, payload: Record<string, unknown>): DescribeActionResult {
  const title = humanizeKey(actionKind);

  const rows: DescribeActionRow[] = Object.entries(payload)
    .filter(([k]) => !INTERNAL_KEYS.has(k))
    .map(([k, v]) => ({
      label: humanizeKey(k),
      value: friendlyValue(v),
    }));

  return { title, rows };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable title + row list for any (actionKind, payload) pair.
 *
 * Guarantees:
 *   - title is a natural language verb phrase, never the raw kind string.
 *   - No row value ever contains a raw JSON dump (`{...}` or `[...]`).
 *   - Internal/sensitive keys (token, tokenHash, id, userId, draftId, kind,
 *     channel) are always stripped.
 */
export function describeApprovalAction(
  actionKind: string,
  payload: Record<string, unknown>,
): DescribeActionResult {
  switch (actionKind) {
    case "slack_dm":
    case "send_slack_message":
      // connector kind "slack_dm" and policy kind "send_slack_message" both
      // produce a Slack message — prefer the connector handler when the payload
      // has destination/message shape; fall through to unknown otherwise.
      if ("destination" in payload || "message" in payload || "recipientName" in payload) {
        return describeSlackDm(payload);
      }
      return describeUnknown(actionKind, payload);

    case "calendar_event":
    case "create_calendar_event":
      if ("eventTitle" in payload || "whenAt" in payload || "attendees" in payload) {
        return describeCalendarEvent(payload);
      }
      return describeUnknown(actionKind, payload);

    case "test_action":
      return describeTestAction(payload);

    default:
      return describeUnknown(actionKind, payload);
  }
}
