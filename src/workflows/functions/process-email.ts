import { DevRecordingSender } from "@/email/outbound";
import { DrizzleLoopProcessingRepository } from "@/loops/repository";
import { DrizzleSendNudgeRepository, sendNudge } from "@/loops/send-nudge";
import { processInboundEmailForLoops } from "@/loops/service";
import { inngest } from "@/workflows/client";

export const processEmail = inngest.createFunction(
  { id: "process-email", triggers: { event: "email.received" }, idempotency: "event.data.inboundEmailId" },
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

    if (result.status === "processed") {
      await step.run("send-private-reply", async () => {
        return sendNudge({
          nudgeId: result.nudgeId,
          sender: new DevRecordingSender(),
          repository: new DrizzleSendNudgeRepository(),
        });
      });
    }

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
