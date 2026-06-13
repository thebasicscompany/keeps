import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRecordingSender } from "@/email/outbound";
import { getEmailSender } from "@/email/sender-factory";
import { PostmarkSender } from "@/email/postmark-sender";
import { SuppressionAwareSender } from "@/email/suppression";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getEmailSender", () => {
  it("returns a SuppressionAwareSender wrapping PostmarkSender when POSTMARK_SERVER_TOKEN is set", () => {
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "server-token-abc");

    const sender = getEmailSender();
    expect(sender).toBeInstanceOf(SuppressionAwareSender);
    // The wrapper proxies the inner provider name
    expect(sender.provider).toBe(PostmarkSender.provider);
  });

  it("returns a SuppressionAwareSender wrapping DevRecordingSender when POSTMARK_SERVER_TOKEN is unset", () => {
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/keeps_test");

    const sender = getEmailSender();
    expect(sender).toBeInstanceOf(SuppressionAwareSender);
    expect(sender.provider).toBe(DevRecordingSender.provider);
  });
});
