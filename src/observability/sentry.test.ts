/**
 * Pure unit tests for scrubEvent.
 *
 * No live DSN. No network calls. No @sentry/nextjs side-effects.
 * Tests run in the vitest node environment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ScrubEvent } from "./sentry";
import { scrubEvent } from "./sentry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(extra: Record<string, unknown>): ScrubEvent {
  return { extra };
}

// ---------------------------------------------------------------------------
// Email body fields — always stripped
// ---------------------------------------------------------------------------

describe("scrubEvent — email body fields", () => {
  it("strips textBody from event.extra.email", () => {
    const event = makeEvent({
      email: {
        textBody: "Hello from arav@example.com",
        subject: "Re: important",
      },
    });
    const scrubbed = scrubEvent(event);
    const emailExtra = scrubbed.extra?.email as Record<string, unknown>;
    expect(emailExtra.textBody).toBe("[REDACTED]");
    expect(emailExtra.subject).toBe("Re: important");
  });

  it("strips htmlBody from event.extra.email", () => {
    const event = makeEvent({
      email: { htmlBody: "<p>Click here</p>", from: "arav@example.com" },
    });
    const scrubbed = scrubEvent(event);
    const emailExtra = scrubbed.extra?.email as Record<string, unknown>;
    expect(emailExtra.htmlBody).toBe("[REDACTED]");
    expect(emailExtra.from).toBe("arav@example.com");
  });

  it("strips rawPayload from event.extra.email", () => {
    const event = makeEvent({
      email: { rawPayload: "MIME-Version: 1.0\r\n...", messageId: "abc123" },
    });
    const scrubbed = scrubEvent(event);
    const emailExtra = scrubbed.extra?.email as Record<string, unknown>;
    expect(emailExtra.rawPayload).toBe("[REDACTED]");
    expect(emailExtra.messageId).toBe("abc123");
  });

  it("strips all three body fields simultaneously", () => {
    const event = makeEvent({
      email: {
        textBody: "text",
        htmlBody: "<html>",
        rawPayload: "raw",
        subject: "keep me",
      },
    });
    const scrubbed = scrubEvent(event);
    const emailExtra = scrubbed.extra?.email as Record<string, unknown>;
    expect(emailExtra.textBody).toBe("[REDACTED]");
    expect(emailExtra.htmlBody).toBe("[REDACTED]");
    expect(emailExtra.rawPayload).toBe("[REDACTED]");
    expect(emailExtra.subject).toBe("keep me");
  });

  it("is a no-op when event.extra.email is absent", () => {
    const event = makeEvent({ userId: "u_123" });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.userId).toBe("u_123");
    expect(scrubbed.extra?.email).toBeUndefined();
  });

  it("is a no-op when event.extra is absent", () => {
    const event: ScrubEvent = {};
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Long-string truncation (risk mitigation)
// ---------------------------------------------------------------------------

describe("scrubEvent — long string truncation", () => {
  it("truncates top-level extra strings longer than 200 chars", () => {
    const longStr = "x".repeat(250);
    const event = makeEvent({ bigField: longStr });
    const scrubbed = scrubEvent(event);
    expect(typeof scrubbed.extra?.bigField).toBe("string");
    expect((scrubbed.extra?.bigField as string).length).toBeLessThanOrEqual(215); // 200 + " [truncated]"
    expect((scrubbed.extra?.bigField as string)).toContain("[truncated]");
  });

  it("does not truncate strings at exactly 200 chars", () => {
    const exactly200 = "a".repeat(200);
    const event = makeEvent({ field: exactly200 });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.field).toBe(exactly200);
  });

  it("does not truncate strings shorter than 200 chars", () => {
    const short = "hello world";
    const event = makeEvent({ field: short });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.field).toBe(short);
  });
});

// ---------------------------------------------------------------------------
// Email local-part redaction (flag-gated)
// ---------------------------------------------------------------------------

describe("scrubEvent — email local-part redaction", () => {
  beforeEach(() => {
    process.env.KEEPS_SENTRY_REDACT_EMAILS = "1";
  });

  afterEach(() => {
    delete process.env.KEEPS_SENTRY_REDACT_EMAILS;
  });

  it("redacts local-part of email addresses in extra strings when flag is 1", () => {
    const event = makeEvent({ from: "arav@example.com" });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.from).toBe("[redacted]@example.com");
  });

  it("preserves the domain portion of email addresses", () => {
    const event = makeEvent({ sender: "some.user+tag@keeps.ai" });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.sender).toBe("[redacted]@keeps.ai");
  });

  it("redacts multiple email addresses in one string", () => {
    const event = makeEvent({ log: "from arav@example.com to team@keeps.ai" });
    const scrubbed = scrubEvent(event);
    const val = scrubbed.extra?.log as string;
    expect(val).toContain("[redacted]@example.com");
    expect(val).toContain("[redacted]@keeps.ai");
    expect(val).not.toContain("arav@");
    expect(val).not.toContain("team@");
  });
});

describe("scrubEvent — email local-part NOT redacted without flag", () => {
  beforeEach(() => {
    delete process.env.KEEPS_SENTRY_REDACT_EMAILS;
  });

  it("does not redact email addresses when flag is unset", () => {
    const event = makeEvent({ from: "arav@example.com" });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.from).toBe("arav@example.com");
  });

  it("does not redact email addresses when flag is '0'", () => {
    process.env.KEEPS_SENTRY_REDACT_EMAILS = "0";
    const event = makeEvent({ from: "arav@example.com" });
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra?.from).toBe("arav@example.com");
    delete process.env.KEEPS_SENTRY_REDACT_EMAILS;
  });
});

// ---------------------------------------------------------------------------
// Immutability — original event must not be mutated
// ---------------------------------------------------------------------------

describe("scrubEvent — immutability", () => {
  it("does not mutate the original event.extra object", () => {
    const original = makeEvent({ email: { textBody: "secret" } });
    const originalExtra = original.extra;
    scrubEvent(original);
    // Original extra reference should be unchanged.
    const origEmail = originalExtra?.email as Record<string, unknown>;
    expect(origEmail.textBody).toBe("secret");
  });
});
