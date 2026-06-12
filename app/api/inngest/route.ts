import { serve } from "inngest/next";
import { inngest } from "@/workflows/client";
import { workflowFunctions } from "@/workflows/functions/process-email";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: workflowFunctions,
});
