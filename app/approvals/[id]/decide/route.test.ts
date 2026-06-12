/**
 * route.test.ts — POST /approvals/[id]/decide
 *
 * Follows the pattern established in app/api/email/inbound/route.test.ts:
 *   - vi.mock the repository and decide-web service so no Postgres/Inngest needed.
 *   - Test the HTTP contract (status codes, redirect URLs, form parsing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the import of `route.ts`
// ---------------------------------------------------------------------------

const decideFromWebMock = vi.fn();

vi.mock("@/approvals/decide-web", () => ({
  decideFromWeb: (...args: unknown[]) => decideFromWebMock(...args),
}));

vi.mock("@/approvals/repository", () => ({
  DrizzleApprovalRepository: class {},
}));

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPROVAL_ID = "00000000-0000-0000-0000-000000000001";
const VALID_TOKEN = "valid-plaintext-token";
const BASE_URL = `https://keeps.ai/approvals/${APPROVAL_ID}/decide`;

function makeFormRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request(BASE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

beforeEach(() => {
  decideFromWebMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Context helper — Next.js App Router passes params as a Promise
// ---------------------------------------------------------------------------

function makeContext(id = APPROVAL_ID) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /approvals/[id]/decide — missing fields", () => {
  it("returns 400 when token is missing", async () => {
    const response = await POST(
      makeFormRequest({ action: "approve" }),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("missing_token");
  });

  it("returns 400 when action is missing", async () => {
    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN }),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_action");
  });

  it("returns 400 when action is an unrecognized value", async () => {
    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "delete" }),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_action");
  });
});

describe("POST /approvals/[id]/decide — decided (PRG redirect)", () => {
  it("redirects to ?state=approved on a successful approve decision", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "decided", decision: "approved" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "approve" }),
      makeContext(),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain(`/approvals/${APPROVAL_ID}`);
    expect(location).toContain("state=approved");
  });

  it("redirects to ?state=cancelled on a successful cancel decision", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "decided", decision: "cancelled" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "cancel" }),
      makeContext(),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain("state=cancelled");
  });
});

describe("POST /approvals/[id]/decide — already_decided (idempotent)", () => {
  it("redirects to ?state=already_decided without error when already decided", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "already_decided", status: "approved" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "approve" }),
      makeContext(),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain("state=already_decided");
  });

  it("never returns a 5xx or error page for a double-submit", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "already_decided", status: "cancelled" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "cancel" }),
      makeContext(),
    );

    expect(response.status).toBeLessThan(400);
  });
});

describe("POST /approvals/[id]/decide — token failures", () => {
  it("redirects to ?state=invalid when the token is wrong", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "invalid_token" });

    const response = await POST(
      makeFormRequest({ token: "wrong-token", action: "approve" }),
      makeContext(),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain("state=invalid");
  });

  it("redirects to ?state=expired when the approval has lapsed", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "expired" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "approve" }),
      makeContext(),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain("state=expired");
  });

  it("redirects to ?state=not_found for an unknown approvalId", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "not_found" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "approve" }),
      makeContext(),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain("state=not_found");
  });
});

describe("POST /approvals/[id]/decide — never echoes token in redirect", () => {
  it("redirect URL does not contain the plaintext token", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "decided", decision: "approved" });

    const response = await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "approve" }),
      makeContext(),
    );

    const location = response.headers.get("location") ?? "";
    expect(location).not.toContain(VALID_TOKEN);
  });
});

describe("POST /approvals/[id]/decide — calls decideFromWeb with correct args", () => {
  it("passes approvalId, token, and action to decideFromWeb", async () => {
    decideFromWebMock.mockResolvedValue({ outcome: "decided", decision: "approved" });

    await POST(
      makeFormRequest({ token: VALID_TOKEN, action: "approve" }),
      makeContext(APPROVAL_ID),
    );

    expect(decideFromWebMock).toHaveBeenCalledTimes(1);
    const [callArg] = decideFromWebMock.mock.calls[0] as [
      { approvalId: string; token: string; action: string; now: Date }
    ];
    expect(callArg.approvalId).toBe(APPROVAL_ID);
    expect(callArg.token).toBe(VALID_TOKEN);
    expect(callArg.action).toBe("approve");
    expect(callArg.now).toBeInstanceOf(Date);
  });
});
