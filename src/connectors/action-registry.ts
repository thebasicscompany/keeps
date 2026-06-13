/**
 * Generic connector action core (Phase 4).
 *
 * The SINGLE execution path for every connector action. There is exactly one
 * way to run an action: build its Composio arguments from the frozen approved
 * payload, then call `executeComposioTool(slug, args)`. No proxyExecute, no
 * per-tool transport classes, no per-tool fakes — Slack and Calendar both run
 * through curated Composio action slugs.
 *
 * Three pieces:
 *   1. ACTION_REGISTRY     — the allowlist: connector_action_kind → { slug,
 *                            reversibility }. If a kind isn't here, it cannot run.
 *   2. buildComposioArguments — a PURE mapper: frozen payload → { slug, arguments }.
 *                            No I/O. Fully unit-testable. Owns the calendar
 *                            tz/duration math (salvaged from the deleted
 *                            calendar.ts transport).
 *   3. executeConnectorPayload — the dispatch: build args → executeComposioTool
 *                            → branch on `successful` → map the provider response
 *                            to a typed result. Does NO db work and NO approval
 *                            check — authorize happens UPSTREAM in the execute-once
 *                            transaction that calls this.
 *
 * FROZEN-PAYLOAD INVARIANT (load-bearing): what the user approves is byte-for-byte
 * what executes. The recipient is resolved upstream (recipient.ts) and frozen into
 * the payload (`channel` for slack_dm). This module NEVER resolves a recipient and
 * NEVER mutates the payload — it reads frozen fields and maps them to Composio args.
 *
 * @see src/connectors/composio.ts — executeComposioTool (the one transport)
 * @see src/agent/schemas.ts — connectorActionPayloadSchema (the frozen payload)
 * @see docs/phases/RESEARCH-COMPOSIO.md — verified slugs + response nesting
 */

import {
  executeComposioTool,
  type ComposioToolResult,
} from "@/connectors/composio";
import type {
  ConnectorActionKind,
  ConnectorActionPayload,
  SlackDmPayload,
  CalendarEventPayload,
} from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Curated Composio action slugs (verified — see RESEARCH-COMPOSIO.md)
// ---------------------------------------------------------------------------

/** Slack DM: args { channel, markdown_text } → data { ok, ts, channel } (FLAT). */
const SLACK_SEND_MESSAGE = "SLACK_SEND_MESSAGE";
/** Calendar: args { calendar_id, summary, start_datetime, ... } → data.response_data.{ id, htmlLink }. */
const GOOGLECALENDAR_CREATE_EVENT = "GOOGLECALENDAR_CREATE_EVENT";

// ---------------------------------------------------------------------------
// Reversibility classification
// ---------------------------------------------------------------------------

/**
 * How the policy gate must treat an action:
 *   - 'irreversible' — touches another person (a DM lands in their inbox, an
 *     invite hits their calendar). Hard approval; no take-backs.
 *   - 'reversible'   — self-only side effect (an event on the user's own
 *     calendar). A confirmation window / soft gate is acceptable.
 */
export type Reversibility = "irreversible" | "reversible";

/**
 * Classifies a frozen payload's reversibility.
 *   - slack_dm → always 'irreversible' (a DM always touches another person).
 *   - calendar_event → 'irreversible' if it invites attendees (touches others),
 *     else 'reversible' (self-only event on the user's own calendar).
 *
 * The workflow / authorize layer calls this to pick the gate.
 */
export function classifyReversibility(
  payload: ConnectorActionPayload,
): Reversibility {
  switch (payload.kind) {
    case "slack_dm":
      return "irreversible";
    case "calendar_event":
      return hasAttendees(payload) ? "irreversible" : "reversible";
  }
}

/** True when the calendar payload invites at least one attendee. */
function hasAttendees(payload: CalendarEventPayload): boolean {
  return Array.isArray(payload.attendees) && payload.attendees.length > 0;
}

// ---------------------------------------------------------------------------
// ACTION_REGISTRY — the allowlist
// ---------------------------------------------------------------------------

/** Per-kind registry entry: the curated slug + how to classify reversibility. */
export interface ActionRegistryEntry {
  /** The curated Composio action slug this kind executes through. */
  actionSlug: string;
  /**
   * Reversibility classifier. A function (not a constant) because calendar
   * reversibility depends on the payload (attendees → irreversible).
   */
  reversibility: (payload: ConnectorActionPayload) => Reversibility;
}

/**
 * The allowlist of permitted connector actions, keyed by connector_action_kind.
 * If a kind is not a key here, it is not a permitted action and cannot execute.
 */
export const ACTION_REGISTRY: Record<ConnectorActionKind, ActionRegistryEntry> = {
  slack_dm: {
    actionSlug: SLACK_SEND_MESSAGE,
    reversibility: () => "irreversible",
  },
  calendar_event: {
    actionSlug: GOOGLECALENDAR_CREATE_EVENT,
    reversibility: classifyReversibility,
  },
};

// ---------------------------------------------------------------------------
// Timezone / duration math (salvaged from deleted calendar.ts)
// ---------------------------------------------------------------------------

/** Fallback timezone when none is configured or the configured one is invalid. */
const DEFAULT_TIMEZONE = "UTC";
/** Default event length when the payload carries no duration. */
const DEFAULT_DURATION_MINUTES = 30;

/**
 * Resolves the user's IANA timezone, falling back to 'UTC' when unset/empty.
 * Does NOT validate the zone string — that happens in convertToNaiveLocal,
 * which falls back to UTC if Intl rejects it.
 */
function resolveTimezone(user: { timezone: string | null }): string {
  if (!user.timezone || user.timezone.trim() === "") {
    return DEFAULT_TIMEZONE;
  }
  return user.timezone.trim();
}

/** The naive local wall-clock datetime + the IANA zone it was computed in. */
interface NaiveLocalDateTime {
  /** 'YYYY-MM-DDTHH:MM:SS' — no 'Z', no offset (Google's start_datetime form). */
  startDatetime: string;
  /** The IANA timezone actually used (UTC if the requested one was invalid). */
  timezone: string;
}

/**
 * Converts an ISO 8601 instant (e.g. "2026-06-20T15:00:00.000Z") to the naive
 * local wall-clock datetime in the given IANA timezone, using only
 * Intl.DateTimeFormat (no new deps).
 *
 * GOOGLECALENDAR_CREATE_EVENT wants `start_datetime` as a NAIVE local datetime
 * ('YYYY-MM-DDTHH:MM:SS', no offset) plus a separate `timezone` field. So we
 * project the instant into the user's zone and read the wall-clock parts.
 *
 * Unknown/invalid IANA zone → falls back to UTC.
 */
function convertToNaiveLocal(
  isoString: string,
  ianaTimezone: string,
): NaiveLocalDateTime {
  const date = new Date(isoString);

  let tz = ianaTimezone;
  try {
    // Intl throws RangeError for an invalid timezone identifier.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = DEFAULT_TIMEZONE;
  }

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );

  const year = parts["year"] ?? "0000";
  const month = parts["month"] ?? "01";
  const day = parts["day"] ?? "01";
  // hour can render as "24" at midnight in some locales — normalize to "00".
  const rawHour = parts["hour"] ?? "00";
  const hour = rawHour === "24" ? "00" : rawHour;
  const minute = parts["minute"] ?? "00";
  const second = parts["second"] ?? "00";

  return {
    startDatetime: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    timezone: tz,
  };
}

/** Event duration split into Google's hour + minutes(0-59) fields. */
interface EventDuration {
  hours: number;
  minutes: number;
}

/**
 * Splits a total minutes count into { hours, minutes(0-59) }.
 * Google's GOOGLECALENDAR_CREATE_EVENT requires event_duration_minutes in 0-59
 * (never >= 60 — overflow goes into event_duration_hour instead).
 * Null/<=0 duration → default 30 minutes.
 */
function splitDuration(durationMinutes: number | null): EventDuration {
  const total =
    durationMinutes !== null && durationMinutes > 0
      ? Math.round(durationMinutes)
      : DEFAULT_DURATION_MINUTES;
  return {
    hours: Math.floor(total / 60),
    minutes: total % 60,
  };
}

// ---------------------------------------------------------------------------
// buildComposioArguments — the pure mapper
// ---------------------------------------------------------------------------

/** Context the mapper needs that isn't in the frozen payload (user's tz). */
export interface BuildArgumentsContext {
  user: { timezone: string | null };
}

/** A built Composio call: which slug, with which arguments. */
export interface ComposioCall {
  slug: string;
  arguments: Record<string, unknown>;
}

/**
 * PURE mapper: frozen payload (+ user tz) → { slug, arguments } ready for
 * executeComposioTool. No I/O. The slug comes from ACTION_REGISTRY.
 *
 *   slack_dm → SLACK_SEND_MESSAGE { channel, markdown_text }
 *     - `channel` is the FROZEN resolved Slack id (recipient resolved upstream).
 *     - `markdown_text` is the approved message (empty string when null —
 *       SLACK_SEND_MESSAGE requires a body).
 *
 *   calendar_event → GOOGLECALENDAR_CREATE_EVENT {
 *       calendar_id: 'primary', summary, start_datetime (naive local),
 *       timezone (IANA), event_duration_hour, event_duration_minutes,
 *       description?, attendees?, send_updates? }
 *     - whenAt (ISO) → naive local start_datetime + IANA timezone via Intl.
 *     - durationMinutes → event_duration_hour + event_duration_minutes(0-59),
 *       defaulting to 30 minutes.
 *     - attendees, when present, are passed through as emails and send_updates
 *       is set true so Google emails the invites.
 *
 * TODO(reminders): the curated GOOGLECALENDAR_CREATE_EVENT slug does NOT expose
 * custom reminder overrides, so reminderMinutesBefore is carried in the payload
 * but not mapped here — V0 accepts Google's default reminders (the event landing
 * at the right time IS the V0 reminder). Custom popups are a follow-up.
 */
export function buildComposioArguments(
  payload: ConnectorActionPayload,
  ctx: BuildArgumentsContext,
): ComposioCall {
  switch (payload.kind) {
    case "slack_dm":
      return buildSlackArguments(payload);
    case "calendar_event":
      return buildCalendarArguments(payload, ctx);
  }
}

function buildSlackArguments(payload: SlackDmPayload): ComposioCall {
  return {
    slug: ACTION_REGISTRY.slack_dm.actionSlug,
    arguments: {
      // Frozen resolved Slack destination — targeted verbatim, never re-resolved.
      channel: payload.channel,
      markdown_text: payload.message ?? "",
    },
  };
}

function buildCalendarArguments(
  payload: CalendarEventPayload,
  ctx: BuildArgumentsContext,
): ComposioCall {
  const iana = resolveTimezone(ctx.user);
  // whenAt should be non-null at execute time; default to "now" so the mapper
  // stays pure/total. The execute-once layer guarantees a resolved whenAt.
  const isoStart = payload.whenAt ?? new Date(0).toISOString();
  const { startDatetime, timezone } = convertToNaiveLocal(isoStart, iana);
  const { hours, minutes } = splitDuration(payload.durationMinutes);

  const args: Record<string, unknown> = {
    calendar_id: "primary",
    summary: payload.eventTitle ?? "Keeps reminder",
    start_datetime: startDatetime,
    timezone,
    event_duration_hour: hours,
    event_duration_minutes: minutes,
  };

  if (payload.description !== null) {
    args.description = payload.description;
  }

  if (Array.isArray(payload.attendees) && payload.attendees.length > 0) {
    args.attendees = payload.attendees;
    // Attendees present → Google should email the invites.
    args.send_updates = true;
  }

  return {
    slug: ACTION_REGISTRY.calendar_event.actionSlug,
    arguments: args,
  };
}

// ---------------------------------------------------------------------------
// Result types + errors
// ---------------------------------------------------------------------------

/** Typed result of a successful slack_dm execution. */
export interface SlackDmExecResult {
  kind: "slack_dm";
  /** The channel the message landed in (Slack echoes it back). */
  channel: string | null;
  /** The message timestamp / id (Slack `ts`). */
  ts: string | null;
}

/** Typed result of a successful calendar_event execution. */
export interface CalendarEventExecResult {
  kind: "calendar_event";
  /** The created Google Calendar event id. */
  eventId: string | null;
  /** URL to open the event in Google Calendar. */
  htmlLink: string | null;
}

/** The discriminated result of executeConnectorPayload. */
export type ConnectorExecResult = SlackDmExecResult | CalendarEventExecResult;

/**
 * Thrown when Composio resolved with `successful: false` (the provider rejected
 * the action — bad channel, calendar permission, etc.). Carries the Composio
 * error string and the raw data for diagnostics. This is an ACTION failure, not
 * a transport failure.
 */
export class ConnectorActionFailedError extends Error {
  readonly code = "CONNECTOR_ACTION_FAILED" as const;
  readonly composioError: string | null;
  readonly data: Record<string, unknown>;

  constructor(composioError: string | null, data: Record<string, unknown>) {
    super(
      `Connector action failed: ${composioError ?? "unknown Composio error"}`,
    );
    this.name = "ConnectorActionFailedError";
    this.composioError = composioError;
    this.data = data;
  }
}

/**
 * Thrown when the executor itself threw (network / 401 bad key / malformed
 * request) — i.e. the call never reached a `successful` verdict. Wraps the
 * underlying error.
 */
export class ConnectorTransportError extends Error {
  readonly code = "CONNECTOR_TRANSPORT_ERROR" as const;
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ConnectorTransportError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// executeConnectorPayload — the dispatch
// ---------------------------------------------------------------------------

/** The injectable executor signature (defaults to the real executeComposioTool). */
export type ConnectorExecutor = (
  slug: string,
  params: {
    userId: string;
    arguments: Record<string, unknown>;
    connectedAccountId?: string;
  },
) => Promise<ComposioToolResult>;

/** Parameters for executeConnectorPayload. */
export interface ExecuteConnectorPayloadParams {
  /** The frozen approved payload from connector_actions.payload. */
  payload: ConnectorActionPayload;
  /** Keeps user UUID — the Composio user/entity id. */
  keepsUserId: string;
  /** The exact connected account (ca_…) to pin execution to. */
  connectedAccountId: string;
  /** User record carrying the IANA timezone for calendar math. */
  user: { timezone: string | null };
  /** Injectable executor for tests; defaults to the real executeComposioTool. */
  execute?: ConnectorExecutor;
}

/**
 * Executes a frozen connector payload through the single Composio path.
 *
 * Flow: buildComposioArguments → execute(slug, args) → branch on `successful`
 *   - successful: true  → map the provider response to a typed ConnectorExecResult
 *       - slack_dm: response data is FLAT — { ok, ts, channel }.
 *       - calendar_event: created event lives at data.response_data.{id, htmlLink}.
 *   - successful: false → throw ConnectorActionFailedError(error, data).
 *   - executor throws (transport) → wrap in ConnectorTransportError.
 *
 * Does NO db work and NO approval check — the execute-once transaction that
 * calls this has already authorized.
 */
export async function executeConnectorPayload(
  params: ExecuteConnectorPayloadParams,
): Promise<ConnectorExecResult> {
  const { payload, keepsUserId, connectedAccountId, user } = params;
  const execute = params.execute ?? executeComposioTool;

  const { slug, arguments: args } = buildComposioArguments(payload, { user });

  let result: ComposioToolResult;
  try {
    result = await execute(slug, {
      userId: keepsUserId,
      arguments: args,
      connectedAccountId,
    });
  } catch (err) {
    throw new ConnectorTransportError(
      `Composio transport error executing ${slug}: ${String(err)}`,
      err,
    );
  }

  if (!result.successful) {
    throw new ConnectorActionFailedError(result.error, result.data);
  }

  switch (payload.kind) {
    case "slack_dm":
      return mapSlackResult(result.data);
    case "calendar_event":
      return mapCalendarResult(result.data);
  }
}

/** Maps the FLAT Slack response ({ ok, ts, channel }) to a typed result. */
function mapSlackResult(data: Record<string, unknown>): SlackDmExecResult {
  return {
    kind: "slack_dm",
    channel: typeof data.channel === "string" ? data.channel : null,
    ts: typeof data.ts === "string" ? data.ts : null,
  };
}

/** Maps the NESTED Calendar response (data.response_data.{id, htmlLink}). */
function mapCalendarResult(
  data: Record<string, unknown>,
): CalendarEventExecResult {
  const responseData =
    (data.response_data as Record<string, unknown> | undefined) ?? undefined;
  return {
    kind: "calendar_event",
    eventId:
      responseData && typeof responseData.id === "string"
        ? responseData.id
        : null,
    htmlLink:
      responseData && typeof responseData.htmlLink === "string"
        ? responseData.htmlLink
        : null,
  };
}
