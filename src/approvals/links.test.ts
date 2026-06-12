import { describe, expect, it } from "vitest";
import { buildApprovalLinks } from "@/approvals/links";

describe("buildApprovalLinks", () => {
  const APP_URL = "https://app.keeps.ai";
  const APPROVAL_ID = "11111111-1111-1111-1111-111111111111";
  const TOKEN = "tok_abc123";

  it("builds approve/cancel URLs matching the contract exactly", () => {
    const { approveUrl, cancelUrl } = buildApprovalLinks({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
    });

    expect(approveUrl).toBe(
      `${APP_URL}/approvals/${APPROVAL_ID}?token=${TOKEN}&action=approve`,
    );
    expect(cancelUrl).toBe(
      `${APP_URL}/approvals/${APPROVAL_ID}?token=${TOKEN}&action=cancel`,
    );
  });

  it("does not double the slash when appUrl has a trailing slash", () => {
    const { approveUrl } = buildApprovalLinks({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: "https://app.keeps.ai/",
    });
    expect(approveUrl).toBe(
      `https://app.keeps.ai/approvals/${APPROVAL_ID}?token=${TOKEN}&action=approve`,
    );
  });

  it("url-encodes a token with reserved characters", () => {
    const { approveUrl } = buildApprovalLinks({
      approvalId: APPROVAL_ID,
      token: "a+b/c=d&e",
      appUrl: APP_URL,
    });
    expect(approveUrl).toContain("token=a%2Bb%2Fc%3Dd%26e");
    // The only literal & in the URL is the action separator.
    expect(approveUrl.match(/&/g)?.length).toBe(1);
  });
});
