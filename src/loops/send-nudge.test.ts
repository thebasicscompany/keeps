import { describe, expect, it } from "vitest";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import {
  sendNudge,
  type SendableNudge,
  type SendNudgeRepository,
} from "@/loops/send-nudge";

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

class InMemorySendNudgeRepository implements SendNudgeRepository {
  constructor(private readonly nudges: Record<string, SendableNudge>) {}

  async findSendableNudge(nudgeId: string): Promise<SendableNudge | null> {
    return this.nudges[nudgeId] ?? null;
  }
}

const nudgeId = "22222222-2222-2222-2222-222222222222";
const sourceProviderMessageId = "<inbound-source-001@keeps.local>";

function makeRepository(overrides: Partial<SendableNudge> = {}) {
  return new InMemorySendNudgeRepository({
    [nudgeId]: {
      id: nudgeId,
      userId: "user-1",
      subject: "Re: Renewal packet",
      body: "I found 1 loop.\n\n1. Send the renewal packet.",
      toEmail: "arav@example.com",
      sourceProviderMessageId,
      referencesHeader: "<thread-root@keeps.local>",
      ...overrides,
    },
  });
}

describe("sendNudge", () => {
  it("sets Reply-To to agent+n_<nudgeId>@keeps.ai", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId,
      sender: new DevRecordingSender({ store }),
      repository: makeRepository(),
    });

    expect(result.status).toBe("sent");
    expect(store.sends[0]?.replyTo).toBe(`agent+n_${nudgeId}@keeps.ai`);
    // Reply-To must NOT ride in the generic headers map — Postmark rejects it there (300).
    expect(store.sends[0]?.headers["Reply-To"]).toBeUndefined();
  });

  it("records in_reply_to matching the source inbound provider message id", async () => {
    const store = new InMemoryOutboundEmailStore();
    await sendNudge({
      nudgeId,
      sender: new DevRecordingSender({ store }),
      repository: makeRepository(),
    });

    expect(store.sends[0]?.inReplyTo).toBe(sourceProviderMessageId);
    expect(store.sends[0]?.referencesHeader).toBe("<thread-root@keeps.local>");
    expect(store.sends[0]?.mailboxHash).toBe(`n_${nudgeId}`);
  });

  it("transitions the nudge status to sent", async () => {
    const store = new InMemoryOutboundEmailStore();
    const sentAt = new Date("2026-06-12T12:00:00.000Z");
    await sendNudge({
      nudgeId,
      sender: new DevRecordingSender({ store, now: () => sentAt }),
      repository: makeRepository(),
    });

    expect(store.sentNudges).toEqual([{ nudgeId, sentAt }]);
  });

  it("returns the synthetic dev provider message id", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId,
      sender: new DevRecordingSender({ store }),
      repository: makeRepository(),
    });

    if (result.status !== "sent") {
      throw new Error("expected sent result");
    }
    expect(result.providerMessageId).toMatch(/^dev-[0-9a-f-]+@keeps\.local$/);
  });

  it("falls back to a default subject and omits In-Reply-To when source is unknown", async () => {
    const store = new InMemoryOutboundEmailStore();
    await sendNudge({
      nudgeId,
      sender: new DevRecordingSender({ store }),
      repository: makeRepository({ subject: null, sourceProviderMessageId: null, referencesHeader: null }),
    });

    expect(store.sends[0]?.subject).toBe("Re: your Keeps loop");
    expect(store.sends[0]?.inReplyTo).toBeNull();
    expect(store.sends[0]?.headers["In-Reply-To"]).toBeUndefined();
  });

  it("returns missing_nudge when the nudge does not exist", async () => {
    const store = new InMemoryOutboundEmailStore();
    const result = await sendNudge({
      nudgeId: "00000000-0000-0000-0000-000000000000",
      sender: new DevRecordingSender({ store }),
      repository: makeRepository(),
    });

    expect(result).toEqual({ status: "missing_nudge", nudgeId: "00000000-0000-0000-0000-000000000000" });
    expect(store.sends).toHaveLength(0);
  });
});
