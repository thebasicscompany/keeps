import { describe, expect, it } from "vitest";
import { buildApprovalLinks } from "@/approvals/links";
import { buildConnectorMissingEmail } from "./connector-missing";
import { buildConnectorAmbiguousEmail } from "./connector-ambiguous";
import { buildConnectorApprovalEmail } from "./connector-approval";
import { buildConnectorReconnectEmail } from "./connector-reconnect";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const APP_URL = "https://app.keeps.ai";
const APPROVAL_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN = "tok_test123";
const CONNECT_URL = "https://app.keeps.ai/settings/connectors";
const RECONNECT_URL = "https://app.keeps.ai/settings/connectors?reconnect=slack";

// ---------------------------------------------------------------------------
// buildConnectorMissingEmail
// ---------------------------------------------------------------------------

describe("buildConnectorMissingEmail", () => {
  it("renders Slack label correctly", () => {
    const { subject, textBody } = buildConnectorMissingEmail({
      provider: "slack",
      commandSummary: "send a message to Maya",
      connectUrl: CONNECT_URL,
    });

    expect(subject).toBe("Connect your Slack");
    expect(textBody).toContain("Slack");
    expect(textBody).not.toContain("Google Calendar");
  });

  it("renders Google Calendar label correctly", () => {
    const { subject, textBody } = buildConnectorMissingEmail({
      provider: "google_calendar",
      commandSummary: "add a calendar event",
      connectUrl: CONNECT_URL,
    });

    expect(subject).toBe("Connect your Google Calendar");
    expect(textBody).toContain("Google Calendar");
    expect(textBody).not.toContain("Slack");
  });

  it("includes the command summary in the body", () => {
    const { textBody } = buildConnectorMissingEmail({
      provider: "slack",
      commandSummary: "tell Maya I'll send the deck Friday",
      connectUrl: CONNECT_URL,
    });

    expect(textBody).toContain("tell Maya I'll send the deck Friday");
  });

  it("includes the connectUrl exactly once", () => {
    const { textBody } = buildConnectorMissingEmail({
      provider: "slack",
      commandSummary: "ping Alex",
      connectUrl: CONNECT_URL,
    });

    expect(textBody).toContain(CONNECT_URL);
    expect(textBody.split(CONNECT_URL).length - 1).toBe(1);
  });

  it("is deterministic — same input same output", () => {
    const input = { provider: "slack" as const, commandSummary: "ping Alex", connectUrl: CONNECT_URL };
    expect(buildConnectorMissingEmail(input)).toEqual(buildConnectorMissingEmail(input));
  });
});

// ---------------------------------------------------------------------------
// buildConnectorAmbiguousEmail
// ---------------------------------------------------------------------------

describe("buildConnectorAmbiguousEmail", () => {
  const candidates = [
    { name: "Maya Goldberg", email: "maya@example.com" },
    { name: "Maya Patel", email: null },
  ];

  it("counts candidates correctly", () => {
    const { textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: "Maya",
      candidates,
      commandSummary: "tell Maya I'll send the deck Friday",
    });

    expect(textBody).toContain("2 people");
  });

  it("lists candidates with 1-based ordinals", () => {
    const { textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: "Maya",
      candidates,
      commandSummary: "ping Maya",
    });

    expect(textBody).toContain("1. Maya Goldberg");
    expect(textBody).toContain("2. Maya Patel");
  });

  it("includes email when present, omits when null", () => {
    const { textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: "Maya",
      candidates,
      commandSummary: "ping Maya",
    });

    expect(textBody).toContain("maya@example.com");
    // Maya Patel has no email — should not have a dangling "(null)" or "()"
    const patelLine = textBody.split("\n").find((l) => l.includes("Maya Patel"));
    expect(patelLine).toBeDefined();
    expect(patelLine).not.toContain("null");
    expect(patelLine).not.toContain("(undefined");
    expect(patelLine).not.toContain("()");
  });

  it("includes the command summary", () => {
    const { textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: "Alex",
      candidates: [{ name: "Alex A", email: "a@x.com" }, { name: "Alex B", email: "b@x.com" }],
      commandSummary: "schedule a sync with Alex",
    });

    expect(textBody).toContain("schedule a sync with Alex");
  });

  it("tells user how to reply", () => {
    const { textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: "Maya",
      candidates,
      commandSummary: "ping Maya",
    });

    expect(textBody.toLowerCase()).toContain("reply");
  });

  it("uses singular 'person' for exactly one candidate", () => {
    const { textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: "Jordan",
      candidates: [{ name: "Jordan Smith", email: "j@x.com" }],
      commandSummary: "ping Jordan",
    });

    expect(textBody).toContain("1 person");
    expect(textBody).not.toContain("1 people");
  });
});

// ---------------------------------------------------------------------------
// buildConnectorApprovalEmail — slack_dm
// ---------------------------------------------------------------------------

describe("buildConnectorApprovalEmail (slack_dm)", () => {
  const slackAction = {
    kind: "slack_dm" as const,
    recipientName: "Maya",
    recipientSlackHandleOrEmail: "maya@example.com",
    message: "I'll send the deck Friday.",
  };

  const { approveUrl, cancelUrl } = buildApprovalLinks({
    approvalId: APPROVAL_ID,
    token: TOKEN,
    appUrl: APP_URL,
  });

  it("builds subject with recipient name", () => {
    const { subject } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });

    expect(subject).toBe("Approval needed: Slack message to Maya");
  });

  it("renders an HTML part with Approve (primary) and Deny (secondary) BUTTONS, token only in hrefs", () => {
    const { html } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });
    // Both buttons present, each an anchor styled as a square button.
    expect(html).toContain("Approve &amp; send");
    expect(html).toContain("Deny");
    // Hrefs are HTML-escaped in the attribute (& → &amp;) — correct for HTML.
    expect(html).toContain(`href="${approveUrl.replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`href="${cancelUrl.replace(/&/g, "&amp;")}"`);
    // Primary = seafoam fill; secondary = paper outline.
    expect(html).toContain("background-color:#C1F5DF");
    expect(html).toContain("background-color:#FAFAF8");
    // Rule 7: the plaintext token appears ONLY inside the button hrefs, nowhere else.
    const withoutHrefs = html.replace(new RegExp(`href="[^"]*"`, "g"), 'href="#"');
    expect(withoutHrefs).not.toContain(TOKEN);
  });

  it("embeds approveUrl and cancelUrl exactly as buildApprovalLinks produces", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });

    expect(textBody).toContain(approveUrl);
    expect(textBody).toContain(cancelUrl);
  });

  it("shows the recipient and their email", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });

    expect(textBody).toContain("Maya");
    expect(textBody).toContain("maya@example.com");
  });

  it("shows the verbatim message in an indented block", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });

    // Message must appear with leading spaces (indented)
    expect(textBody).toContain("    I'll send the deck Friday.");
  });

  it("includes reply-command footer", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });

    expect(textBody).toContain("reply  approve");
    expect(textBody).toContain("reply  reject");
    expect(textBody).toContain("edit: <changes>");
  });

  it("token appears ONLY inside URLs, never echoed separately", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: slackAction,
    });

    // Remove both URLs from the body — the raw token must not remain.
    const stripped = textBody.replace(approveUrl, "").replace(cancelUrl, "");
    expect(stripped).not.toContain(TOKEN);
  });

  it("handles null recipientSlackHandleOrEmail gracefully", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: { ...slackAction, recipientSlackHandleOrEmail: null },
    });

    expect(textBody).toContain("To: Maya");
    expect(textBody).not.toContain("null");
    expect(textBody).not.toContain("undefined");
  });

  it("is deterministic", () => {
    const input = { approvalId: APPROVAL_ID, token: TOKEN, appUrl: APP_URL, action: slackAction };
    expect(buildConnectorApprovalEmail(input)).toEqual(buildConnectorApprovalEmail(input));
  });
});

// ---------------------------------------------------------------------------
// buildConnectorApprovalEmail — calendar_event
// ---------------------------------------------------------------------------

describe("buildConnectorApprovalEmail (calendar_event)", () => {
  const calendarAction = {
    kind: "calendar_event" as const,
    title: "Renewal call prep",
    whenLocal: "Monday June 16 at 2:00 PM",
    durationMinutes: 30,
  };

  const { cancelUrl } = buildApprovalLinks({
    approvalId: APPROVAL_ID,
    token: TOKEN,
    appUrl: APP_URL,
  });

  it("builds a subject with the event title", () => {
    const { subject } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    expect(subject).toContain("Renewal call prep");
    expect(subject).toContain("Confirm");
  });

  it("uses confirmation-window wording (15 minutes)", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    expect(textBody).toContain("15 minutes");
    expect(textBody).toContain("cancel");
  });

  it("embeds the cancelUrl from buildApprovalLinks", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    expect(textBody).toContain(cancelUrl);
  });

  it("shows the event title and whenLocal", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    expect(textBody).toContain("Renewal call prep");
    expect(textBody).toContain("Monday June 16 at 2:00 PM");
  });

  it("shows duration when present", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    expect(textBody).toContain("30 minutes");
  });

  it("omits duration line when durationMinutes is null", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: { ...calendarAction, durationMinutes: null },
    });

    // The "15 minutes" comes from the confirmation-window sentence.
    // The duration line must not appear.
    expect(textBody).not.toContain("Duration:");
  });

  it("token appears ONLY inside URLs, never echoed separately", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    const stripped = textBody.replace(cancelUrl, "");
    expect(stripped).not.toContain(TOKEN);
  });

  it("includes reply footer for cancel and edit", () => {
    const { textBody } = buildConnectorApprovalEmail({
      approvalId: APPROVAL_ID,
      token: TOKEN,
      appUrl: APP_URL,
      action: calendarAction,
    });

    expect(textBody).toContain("reply  cancel");
    expect(textBody).toContain("edit: <changes>");
  });

  it("is deterministic", () => {
    const input = { approvalId: APPROVAL_ID, token: TOKEN, appUrl: APP_URL, action: calendarAction };
    expect(buildConnectorApprovalEmail(input)).toEqual(buildConnectorApprovalEmail(input));
  });
});

// ---------------------------------------------------------------------------
// buildConnectorReconnectEmail
// ---------------------------------------------------------------------------

describe("buildConnectorReconnectEmail", () => {
  it("renders Slack label in subject", () => {
    const { subject } = buildConnectorReconnectEmail({
      provider: "slack",
      reason: null,
      reconnectUrl: RECONNECT_URL,
    });

    expect(subject).toBe("Reconnect your Slack");
  });

  it("renders Google Calendar label in subject", () => {
    const { subject } = buildConnectorReconnectEmail({
      provider: "google_calendar",
      reason: null,
      reconnectUrl: RECONNECT_URL,
    });

    expect(subject).toBe("Reconnect your Google Calendar");
  });

  it("includes the reason when provided", () => {
    const { textBody } = buildConnectorReconnectEmail({
      provider: "slack",
      reason: "token expired",
      reconnectUrl: RECONNECT_URL,
    });

    expect(textBody).toContain("token expired");
  });

  it("omits reason clause when reason is null", () => {
    const { textBody } = buildConnectorReconnectEmail({
      provider: "slack",
      reason: null,
      reconnectUrl: RECONNECT_URL,
    });

    expect(textBody).not.toContain("null");
    expect(textBody).not.toContain("()");
    expect(textBody).not.toContain("undefined");
  });

  it("includes the reconnectUrl", () => {
    const { textBody } = buildConnectorReconnectEmail({
      provider: "google_calendar",
      reason: "refresh_error",
      reconnectUrl: RECONNECT_URL,
    });

    expect(textBody).toContain(RECONNECT_URL);
  });

  it("is deterministic", () => {
    const input = { provider: "slack" as const, reason: "token expired", reconnectUrl: RECONNECT_URL };
    expect(buildConnectorReconnectEmail(input)).toEqual(buildConnectorReconnectEmail(input));
  });
});
