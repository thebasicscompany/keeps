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
    replyTo: buildNudgeReplyTo("11111111-1111-1111-1111-111111111111"),
    inReplyTo: "<source-message-id@keeps.local>",
    references: "<thread-root@keeps.local>",
    headers: { "X-Keeps-Kind": "private_reply" },
    ...overrides,
  };
}

describe("buildNudgeReplyTo", () => {
  it("builds a plus-routed mailbox with the n_ prefix", () => {
    expect(buildNudgeReplyTo("abc-123")).toBe("agent+n_abc-123@keeps.ai");
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
  it("returns a synthetic dev provider message id", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sender = new DevRecordingSender({ store });

    const result = await sender.send(makeMessage());

    expect(result.providerMessageId).toMatch(/^dev-[0-9a-f-]+@keeps\.local$/);
  });

  it("persists the full outbound message into the store", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sentAt = new Date("2026-06-12T10:00:00.000Z");
    const sender = new DevRecordingSender({ store, now: () => sentAt });

    const result = await sender.send(makeMessage());

    expect(store.sends).toHaveLength(1);
    const [recorded] = store.sends;
    expect(recorded).toMatchObject({
      userId: "user-1",
      nudgeId: "11111111-1111-1111-1111-111111111111",
      provider: "dev",
      providerMessageId: result.providerMessageId,
      toEmail: "arav@example.com",
      subject: "Re: your Keeps loop",
      textBody: "I found 1 loop.",
      replyTo: "agent+n_11111111-1111-1111-1111-111111111111@keeps.ai",
      inReplyTo: "<source-message-id@keeps.local>",
      referencesHeader: "<thread-root@keeps.local>",
      headers: { "X-Keeps-Kind": "private_reply" },
    });
  });

  it("derives the mailbox hash from the reply-to when not supplied", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sender = new DevRecordingSender({ store });

    await sender.send(makeMessage());

    expect(store.sends[0]?.mailboxHash).toBe("n_11111111-1111-1111-1111-111111111111");
  });

  it("transitions the referenced nudge to sent with sent_at", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sentAt = new Date("2026-06-12T10:00:00.000Z");
    const sender = new DevRecordingSender({ store, now: () => sentAt });

    await sender.send(makeMessage());

    expect(store.sentNudges).toEqual([
      { nudgeId: "11111111-1111-1111-1111-111111111111", sentAt },
    ]);
  });

  it("records empty headers and null optional fields when omitted", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sender = new DevRecordingSender({ store });

    await sender.send(
      makeMessage({ headers: undefined, replyTo: undefined, inReplyTo: undefined, references: undefined }),
    );

    expect(store.sends[0]).toMatchObject({
      headers: {},
      replyTo: null,
      inReplyTo: null,
      referencesHeader: null,
      mailboxHash: null,
    });
  });
});
