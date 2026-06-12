import { describe, expect, it } from "vitest";
import { formatFailureAlert, getAlertRecipient } from "@/workflows/functions/alert-on-failure";
import { buildCanaryPayload, CANARY_USER_EMAIL } from "@/workflows/functions/canary";

describe("formatFailureAlert", () => {
  it("includes function id, run id, trigger, and error message", () => {
    const alert = formatFailureAlert({
      function_id: "keeps-process-email",
      run_id: "01ABC",
      error: { message: "boom" },
      event: { name: "email.received" },
    });

    expect(alert.subject).toBe("[keeps alert] keeps-process-email failed");
    expect(alert.textBody).toContain("Run: 01ABC");
    expect(alert.textBody).toContain("Trigger: email.received");
    expect(alert.textBody).toContain("Error: boom");
  });

  it("degrades gracefully when the failure payload is sparse", () => {
    const alert = formatFailureAlert({});

    expect(alert.subject).toBe("[keeps alert] unknown-function failed");
    expect(alert.textBody).toContain("Error: no error message");
  });
});

describe("getAlertRecipient", () => {
  it("falls back to the pilot operator", () => {
    expect(getAlertRecipient()).toContain("@");
  });
});

describe("buildCanaryPayload", () => {
  it("builds a schema-valid Postmark payload from the canary user", () => {
    const payload = buildCanaryPayload("canary-123");

    expect(payload.MessageID).toBe("canary-123");
    expect(payload.FromFull.Email).toBe(CANARY_USER_EMAIL);
    expect(payload.Subject).toContain("canary-123");
    expect(payload.Headers[0]?.Value).toContain("canary-123");
    // Body must contain an extractable commitment so the model/regex path yields >= 1 loop.
    expect(payload.TextBody).toMatch(/I'll .*by/i);
  });
});
