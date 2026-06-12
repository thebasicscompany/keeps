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
  ],
});
