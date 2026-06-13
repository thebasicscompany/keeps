import { serve } from "inngest/next";
import { inngest } from "@/workflows/client";
import { workflowFunctions } from "@/workflows/functions/process-email";
import { alertOnFunctionFailure } from "@/workflows/functions/alert-on-failure";
import { pipelineCanary } from "@/workflows/functions/canary";
import { sendActivationEmailFunction } from "@/workflows/functions/send-activation-email";
import { sweepNudgesFunction } from "@/workflows/functions/sweep-nudges";
import { sendNudgeFunction } from "@/workflows/functions/send-nudge";
import { sweepDigestsFunction } from "@/workflows/functions/sweep-digests";
import { sendDigestFunction } from "@/workflows/functions/send-digest";
import { handleApprovalFunction } from "@/workflows/functions/handle-approval";
import { sweepApprovalExpiryFunction } from "@/workflows/functions/sweep-approval-expiry";
import { hydrateConnectorAccountFunction } from "@/workflows/functions/hydrate-connector-account";
import { sweepConnectorStatusFunction } from "@/workflows/functions/sweep-connector-status";
import { handleConnectorCommandFunction } from "@/workflows/functions/handle-connector-command";
import { generateReportFunction } from "@/workflows/functions/generate-report";
import { rawEmailRetentionPurgeFunction } from "@/workflows/functions/raw-email-retention-purge";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ...workflowFunctions,
    alertOnFunctionFailure,
    pipelineCanary,
    sendActivationEmailFunction,
    // Phase 3: nudges, digests, approvals (auto-sync on deploy registers these)
    sweepNudgesFunction,
    sendNudgeFunction,
    sweepDigestsFunction,
    sendDigestFunction,
    handleApprovalFunction,
    sweepApprovalExpiryFunction,
    // Phase 4: connector account lifecycle (hydration + status sweep)
    hydrateConnectorAccountFunction,
    sweepConnectorStatusFunction,
    // Phase 4 D1: connector command → approval → execute-once
    handleConnectorCommandFunction,
    // Phase 5 C1: report.requested → generate report + private reply link
    generateReportFunction,
    // Phase 6 D10: raw-email retention scrub cron (daily 03:00 UTC)
    rawEmailRetentionPurgeFunction,
  ],
});
