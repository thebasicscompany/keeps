/**
 * src/connectors/connect-flow.test.ts
 *
 * Unit tests for the pure connect-flow core.
 *
 * No Clerk, no database, no @composio/core. All I/O is replaced by in-memory
 * fakes injected via the dependency parameters of connectFlow / reconnectFlow.
 *
 * Covers:
 *   1. Happy path — returns redirectUrl and connectedAccountId
 *   2. Composio userId passed is the INTERNAL Keeps UUID, never the Clerk id
 *   3. Unauthenticated (null Clerk id) → { ok: false, error: 'unauthenticated' }
 *   4. Missing identity row → { ok: false, error: 'user_not_found' }
 *   5. MissingComposioConfigError → { ok: false, error: 'not_configured' }
 *   6. reconnectFlow delegates to the same core as connectFlow (V0 symmetry)
 *   7. Unexpected errors from createSession are re-thrown (not swallowed)
 */

import { describe, expect, it } from "vitest";
import {
  connectFlow,
  reconnectFlow,
  type CreateConnectSessionFn,
  type ResolveUserFn,
  type ConnectFlowInput,
} from "@/connectors/connect-flow";
import { MissingComposioConfigError } from "@/connectors/composio";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const CLERK_USER_ID = "clerk_user_abc123";
const INTERNAL_USER_ID = "d7f505a5-917d-4f5e-9fd8-d2b6c4fcf170"; // UUID-shaped
const REDIRECT_URL = "https://composio.dev/oauth/connect?token=xyz";
const CONNECTED_ACCOUNT_ID = "ca_TEST1234";
const CALLBACK_URL = "https://keeps.email/settings/connectors?connected=slack";

/** Fake user resolver that maps the test Clerk ID to the test internal UUID. */
const fakeResolveUser: ResolveUserFn = async (clerkUserId) => {
  if (clerkUserId === CLERK_USER_ID) return INTERNAL_USER_ID;
  return null;
};

/** Fake createSession that records calls and returns a fixed result. */
function makeFakeCreateSession() {
  const calls: Parameters<CreateConnectSessionFn>[0][] = [];

  const fn: CreateConnectSessionFn = async (params) => {
    calls.push(params);
    return {
      redirectUrl: REDIRECT_URL,
      connectedAccountId: CONNECTED_ACCOUNT_ID,
    };
  };

  return { fn, calls };
}

/** Build a fully wired ConnectFlowInput for the happy-path test. */
function makeInput(
  overrides: Partial<ConnectFlowInput> = {},
): ConnectFlowInput {
  const { fn } = makeFakeCreateSession();
  return {
    clerkUserId: CLERK_USER_ID,
    provider: "slack",
    callbackUrl: CALLBACK_URL,
    resolveUser: fakeResolveUser,
    createSession: fn,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// connectFlow — happy path
// ---------------------------------------------------------------------------

describe("connectFlow — happy path", () => {
  it("returns ok:true with redirectUrl and connectedAccountId on success", async () => {
    const result = await connectFlow(makeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");
    expect(result.redirectUrl).toBe(REDIRECT_URL);
    expect(result.connectedAccountId).toBe(CONNECTED_ACCOUNT_ID);
  });

  it("works for google_calendar provider", async () => {
    const result = await connectFlow(makeInput({ provider: "google_calendar" }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");
    expect(result.redirectUrl).toBe(REDIRECT_URL);
  });

  it("passes the callbackUrl through to createSession", async () => {
    const { fn, calls } = makeFakeCreateSession();
    const customCallback = "https://keeps.email/settings/connectors?connected=google_calendar";

    await connectFlow(
      makeInput({ createSession: fn, callbackUrl: customCallback }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.callbackUrl).toBe(customCallback);
  });
});

// ---------------------------------------------------------------------------
// connectFlow — CRITICAL: Composio userId must be the INTERNAL UUID
// ---------------------------------------------------------------------------

describe("connectFlow — userId invariant", () => {
  it("passes the INTERNAL user UUID (not the Clerk id) as userId to createSession", async () => {
    const { fn, calls } = makeFakeCreateSession();

    await connectFlow(makeInput({ createSession: fn }));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;

    // Must be the internal UUID
    expect(call.userId).toBe(INTERNAL_USER_ID);

    // Must NOT be the Clerk ID
    expect(call.userId).not.toBe(CLERK_USER_ID);
    expect(call.userId).not.toMatch(/^clerk_/);
  });

  it("passes the provider through unchanged", async () => {
    const { fn, calls } = makeFakeCreateSession();

    await connectFlow(makeInput({ createSession: fn, provider: "google_calendar" }));

    expect(calls[0]?.provider).toBe("google_calendar");
  });
});

// ---------------------------------------------------------------------------
// connectFlow — unauthenticated
// ---------------------------------------------------------------------------

describe("connectFlow — unauthenticated", () => {
  it("returns { ok: false, error: 'unauthenticated' } when clerkUserId is null", async () => {
    const result = await connectFlow(makeInput({ clerkUserId: null }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("unauthenticated");
  });

  it("returns { ok: false, error: 'unauthenticated' } when clerkUserId is undefined", async () => {
    const result = await connectFlow(makeInput({ clerkUserId: undefined }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("unauthenticated");
  });

  it("does not call createSession when unauthenticated", async () => {
    const { fn, calls } = makeFakeCreateSession();

    await connectFlow(makeInput({ clerkUserId: null, createSession: fn }));

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// connectFlow — user_not_found
// ---------------------------------------------------------------------------

describe("connectFlow — user_not_found", () => {
  it("returns { ok: false, error: 'user_not_found' } when no identity row exists", async () => {
    // Provide a Clerk ID that the resolver does not recognise.
    const unknownClerkId = "clerk_UNKNOWN";

    const result = await connectFlow(makeInput({ clerkUserId: unknownClerkId }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("user_not_found");
  });

  it("does not call createSession when identity row is missing", async () => {
    const { fn, calls } = makeFakeCreateSession();

    await connectFlow(
      makeInput({ clerkUserId: "clerk_UNKNOWN", createSession: fn }),
    );

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// connectFlow — not_configured (MissingComposioConfigError)
// ---------------------------------------------------------------------------

describe("connectFlow — not_configured", () => {
  it("returns { ok: false, error: 'not_configured' } when createSession throws MissingComposioConfigError", async () => {
    const throwingSession: CreateConnectSessionFn = async () => {
      throw new MissingComposioConfigError("COMPOSIO_SLACK_AUTH_CONFIG_ID is not set");
    };

    const result = await connectFlow(makeInput({ createSession: throwingSession }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("not_configured");
  });

  it("includes the error detail from MissingComposioConfigError", async () => {
    const errorMessage = "COMPOSIO_GCAL_AUTH_CONFIG_ID is not set — configure it";
    const throwingSession: CreateConnectSessionFn = async () => {
      throw new MissingComposioConfigError(errorMessage);
    };

    const result = await connectFlow(makeInput({ createSession: throwingSession }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    if (result.error !== "not_configured") throw new Error("narrowing");
    expect(result.detail).toBe(errorMessage);
  });
});

// ---------------------------------------------------------------------------
// connectFlow — unexpected errors are re-thrown
// ---------------------------------------------------------------------------

describe("connectFlow — unexpected errors", () => {
  it("re-throws non-MissingComposioConfigError errors from createSession", async () => {
    const networkError = new Error("fetch failed — ECONNREFUSED");
    const throwingSession: CreateConnectSessionFn = async () => {
      throw networkError;
    };

    await expect(
      connectFlow(makeInput({ createSession: throwingSession })),
    ).rejects.toThrow("fetch failed — ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// reconnectFlow — V0 symmetry with connectFlow
// ---------------------------------------------------------------------------

describe("reconnectFlow — V0 delegates to same core as connectFlow", () => {
  it("returns the same shape as connectFlow on success", async () => {
    const connectResult = await connectFlow(makeInput());
    const reconnectResult = await reconnectFlow(makeInput());

    // Both should succeed with the same structure
    expect(connectResult.ok).toBe(true);
    expect(reconnectResult.ok).toBe(true);
    if (!connectResult.ok || !reconnectResult.ok) throw new Error("narrowing");
    expect(reconnectResult.redirectUrl).toBe(connectResult.redirectUrl);
    expect(reconnectResult.connectedAccountId).toBe(connectResult.connectedAccountId);
  });

  it("passes the INTERNAL UUID as userId (same invariant as connectFlow)", async () => {
    const { fn, calls } = makeFakeCreateSession();

    await reconnectFlow(makeInput({ createSession: fn }));

    expect(calls[0]?.userId).toBe(INTERNAL_USER_ID);
    expect(calls[0]?.userId).not.toBe(CLERK_USER_ID);
  });

  it("returns unauthenticated for null Clerk id", async () => {
    const result = await reconnectFlow(makeInput({ clerkUserId: null }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("unauthenticated");
  });

  it("returns not_configured when createSession throws MissingComposioConfigError", async () => {
    const throwingSession: CreateConnectSessionFn = async () => {
      throw new MissingComposioConfigError("COMPOSIO_SLACK_AUTH_CONFIG_ID is not set");
    };

    const result = await reconnectFlow(makeInput({ createSession: throwingSession }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toBe("not_configured");
  });
});
