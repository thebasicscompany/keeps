import { inngest } from "@/workflows/client";
import type { InboundWorkflowEvent } from "@/email/inbound";
import type { Phase2WorkflowEvent } from "@/loops/service";

export type KeepsWorkflowEvent = InboundWorkflowEvent | Phase2WorkflowEvent;

export async function sendWorkflowEvent(event: KeepsWorkflowEvent): Promise<void> {
  await inngest.send(event);
}
