import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookEvent } from "@clerk/nextjs/webhooks";

import userCreatedVerified from "./fixtures/user-created-verified.json";
import userCreatedPending from "./fixtures/user-created-pending.json";
import userUpdatedSecondAddress from "./fixtures/user-updated-second-address.json";

// The route verifies via Clerk's Svix-backed helper and delegates all DB work to
// `upsertClerkUserAndClaimInbound`. Mock both: `verifyWebhook` to return a fixture (or throw
// for the 401 path) and the helper to a spy so the route's branching + idempotency contract is
// asserted without touching Postgres. The helper's own row-level idempotency is covered
// end-to-end in `src/auth/clerk-users.test.ts` (the replay test).
const verifyWebhookMock = vi.fn();
const upsertMock = vi.fn();

vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: (...args: unknown[]) => verifyWebhookMock(...args),
}));

vi.mock("@/auth/clerk-users", () => ({
  upsertClerkUserAndClaimInbound: (...args: unknown[]) => upsertMock(...args),
}));

const { POST } = await import("../../../app/api/auth/clerk/webhook/route");

function makeRequest(): Request {
  return new Request("https://keeps.ai/api/auth/clerk/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

beforeEach(() => {
  verifyWebhookMock.mockReset();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({ user: { id: "usr_1", email: "x@example.com" }, claimedEmails: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/clerk/webhook (B1)", () => {
  it("returns 401 when Svix verification fails", async () => {
    verifyWebhookMock.mockRejectedValue(new Error("bad signature"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("user.created with an already-verified primary upserts as verified", async () => {
    verifyWebhookMock.mockResolvedValue(userCreatedVerified as unknown as WebhookEvent);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith({
      clerkUserId: "user_2created_verified",
      email: "newuser@example.com",
      verified: true,
    });
  });

  it("user.created with an unverified primary upserts as pending (no claim)", async () => {
    verifyWebhookMock.mockResolvedValue(userCreatedPending as unknown as WebhookEvent);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith({
      clerkUserId: "user_2created_pending",
      email: "pending@example.com",
      verified: false,
    });
  });

  it("user.updated invokes the claim helper for every verified address", async () => {
    verifyWebhookMock.mockResolvedValue(userUpdatedSecondAddress as unknown as WebhookEvent);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(2);
    // The newly-verified second address is claimed for the existing user.
    expect(upsertMock).toHaveBeenCalledWith({
      clerkUserId: "user_2existing",
      email: "primary@example.com",
      verified: true,
    });
    expect(upsertMock).toHaveBeenCalledWith({
      clerkUserId: "user_2existing",
      email: "second@example.com",
      verified: true,
    });
  });

  it("replaying the same event produces identical helper invocations (idempotent at the route)", async () => {
    verifyWebhookMock.mockResolvedValue(userUpdatedSecondAddress as unknown as WebhookEvent);

    const first = await POST(makeRequest());
    const replay = await POST(makeRequest());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    // Each delivery calls the helper with the same args; the helper itself upserts (no
    // duplicate identities) and dedupes the claim — verified in clerk-users.test.ts.
    expect(upsertMock).toHaveBeenCalledTimes(4);
    const argsList = upsertMock.mock.calls.map(([arg]) => arg);
    expect(argsList[0]).toEqual(argsList[2]);
    expect(argsList[1]).toEqual(argsList[3]);
  });

  it("acknowledges unhandled event types with 200 and no helper call", async () => {
    verifyWebhookMock.mockResolvedValue({
      type: "session.created",
      object: "event",
      data: { id: "sess_1" },
    } as unknown as WebhookEvent);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ignored: "session.created" });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
