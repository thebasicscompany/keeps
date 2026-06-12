import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRecordingSender } from "@/email/outbound";
import { getEmailSender } from "@/email/sender-factory";
import { PostmarkSender } from "@/email/postmark-sender";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getEmailSender", () => {
  it("returns a PostmarkSender when POSTMARK_SERVER_TOKEN is set", () => {
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "server-token-abc");

    expect(getEmailSender()).toBeInstanceOf(PostmarkSender);
  });

  it("returns the DevRecordingSender when POSTMARK_SERVER_TOKEN is unset", () => {
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
    // DevRecordingSender eagerly builds a Drizzle store that needs DATABASE_URL.
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/keeps_test");

    expect(getEmailSender()).toBeInstanceOf(DevRecordingSender);
  });
});
