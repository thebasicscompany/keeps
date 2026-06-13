/**
 * Next.js client-side instrumentation hook — browser Sentry init.
 *
 * Loaded by Next.js in the browser bundle. No-op when the public DSN is unset.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
 */

import { initSentry } from "./src/observability/sentry";

// initSentry reads SENTRY_DSN (and NEXT_PUBLIC_SENTRY_DSN falls back to it via
// Next.js public variable inlining). Returns early if neither is set.
initSentry("client");
