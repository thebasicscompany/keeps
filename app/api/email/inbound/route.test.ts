import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route constructs a Drizzle-backed repository and dispatches a workflow event.
// Stub both so the 202 (happy-path) contract test never touches Postgres or Inngest;
// the 503/401/413 paths all return before these are reached.
const handleMock = vi.fn();

vi.mock("@/email/inbound-repository", () => ({
  DrizzleInboundEmailRepository: class {},
}));

vi.mock("@/email/inbound", () => ({
  handlePostmarkInboundEmail: (...args: unknown[]) => handleMock(...args),
}));

vi.mock("@/workflows/events", () => ({
  sendWorkflowEvent: vi.fn(),
}));

import { POST } from "./route";

const SECRET = "test-secret-1234";

const validResult = {
  status: "sender_verified" as const,
  normalized: {
    providerMessageId: "pm-1",
    from: { email: "arav@example.com" },
    subject: "Hello",
    attachmentCount: 0,
  },
  inboundEmailId: "ie-1",
  emailThreadId: "th-1",
  reply: null,
};

function makeRequest(options: {
  headers?: Record<string, string>;
  body?: unknown;
} = {}): Request {
  return new Request("https://keeps.ai/api/email/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(options.body ?? { From: "arav@example.com" }),
  });
}

beforeEach(() => {
  handleMock.mockReset();
  handleMock.mockResolvedValue(validResult);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/email/inbound — production hardening (C3)", () => {
  it("returns 503 webhook_secret_not_configured in production when the secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", undefined);

    const response = await POST(makeRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "webhook_secret_not_configured" });
    expect(handleMock).not.toHaveBeenCalled();
  });

  it("returns 401 when a secret is configured but the header does not match", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", SECRET);

    const response = await POST(
      makeRequest({ headers: { "x-keeps-webhook-secret": "wrong-secret" } }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(handleMock).not.toHaveBeenCalled();
  });

  it("returns 202 when the secret arrives as a basic-auth password (Postmark URL credentials)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/keeps");

    const response = await POST(
      makeRequest({
        headers: { authorization: `Basic ${btoa(`keeps:${SECRET}`)}` },
      }),
    );

    expect(response.status).toBe(202);
    expect(handleMock).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when the basic-auth password is wrong", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", SECRET);

    const response = await POST(
      makeRequest({
        headers: { authorization: `Basic ${btoa("keeps:wrong-secret")}` },
      }),
    );

    expect(response.status).toBe(401);
    expect(handleMock).not.toHaveBeenCalled();
  });

  it("returns 413 before parsing the body when content-length exceeds 10MB", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", SECRET);

    const response = await POST(
      makeRequest({
        headers: {
          "x-keeps-webhook-secret": SECRET,
          "content-length": String(11 * 1024 * 1024),
        },
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "payload_too_large" });
    expect(handleMock).not.toHaveBeenCalled();
  });

  it("returns 202 for a valid request with the correct secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/keeps");

    const response = await POST(
      makeRequest({ headers: { "x-keeps-webhook-secret": SECRET } }),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe("sender_verified");
    expect(handleMock).toHaveBeenCalledTimes(1);
  });

  it("returns 202 for a counterparty reply that the handler attaches to the thread owner (B3)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/keeps");

    // Counterparty (not a verified user) replies on a captured thread with known References.
    // The handler resolves the thread owner and returns a sender_verified-shaped result
    // whose reply is addressed to the OWNER — never to the counterparty.
    handleMock.mockResolvedValueOnce({
      status: "sender_verified" as const,
      normalized: {
        providerMessageId: "follow-1",
        from: { email: "jordan@example.com" },
        subject: "Re: Partner renewal",
        attachmentCount: 0,
      },
      inboundEmailId: "ie-follow-1",
      emailThreadId: "th-owner-1",
      reply: { to: "owner@example.com", subject: "Keeps saved this thread", text: "Got it." },
    });

    const response = await POST(
      makeRequest({
        body: {
          From: "Jordan <jordan@example.com>",
          Headers: [{ Name: "References", Value: "<thread-root@example.com>" }],
        },
      }),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      status: string;
      email: { from: string };
      reply: { to: string };
    };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe("sender_verified");
    expect(body.email.from).toBe("jordan@example.com");
    // The acknowledgement reply goes to the owner, not the counterparty.
    expect(body.reply.to).toBe("owner@example.com");
    expect(handleMock).toHaveBeenCalledTimes(1);
  });

  it("allows a missing secret outside production (local/dev)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("KEEPS_INBOUND_WEBHOOK_SECRET", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/keeps");

    const response = await POST(makeRequest());

    expect(response.status).toBe(202);
    expect(handleMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency regression (Phase 6 A5 — Deliverable 12)
//
// Verifies that POSTing the SAME Postmark payload twice does not produce a
// double-processed result at the HTTP route layer. The route must:
//   (a) pass through to handlePostmarkInboundEmail on BOTH deliveries (no
//       route-level short-circuit that silently swallows the second POST), and
//   (b) expose the handler's "duplicate" status in the 202 body so callers can
//       observe the dedup outcome.
//
// The DB-layer guarantee (exactly ONE inbound_emails row) is enforced by the
// unique index on (provider, providerMessageId) — see src/db/schema.ts line 292 —
// and is regression-tested at the service level in src/email/inbound.test.ts
// ("dedupes duplicate provider webhook deliveries").  This test covers the HTTP
// contract on top of that.
// ---------------------------------------------------------------------------

describe("POST /api/email/inbound — double-POST idempotency regression (D12)", () => {
  const SAME_PAYLOAD = {
    MessageID: "pm-idempotency-001",
    From: "arav@example.com",
    Subject: "Idempotency test",
  };

  const firstResult = {
    status: "sender_verified" as const,
    normalized: {
      providerMessageId: "pm-idempotency-001",
      from: { email: "arav@example.com" },
      subject: "Idempotency test",
      attachmentCount: 0,
    },
    inboundEmailId: "ie-idem-1",
    emailThreadId: "th-idem-1",
    reply: null,
  };

  // The handler returns "duplicate" on the second delivery — this is what the
  // Drizzle repository returns when the unique-index constraint fires.
  const duplicateResult = {
    status: "duplicate" as const,
    normalized: firstResult.normalized,
    inboundEmailId: "ie-idem-1",
    emailThreadId: "th-idem-1",
    reply: null,
  };

  beforeEach(() => {
    handleMock.mockReset();
    // First call: new message processed.
    handleMock.mockResolvedValueOnce(firstResult);
    // Second call: same providerMessageId → duplicate.
    handleMock.mockResolvedValueOnce(duplicateResult);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("double-POST: route calls the handler twice and both responses are 202 — second carries status 'duplicate'", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/keeps");

    const firstResponse = await POST(makeRequest({ body: SAME_PAYLOAD }));
    const secondResponse = await POST(makeRequest({ body: SAME_PAYLOAD }));

    // Both POSTs must be accepted by the route (Postmark expects 2xx on re-delivery).
    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);

    // The route must delegate BOTH deliveries to the handler — no route-level
    // short-circuit that would hide the re-delivery from the service layer.
    expect(handleMock).toHaveBeenCalledTimes(2);

    const firstBody = (await firstResponse.json()) as { accepted: boolean; status: string };
    const secondBody = (await secondResponse.json()) as { accepted: boolean; status: string };

    // First delivery: freshly processed.
    expect(firstBody.accepted).toBe(true);
    expect(firstBody.status).toBe("sender_verified");

    // Second delivery: handler signals duplicate — the route surfaces it.
    // This proves the unique-index guard in inbound_emails is the dedup boundary,
    // not any silent swallowing at the route level.
    expect(secondBody.accepted).toBe(true);
    expect(secondBody.status).toBe("duplicate");
  });
});
