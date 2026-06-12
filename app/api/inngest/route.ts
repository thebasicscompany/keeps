import { serve } from "inngest/next";
import { inngest } from "@/workflows/client";
import { workflowFunctions } from "@/workflows/functions/process-email";
import { alertOnFunctionFailure } from "@/workflows/functions/alert-on-failure";
import { pipelineCanary } from "@/workflows/functions/canary";
import { sendActivationEmailFunction } from "@/workflows/functions/send-activation-email";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...workflowFunctions, alertOnFunctionFailure, pipelineCanary, sendActivationEmailFunction],
});
