/**
 * Next.js instrumentation hook — server + edge Sentry init.
 *
 * Called once per runtime on cold start. No-op when SENTRY_DSN is unset.
 * We do NOT use withSentryConfig in next.config (that triggers @sentry/cli).
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  // Next.js sets NEXT_RUNTIME to "nodejs" or "edge" in the respective runtimes.
  // Absent means an old Next.js or a test runner — treat as server.
  const runtime = process.env.NEXT_RUNTIME;

  if (runtime === "edge") {
    const { initSentry } = await import("./src/observability/sentry");
    initSentry("edge");
  } else {
    // nodejs (default) — includes API routes, Server Components, etc.
    const { initSentry } = await import("./src/observability/sentry");
    initSentry("server");
  }
}

/**
 * onRequestError — forwarded to Sentry.captureRequestError when available.
 * Receives unhandled errors from Next.js server-side request handlers.
 *
 * The type is `unknown` here to avoid importing Next.js internals; Sentry's
 * `captureRequestError` accepts `(error, request, errorContext)` and we
 * forward the full arguments tuple.
 */
export const onRequestError: (...args: unknown[]) => void | Promise<void> = async (
  ...args
) => {
  if (!process.env.SENTRY_DSN) return;

  try {
    const Sentry = await import("@sentry/nextjs");
    if (typeof Sentry.captureRequestError === "function") {
      // @ts-expect-error — args tuple matches Sentry's expected signature at runtime
      await Sentry.captureRequestError(...args);
    }
  } catch {
    // Silently swallow — never let observability failures surface to the user.
  }
};
