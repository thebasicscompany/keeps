import { DrizzleLoopProcessingRepository } from "@/loops/repository";
import { processInboundEmailForLoops } from "@/loops/service";
import { inngest } from "@/workflows/client";

export const processEmail = inngest.createFunction(
  { id: "process-email", triggers: { event: "email.received" } },
  async ({ event, step }) => {
    const payload = await step.run("validate-email-received-payload", async () => {
      const inboundEmailId = event.data.inboundEmailId as string | undefined;

      if (!inboundEmailId) {
        throw new Error("email.received is missing inboundEmailId.");
      }

      return {
        inboundEmailId,
        emailThreadId: event.data.emailThreadId as string | undefined,
        userId: event.data.userId as string | undefined,
        providerMessageId: event.data.providerMessageId as string | undefined,
      };
    });

    const result = await step.run("classify-extract-and-persist-loops", async () => {
      return processInboundEmailForLoops({
        inboundEmailId: payload.inboundEmailId,
        repository: new DrizzleLoopProcessingRepository(),
        useModel: true,
      });
    });

    for (const [index, phaseEvent] of result.events.entries()) {
      await step.sendEvent(`emit-${phaseEvent.name}-${index}`, phaseEvent);
    }

    return {
      ok: true,
      phase: 2,
      payload,
      result,
    };
  },
);

export const workflowFunctions = [processEmail];
