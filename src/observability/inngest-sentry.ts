/**
 * withInngestSentry — transparent error-capture wrapper for Inngest function handlers.
 *
 * On thrown error, captures to Sentry with contextual tags, then rethrows so Inngest
 * can still retry / fail the step normally. Completely transparent when Sentry is not
 * initialised (DSN unset) — the wrapper just awaits the handler.
 *
 * Usage (minimal edit to existing createFunction calls):
 *
 *   async ({ event, step }) => withInngestSentry(
 *     { functionId: "process-email", eventId: event.id },
 *     () => { ... original body ... }
 *   )
 */

// ---------------------------------------------------------------------------
// Context passed by the Inngest wrapper
// ---------------------------------------------------------------------------
export interface InngestSentryContext {
  /** Inngest function id (e.g. "process-email"). */
  functionId: string;
  /** Inngest event id from the trigger event. */
  eventId?: string;
  /** Optional step name when capturing inside a step. */
  step?: string;
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

/**
 * Runs `handler()`. On error, captures the exception to Sentry (if initialised)
 * with the provided context tags, then rethrows.
 *
 * This is intentionally NOT an async decorator that wraps the createFunction
 * callback at the module level — doing so would introduce a closure that fires
 * once per Inngest replay even when no error occurs, and the DSN-guard must be
 * inside the async flow (not at import time) to avoid breaking tests.
 */
export async function withInngestSentry<T>(
  context: InngestSentryContext,
  handler: () => Promise<T>,
): Promise<T> {
  try {
    return await handler();
  } catch (err) {
    // Only capture if Sentry is available and has a DSN.
    if (process.env.SENTRY_DSN) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Sentry = require("@sentry/nextjs") as typeof import("@sentry/nextjs");
        Sentry.withScope((scope) => {
          scope.setTag("inngest.function", context.functionId);
          if (context.step) scope.setTag("inngest.step", context.step);
          if (context.eventId) scope.setTag("inngest.event_id", context.eventId);
          Sentry.captureException(err);
        });
      } catch {
        // Never let Sentry errors swallow the original exception.
      }
    }
    throw err;
  }
}
