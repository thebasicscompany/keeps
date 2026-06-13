/**
 * Tests for resolveRecipient — the generic recipient resolver.
 *
 * No network, no Composio: a fake executor returns canned Composio
 * `{ data, successful, error }` responses keyed by slug. This replaces the
 * per-tool fake transport that the old slack.ts carried.
 */

import { describe, expect, it } from "vitest";
import {
  RecipientResolutionError,
  resolveRecipient,
  type ToolExecutor,
} from "@/connectors/recipient";
import type { ComposioToolResult } from "@/connectors/composio";

const CTX = { keepsUserId: "user-uuid", connectedAccountId: "ca_test" };

/** Build a fake executor from a slug→response map, recording calls. */
function fakeExecutor(
  responses: Record<string, ComposioToolResult>,
): ToolExecutor & { calls: { slug: string; arguments: Record<string, unknown> }[] } {
  const calls: { slug: string; arguments: Record<string, unknown> }[] = [];
  const fn = (async (slug, params) => {
    calls.push({ slug, arguments: params.arguments });
    return (
      responses[slug] ?? { data: {}, error: "no_canned_response", successful: false }
    );
  }) as ToolExecutor & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const ok = (data: Record<string, unknown>): ComposioToolResult => ({
  data,
  error: null,
  successful: true,
});
const fail = (error: string): ComposioToolResult => ({ data: {}, error, successful: false });

describe("resolveRecipient", () => {
  it("resolves by email exact-match (no list call)", async () => {
    const execute = fakeExecutor({
      SLACK_FIND_USER_BY_EMAIL_ADDRESS: ok({
        ok: true,
        user: { id: "U123", real_name: "Maya Patel", profile: { email: "maya@x.com" } },
      }),
    });
    const result = await resolveRecipient(
      { provider: "slack", nameText: "Maya", emailText: "maya@x.com" },
      { ...CTX, execute },
    );
    expect(result).toEqual({
      status: "resolved",
      destination: "U123",
      name: "Maya Patel",
      email: "maya@x.com",
    });
    // exact email hit short-circuits — never lists users.
    expect(execute.calls.map((c) => c.slug)).toEqual(["SLACK_FIND_USER_BY_EMAIL_ADDRESS"]);
  });

  it("falls back to name match when email misses", async () => {
    const execute = fakeExecutor({
      SLACK_FIND_USER_BY_EMAIL_ADDRESS: fail("users_not_found"),
      SLACK_LIST_ALL_USERS: ok({
        members: [
          { id: "U1", real_name: "Alex Kim", profile: { display_name: "alex" } },
          { id: "U2", real_name: "Maya Patel", profile: { display_name: "maya" } },
        ],
      }),
    });
    const result = await resolveRecipient(
      { provider: "slack", nameText: "Maya Patel", emailText: "missing@x.com" },
      { ...CTX, execute },
    );
    expect(result).toEqual({
      status: "resolved",
      destination: "U2",
      name: "Maya Patel",
      email: null,
    });
  });

  it("resolves by name alone when no email is provided", async () => {
    const execute = fakeExecutor({
      SLACK_LIST_ALL_USERS: ok({
        members: [{ id: "U9", real_name: "Sam Lee", profile: { display_name: "sam" } }],
      }),
    });
    const result = await resolveRecipient(
      { provider: "slack", nameText: "sam", emailText: null },
      { ...CTX, execute },
    );
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.destination).toBe("U9");
    // no email → no lookup call, straight to list.
    expect(execute.calls.map((c) => c.slug)).toEqual(["SLACK_LIST_ALL_USERS"]);
  });

  it("returns ambiguous when two users match the name (block-and-ask gate)", async () => {
    const execute = fakeExecutor({
      SLACK_LIST_ALL_USERS: ok({
        members: [
          { id: "U1", real_name: "Maya Patel", profile: { display_name: "maya" } },
          { id: "U2", real_name: "Maya Chen", profile: { display_name: "Maya" } },
        ],
      }),
    });
    const result = await resolveRecipient(
      { provider: "slack", nameText: "Maya", emailText: null },
      { ...CTX, execute },
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((c) => c.destination).sort()).toEqual(["U1", "U2"]);
    }
  });

  it("returns not_found when nothing matches", async () => {
    const execute = fakeExecutor({
      SLACK_FIND_USER_BY_EMAIL_ADDRESS: fail("users_not_found"),
      SLACK_LIST_ALL_USERS: ok({ members: [{ id: "U1", real_name: "Alex Kim" }] }),
    });
    const result = await resolveRecipient(
      { provider: "slack", nameText: "Nobody", emailText: "nobody@x.com" },
      { ...CTX, execute },
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when name is absent and email misses", async () => {
    const execute = fakeExecutor({
      SLACK_FIND_USER_BY_EMAIL_ADDRESS: fail("users_not_found"),
    });
    const result = await resolveRecipient(
      { provider: "slack", nameText: null, emailText: "ghost@x.com" },
      { ...CTX, execute },
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("throws RecipientResolutionError on a non-not-found lookup failure", async () => {
    const execute = fakeExecutor({
      SLACK_FIND_USER_BY_EMAIL_ADDRESS: fail("invalid_auth"),
    });
    await expect(
      resolveRecipient(
        { provider: "slack", nameText: "Maya", emailText: "maya@x.com" },
        { ...CTX, execute },
      ),
    ).rejects.toBeInstanceOf(RecipientResolutionError);
  });

  it("throws RecipientResolutionError when listing users fails", async () => {
    const execute = fakeExecutor({ SLACK_LIST_ALL_USERS: fail("ratelimited") });
    await expect(
      resolveRecipient(
        { provider: "slack", nameText: "Maya", emailText: null },
        { ...CTX, execute },
      ),
    ).rejects.toBeInstanceOf(RecipientResolutionError);
  });
});
