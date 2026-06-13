/**
 * Unit tests for src/connectors/slack.ts (Phase 4 B1).
 *
 * No network, no real Composio — everything runs through the fake transport.
 * Covers:
 *   - resolveSlackUser: email hit; email miss + name hit; name ambiguous (two
 *     Mayas); no results.
 *   - executeSlackDm: happy path records exactly one sendMessage call with the
 *     right channel + markdown text; send-failure surfaces a typed error.
 */

import { describe, expect, it } from "vitest";

import {
  SlackTransportError,
  createFakeSlackTransport,
  executeSlackDm,
  resolveSlackUser,
} from "@/connectors/slack";

// ---------------------------------------------------------------------------
// resolveSlackUser
// ---------------------------------------------------------------------------

describe("resolveSlackUser", () => {
  it("resolves by email when there is an exact email hit", async () => {
    const transport = createFakeSlackTransport({
      users: [
        { id: "U1", name: "Maya Chen", email: "maya@acme.com" },
        { id: "U2", name: "Bob Lee", email: "bob@acme.com" },
      ],
    });

    const result = await resolveSlackUser(
      { email: "maya@acme.com", name: "Maya Chen" },
      transport,
    );

    expect(result).toEqual({
      status: "resolved",
      userId: "U1",
      name: "Maya Chen",
      email: "maya@acme.com",
    });
  });

  it("falls back to a name match when the email misses", async () => {
    const transport = createFakeSlackTransport({
      users: [
        { id: "U1", name: "Maya Chen", email: "maya@acme.com" },
        { id: "U2", name: "Bob Lee", email: "bob@acme.com" },
      ],
    });

    // Email not in workspace → falls through to name match on "Bob Lee".
    const result = await resolveSlackUser(
      { email: "bob@gmail.com", name: "Bob Lee" },
      transport,
    );

    expect(result).toEqual({
      status: "resolved",
      userId: "U2",
      name: "Bob Lee",
      email: "bob@acme.com",
    });
  });

  it("matches names case-insensitively against displayName too", async () => {
    const transport = createFakeSlackTransport({
      users: [{ id: "U9", name: "Margaret Okeke", displayName: "mags", email: null }],
    });

    const result = await resolveSlackUser({ email: null, name: "MAGS" }, transport);

    expect(result).toEqual({
      status: "resolved",
      userId: "U9",
      name: "Margaret Okeke",
      email: null,
    });
  });

  it("returns ambiguous with candidates when two users share the name", async () => {
    const transport = createFakeSlackTransport({
      users: [
        { id: "U1", name: "Maya", email: null },
        { id: "U2", name: "Maya", email: null },
        { id: "U3", name: "Carlos", email: null },
      ],
    });

    const result = await resolveSlackUser({ email: null, name: "Maya" }, transport);

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.userId).sort()).toEqual(["U1", "U2"]);
  });

  it("returns not_found when neither email nor name matches", async () => {
    const transport = createFakeSlackTransport({
      users: [{ id: "U1", name: "Maya Chen", email: "maya@acme.com" }],
    });

    const result = await resolveSlackUser(
      { email: "nobody@acme.com", name: "Nobody Here" },
      transport,
    );

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when there is no email and no name", async () => {
    const transport = createFakeSlackTransport({
      users: [{ id: "U1", name: "Maya Chen", email: "maya@acme.com" }],
    });

    const result = await resolveSlackUser({ email: null, name: null }, transport);

    expect(result).toEqual({ status: "not_found" });
  });

  it("prefers the email hit even when a name would be ambiguous", async () => {
    // Email is exact-match 1:1, so it wins before the name fallback runs.
    const transport = createFakeSlackTransport({
      users: [
        { id: "U1", name: "Maya", email: "maya.chen@acme.com" },
        { id: "U2", name: "Maya", email: "maya.diaz@acme.com" },
      ],
    });

    const result = await resolveSlackUser(
      { email: "maya.diaz@acme.com", name: "Maya" },
      transport,
    );

    expect(result).toEqual({
      status: "resolved",
      userId: "U2",
      name: "Maya",
      email: "maya.diaz@acme.com",
    });
  });
});

// ---------------------------------------------------------------------------
// executeSlackDm
// ---------------------------------------------------------------------------

describe("executeSlackDm", () => {
  it("records exactly one sendMessage with the resolved user id as channel", async () => {
    const transport = createFakeSlackTransport();

    const result = await executeSlackDm(
      { slackUserId: "U123", message: "Hey, following up on the contract." },
      transport,
    );

    expect(transport.sends).toHaveLength(1);
    expect(transport.sends[0]).toEqual({
      channel: "U123",
      markdownText: "Hey, following up on the contract.",
    });
    expect(result.ok).toBe(true);
    expect(result.channel).toBe("U123");
    expect(typeof result.ts).toBe("string");
  });

  it("surfaces a typed SlackTransportError when the send fails", async () => {
    const transport = createFakeSlackTransport({
      failSends: true,
      sendError: "channel_not_found",
    });

    await expect(
      executeSlackDm({ slackUserId: "U404", message: "hi" }, transport),
    ).rejects.toBeInstanceOf(SlackTransportError);

    // The call is still recorded (attempted) before the throw.
    expect(transport.sends).toHaveLength(1);
    expect(transport.sends[0].channel).toBe("U404");

    // The raw Composio error string is carried for Wave D to inspect.
    try {
      await executeSlackDm({ slackUserId: "U404", message: "hi" }, transport);
      throw new Error("expected executeSlackDm to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SlackTransportError);
      expect((e as SlackTransportError).composioError).toBe("channel_not_found");
    }
  });

  it("does NOT resolve the recipient — it uses the id verbatim", async () => {
    // Even though a user with this email exists, executeSlackDm sends to the
    // literal slackUserId it is given (resolution is upstream).
    const transport = createFakeSlackTransport({
      users: [{ id: "U1", name: "Maya", email: "maya@acme.com" }],
    });

    await executeSlackDm({ slackUserId: "D_PRE_RESOLVED", message: "approved text" }, transport);

    expect(transport.sends).toHaveLength(1);
    expect(transport.sends[0].channel).toBe("D_PRE_RESOLVED");
    expect(transport.sends[0].markdownText).toBe("approved text");
  });
});
