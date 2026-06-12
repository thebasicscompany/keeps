import { describe, expect, it } from "vitest";
import {
  buildNudgeReplyTo,
  DevRecordingSender,
  parseNudgeMailboxHash,
  type OutboundEmail,
  type OutboundEmailStore,
} from "@/email/outbound";

type RecordedSend = Parameters<OutboundEmailStore["recordSend"]>[0];

class InMemoryOutboundEmailStore implements OutboundEmailStore {
  readonly sends: RecordedSend[] = [];
  readonly sentNudges: { nudgeId: string; sentAt: Date }[] = [];

  async recordSend(input: RecordedSend): Promise<void> {
    this.sends.push(input);
  }

  async markNudgeSent(input: { nudgeId: string; sentAt: Date }): Promise<void> {
    this.sentNudges.push(input);
  }
}

function makeMessage(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    userId: "user-1",
    nudgeId: "11111111-1111-1111-1111-111111111111",
    to: "arav@example.com",
    subject: "Re: your Keeps loop",
    textBody: "I found 1 loop.",
    replyTo: buildNudgeReplyTo("11111111-1111-1111-1111-111111111111", "agent@keeps.ai"),
    inReplyTo: "<source-message-id@keeps.local>",
    references: "<thread-root@keeps.local>",
    headers: { "X-Keeps-Kind": "private_reply" },
    ...overrides,
  };
}

describe("buildNudgeReplyTo", () => {
  it("builds a plus-routed mailbox with the n_ prefix from the base address", () => {
    expect(buildNudgeReplyTo("abc-123", "agent@keeps.ai")).toBe("agent+n_abc-123@keeps.ai");
  });

  it("plus-routes onto the local part of a generated-inbound base address", () => {
    expect(buildNudgeReplyTo("abc-123", "abc123@inbound.postmarkapp.com")).toBe(
      "abc123+n_abc-123@inbound.postmarkapp.com",
    );
  });
});

describe("parseNudgeMailboxHash", () => {
  it("extracts the n_<uuid> hash from a reply-to", () => {
    expect(parseNudgeMailboxHash("agent+n_abc-123@keeps.ai")).toBe("n_abc-123");
  });

  it("returns null when there is no plus-routed hash", () => {
    expect(parseNudgeMailboxHash("agent@keeps.ai")).toBeNull();
    expect(parseNudgeMailboxHash(undefined)).toBeNull();
  });
});

describe("DevRecordingSender", () => {
  // Persistence (outbound row + nudge flip) is sendNudge's job for every transport —
  // covered in send-nudge.test.ts. The dev sender is a pure no-network transport.
  it("returns a synthetic dev provider message id and identifies as the dev provider", async () => {
    const sender = new DevRecordingSender();

    const result = await sender.send(makeMessage());

    expect(sender.provider).toBe("dev");
    expect(result.providerMessageId).toMatch(/^dev-[0-9a-f-]+@keeps\.local$/);
  });
});
