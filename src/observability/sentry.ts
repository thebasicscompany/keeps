/**
 * Sentry shared configuration + PII scrubber for Keeps.
 *
 * Design decisions:
 *   - initSentry() is a no-op when SENTRY_DSN is not set (safe in tests/dev).
 *   - scrubEvent() is a pure function exported for unit testing — it uses a
 *     minimal local type so tests don't need to import Sentry SDK types.
 *   - beforeSend always runs scrubEvent so PII never leaves the process.
 *   - KEEPS_SENTRY_REDACT_EMAILS==='1' enables local-part redaction.
 */

// ---------------------------------------------------------------------------
// Minimal local type used by scrubEvent — avoids coupling tests to Sentry types.
// @sentry/nextjs ErrorEvent satisfies this shape.
// ---------------------------------------------------------------------------

/** Minimal event shape that scrubEvent operates on. */
export interface ScrubEvent {
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// PII scrubber — pure, unit-testable
// ---------------------------------------------------------------------------

const EMAIL_RE = /([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)(@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)/g;
const MAX_EXTRA_STRING_LEN = 200;

/**
 * Strips sensitive email body fields and optionally redacts email local-parts.
 * Also truncates any extra string longer than 200 chars.
 *
 * Returns a new event object with a shallow-copied extra — does not mutate the input.
 */
export function scrubEvent<T extends ScrubEvent>(event: T): T {
  const redactEmails = process.env.KEEPS_SENTRY_REDACT_EMAILS === "1";

  if (!event.extra || typeof event.extra !== "object") {
    return event;
  }

  // Shallow-copy extra so we don't mutate the original object.
  const extra: Record<string, unknown> = { ...event.extra };

  // 1. Strip known high-volume PII fields unconditionally.
  const emailExtra = extra.email as Record<string, unknown> | undefined;
  if (emailExtra && typeof emailExtra === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(emailExtra)) {
      if (k === "textBody" || k === "htmlBody" || k === "rawPayload") {
        scrubbed[k] = "[REDACTED]";
      } else {
        scrubbed[k] = v;
      }
    }
    extra.email = scrubbed;
  }

  // 2. Scrub any extra string longer than MAX_EXTRA_STRING_LEN (risk mitigation).
  //    Walk top-level extra keys only (nested values are rarely set here).
  for (const key of Object.keys(extra)) {
    const val = extra[key];
    if (typeof val === "string" && val.length > MAX_EXTRA_STRING_LEN) {
      extra[key] = val.slice(0, MAX_EXTRA_STRING_LEN) + " [truncated]";
    }
  }

  // 3. Optionally redact email local-parts throughout the serialized event.
  //    We re-serialize only the extra object (not the whole event) to limit scope.
  if (redactEmails) {
    let serialized = JSON.stringify(extra);
    serialized = serialized.replace(EMAIL_RE, (_match, _local, domain) => `[redacted]${domain}`);
    try {
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        extra[key] = parsed[key];
      }
    } catch {
      // If re-parse somehow fails, leave the original scrubbed extra.
    }
  }

  return { ...event, extra };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let _initialized = false;

/**
 * Initialize Sentry for the given runtime.
 * No-op when SENTRY_DSN is not set.
 */
export function initSentry(runtime: "server" | "client" | "edge"): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (_initialized) return;

  // Dynamic import avoided intentionally: @sentry/nextjs is always available in
  // the Next.js server/edge runtimes. We import it at module evaluation time only
  // inside initSentry (called lazily) so test environments never touch it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sentry = require("@sentry/nextjs") as typeof import("@sentry/nextjs");

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV === "production" ? "production" : "development"),
    // Low sample rate by default; override via SENTRY_TRACES_SAMPLE_RATE if needed.
    tracesSampleRate: runtime === "edge" ? 0 : 0.1,
    // Never send full raw request bodies — belt-and-suspenders on top of beforeSend.
    sendDefaultPii: false,
    beforeSend(event, _hint) {
      // scrubEvent is generic over ScrubEvent; ErrorEvent satisfies that shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return scrubEvent(event as any) as typeof event;
    },
  });

  _initialized = true;
}
