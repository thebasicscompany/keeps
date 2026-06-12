import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import { sendSystemEmail } from "@/email/system-send";
import { PostmarkSender } from "@/email/postmark-sender";

// ---------------------------------------------------------------------------
// In-memory fake store (same pattern as outbound.test.ts / send-nudge.test.ts)
// ---------------------------------------------------------------------------

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

const BASE_EMAIL = {
  to: "newcomer@example.com",
  subject: "Welcome to Keeps",
  textBody: "Thanks for emailing Keeps. Here is how to get started…",
};

// ---------------------------------------------------------------------------
// sendSystemEmail tests
// ---------------------------------------------------------------------------

describe("sendSystemEmail", () => {
  it("sets Auto-Submitted: auto-replied on the outgoing email", async () => {
    // Capture the OutboundEmail passed to sender.send so we can inspect headers.
    let capturedHeaders: Record<string, string> | undefined;
    const capturingSender = {
      provider: "dev" as const,
      async send(email: Parameters<DevRecordingSender["send"]>[0]) {
        capturedHeaders = email.headers;
        return { providerMessageId: "dev-captured@keeps.local" };
      },
    };

    await sendSystemEmail({
      email: BASE_EMAIL,
      sender: capturingSender,
      store: new InMemoryOutboundEmailStore(),
    });

    expect(capturedHeaders?.["Auto-Submitted"]).toBe("auto-replied");
  });

  it("persists a row with null userId and nudgeId", async () => {
    const store = new InMemoryOutboundEmailStore();

    await sendSystemEmail({
      email: BASE_EMAIL,
      sender: new DevRecordingSender(),
      store,
    });

    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]?.userId).toBeNull();
    expect(store.sends[0]?.nudgeId).toBeNull();
  });

  it("persists the correct provider, providerMessageId, toEmail, and subject", async () => {
    const store = new InMemoryOutboundEmailStore();
    const fixedId = "dev-fixed-001@keeps.local";
    const fixedSender = {
      provider: "dev" as const,
      async send() {
        return { providerMessageId: fixedId };
      },
    };

    await sendSystemEmail({
      email: BASE_EMAIL,
      sender: fixedSender,
      store,
    });

    const row = store.sends[0];
    expect(row?.provider).toBe("dev");
    expect(row?.providerMessageId).toBe(fixedId);
    expect(row?.toEmail).toBe(BASE_EMAIL.to);
    expect(row?.subject).toBe(BASE_EMAIL.subject);
  });

  it("returns the providerMessageId from the sender", async () => {
    const store = new InMemoryOutboundEmailStore();

    const result = await sendSystemEmail({
      email: BASE_EMAIL,
      sender: new DevRecordingSender(),
      store,
    });

    expect(result.providerMessageId).toMatch(/^dev-[0-9a-f-]+@keeps\.local$/);
  });

  it("never calls markNudgeSent — there is no nudge to flip", async () => {
    const store = new InMemoryOutboundEmailStore();

    await sendSystemEmail({
      email: BASE_EMAIL,
      sender: new DevRecordingSender(),
      store,
    });

    expect(store.sentNudges).toHaveLength(0);
  });

  it("threads correctly: inReplyTo and references land on the persisted row", async () => {
    const store = new InMemoryOutboundEmailStore();

    await sendSystemEmail({
      email: {
        ...BASE_EMAIL,
        inReplyTo: "<source-001@mail.example.com>",
        references: "<thread-root@mail.example.com>",
      },
      sender: new DevRecordingSender(),
      store,
    });

    expect(store.sends[0]?.inReplyTo).toBe("<source-001@mail.example.com>");
    expect(store.sends[0]?.referencesHeader).toBe("<thread-root@mail.example.com>");
  });

  it("persists replyTo as null — no plus-routed mailbox for system emails", async () => {
    const store = new InMemoryOutboundEmailStore();

    await sendSystemEmail({
      email: BASE_EMAIL,
      sender: new DevRecordingSender(),
      store,
    });

    expect(store.sends[0]?.replyTo).toBeNull();
    expect(store.sends[0]?.mailboxHash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PostmarkSender-level assertion: Auto-Submitted header lands in Headers array
// ---------------------------------------------------------------------------

describe("PostmarkSender — Auto-Submitted header mapping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "pm-sys-001" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the Auto-Submitted header into the Postmark Headers array", async () => {
    const sender = new PostmarkSender({
      serverToken: "tok",
      fromAddress: "agent@keeps.ai",
      replyToBase: "agent@keeps.ai",
      messageStream: "outbound",
    });

    await sender.send({
      userId: null,
      nudgeId: null,
      to: "newcomer@example.com",
      subject: "Welcome",
      textBody: "Hi",
      headers: { "Auto-Submitted": "auto-replied" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.Headers).toEqual(
      expect.arrayContaining([{ Name: "Auto-Submitted", Value: "auto-replied" }]),
    );
    // Reply-To must not appear — system emails have no plus-routed mailbox.
    expect(body.ReplyTo).toBeUndefined();
  });
});
