import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNudgeReplyTo, type OutboundEmail } from "@/email/outbound";
import { PostmarkSender, PostmarkSendError } from "@/email/postmark-sender";

const CONFIG = {
  serverToken: "server-token-abc",
  fromAddress: "agent@keeps.ai",
  replyToBase: "agent@keeps.ai",
  messageStream: "outbound",
};

function makeSender() {
  return new PostmarkSender(CONFIG);
}

function okResponse(messageId = "pm-message-1"): Response {
  return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: messageId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastRequest() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}

describe("PostmarkSender.send", () => {
  it("POSTs to the Postmark email endpoint with the server-token header", async () => {
    const result = await makeSender().send({
      userId: "u1",
      nudgeId: "n1",
      to: "person@example.com",
      subject: "Subject",
      textBody: "Body",
    });

    expect(result).toEqual({ providerMessageId: "pm-message-1" });
    const req = lastRequest();
    expect(req.url).toBe("https://api.postmarkapp.com/email");
    expect(req.headers["X-Postmark-Server-Token"]).toBe("server-token-abc");
    expect(req.headers["Content-Type"]).toBe("application/json");
  });

  it("(a) builds the exact body for a plain reply with no threading", async () => {
    const email: OutboundEmail = {
      userId: "u1",
      nudgeId: "n1",
      to: "stranger@example.com",
      subject: "Re: your note",
      textBody: "Sign up at https://keeps.ai/sign-up",
    };

    await makeSender().send(email);

    expect(lastRequest().body).toEqual({
      From: "agent@keeps.ai",
      To: "stranger@example.com",
      Subject: "Re: your note",
      TextBody: "Sign up at https://keeps.ai/sign-up",
      MessageStream: "outbound",
    });
  });

  it("(b) builds the exact body for a nudge reply with ReplyTo + In-Reply-To + References", async () => {
    const nudgeId = "11111111-1111-1111-1111-111111111111";
    const email: OutboundEmail = {
      userId: "u1",
      nudgeId,
      to: "person@example.com",
      subject: "Re: the deck",
      textBody: "You said you'd send the deck Friday.",
      htmlBody: "<p>You said you'd send the deck Friday.</p>",
      replyTo: buildNudgeReplyTo(nudgeId, "agent@keeps.ai"),
      inReplyTo: "<source-message-id@mail.gmail.com>",
      references: "<thread-root@mail.gmail.com> <source-message-id@mail.gmail.com>",
      headers: { "X-Keeps-Kind": "private_reply" },
    };

    await makeSender().send(email);

    expect(lastRequest().body).toEqual({
      From: "agent@keeps.ai",
      To: "person@example.com",
      Subject: "Re: the deck",
      TextBody: "You said you'd send the deck Friday.",
      HtmlBody: "<p>You said you'd send the deck Friday.</p>",
      ReplyTo: `agent+n_${nudgeId}@keeps.ai`,
      MessageStream: "outbound",
      Headers: [
        { Name: "X-Keeps-Kind", Value: "private_reply" },
        { Name: "In-Reply-To", Value: "<source-message-id@mail.gmail.com>" },
        { Name: "References", Value: "<thread-root@mail.gmail.com> <source-message-id@mail.gmail.com>" },
      ],
    });
  });

  it("throws PostmarkSendError with the Postmark ErrorCode on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ErrorCode: 406, Message: "Inactive recipient" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      makeSender().send({
        userId: "u1",
        nudgeId: "n1",
        to: "blocked@example.com",
        subject: "S",
        textBody: "B",
      }),
    ).rejects.toMatchObject({
      name: "PostmarkSendError",
      statusCode: 422,
      errorCode: 406,
      message: "Inactive recipient",
    });
  });

  it("throws PostmarkSendError when Postmark returns 200 but a non-zero ErrorCode", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid email request" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await makeSender()
      .send({ userId: "u1", nudgeId: "n1", to: "x@example.com", subject: "S", textBody: "B" })
      .catch((e) => e);

    expect(error).toBeInstanceOf(PostmarkSendError);
    expect(error.errorCode).toBe(300);
  });
});
