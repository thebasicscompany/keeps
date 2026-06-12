import { getOptionalEnv } from "@/config/env";
import { inngest } from "@/workflows/client";

const ALERT_FUNCTION_ID = "alert-on-pipeline-failure";

/** Where ops alerts go. Env-overridable so the pilot owner isn't hardcoded forever. */
export function getAlertRecipient(): string {
  return process.env.KEEPS_OPS_ALERT_EMAIL ?? "arav@basicsoftware.ai";
}

export type FunctionFailedData = {
  function_id?: string;
  run_id?: string;
  error?: { name?: string; message?: string; stack?: string };
  event?: { name?: string; data?: unknown };
};

/**
 * Formats the alert email body. Pure so it can be unit-tested without Inngest or
 * Postmark in the loop.
 */
export function formatFailureAlert(data: FunctionFailedData): { subject: string; textBody: string } {
  const functionId = data.function_id ?? "unknown-function";
  const message = data.error?.message ?? "no error message";
  const triggerName = data.event?.name ?? "unknown trigger";

  return {
    subject: `[keeps alert] ${functionId} failed`,
    textBody: [
      `Function: ${functionId}`,
      `Run: ${data.run_id ?? "unknown"}`,
      `Trigger: ${triggerName}`,
      "",
      `Error: ${message}`,
      "",
      "Trace: https://app.inngest.com (Runs -> filter by the run id above)",
      "Runbook: docs/phases/phase-2.6-auth-go-live.md § Go-live verification.",
    ].join("\n"),
  };
}

/**
 * Loud-failure rail: any failed function run (after its retries are exhausted) emails
 * the operator. Sends straight through the Postmark API rather than `EmailSender` —
 * that interface is nudge-coupled (`nudgeId`, outbound persistence), and an ops alert
 * must not depend on the very pipeline it reports on.
 *
 * Blind spot, accepted for v1: if Postmark itself is the failing component, the alert
 * cannot send either. An external dead-man's switch closes this later.
 */
export const alertOnFunctionFailure = inngest.createFunction(
  {
    id: ALERT_FUNCTION_ID,
    triggers: { event: "inngest/function.failed" },
    // A broken downstream dependency can fail many runs at once; don't email a storm.
    throttle: { limit: 6, period: "1h" },
    retries: 2,
  },
  async ({ event, step }) => {
    const data = event.data as FunctionFailedData;

    // Self-loop guard: never alert about the alerter.
    if (data.function_id?.includes(ALERT_FUNCTION_ID)) {
      return { skipped: "own failure" };
    }

    const sent = await step.run("send-alert-email", async () => {
      const env = getOptionalEnv();

      if (!env.POSTMARK_SERVER_TOKEN) {
        // Local dev: no live transport; the log line is the alert.
        console.error("[ops-alert]", formatFailureAlert(data).subject);
        return { delivered: false };
      }

      const { subject, textBody } = formatFailureAlert(data);
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
        },
        body: JSON.stringify({
          From: `Keeps Ops <${env.POSTMARK_FROM_ADDRESS}>`,
          To: getAlertRecipient(),
          Subject: subject,
          TextBody: textBody,
          MessageStream: env.POSTMARK_MESSAGE_STREAM,
        }),
      });

      if (!response.ok) {
        throw new Error(`Postmark alert send failed: ${response.status} ${await response.text()}`);
      }

      return { delivered: true };
    });

    return { ok: true, ...sent, failedFunction: data.function_id };
  },
);
