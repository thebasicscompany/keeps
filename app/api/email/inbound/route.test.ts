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
