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
import { processDataDeletionFunction } from "@/workflows/functions/process-data-deletion";
import { generateDataExportFunction } from "@/workflows/functions/generate-data-export";
import { sendExportEmailFunction } from "@/workflows/functions/send-export-email";
import { scoreNudgeFeedbackFunction } from "@/workflows/functions/score-nudge-feedback";
import { scoreDraftFeedbackFunction } from "@/workflows/functions/score-draft-feedback";
import { notifyConnectorFailureFunction } from "@/workflows/functions/notify-connector-failure";
import { sweepReconciliationMetricsFunction } from "@/workflows/functions/sweep-reconciliation-metrics";
import { sweepSuppressedTimeoutFunction } from "@/workflows/functions/sweep-suppressed-timeout";
import { sweepStaleLoopsFunction } from "@/workflows/functions/sweep-stale-loops";
import { handleAutomationTriggerFunction } from "@/workflows/functions/handle-automation-trigger";
import { handleAutomationRunFunction } from "@/workflows/functions/handle-automation-run";

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
    // Phase 6 B2: account-wide deletion (data.delete_requested → Clerk + cascade)
    processDataDeletionFunction,
    // Phase 6 B3: data export (data.export_requested → build JSON → email link)
    generateDataExportFunction,
    sendExportEmailFunction,
    // Phase 6 B5: daily quality-metric crons
    scoreNudgeFeedbackFunction,
    scoreDraftFeedbackFunction,
    // Phase 6 C3: connector failure alerting (connector.action_failed subscriber)
    notifyConnectorFailureFunction,
    // Phase V2 Wave A: reconciliation observability + suppressed-duplicate timeout promotion
    sweepReconciliationMetricsFunction,
    sweepSuppressedTimeoutFunction,
    // Org-visibility Wave 3: stale-loop sweep -> planner (automation.triggered -> plan) -> executor
    sweepStaleLoopsFunction,
    handleAutomationTriggerFunction,
    handleAutomationRunFunction,
  ],
});
