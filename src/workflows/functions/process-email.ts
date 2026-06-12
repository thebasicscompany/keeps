import { getEmailSender } from "@/email/sender-factory";
import { DrizzleLoopProcessingRepository } from "@/loops/repository";
import { DrizzleReplyTargetStore } from "@/loops/resolve-reply-target";
import { DrizzleSendNudgeRepository, sendNudge } from "@/loops/send-nudge";
import { routeEmail } from "@/workflows/functions/route-email";
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

    const result = await step.run("route-inbound-email", async () => {
      return routeEmail(payload.inboundEmailId, {
        repository: new DrizzleLoopProcessingRepository(),
        replyTargetStore: new DrizzleReplyTargetStore(),
        sendReply: async (nudgeId: string) => {
          await sendNudge({
            nudgeId,
            sender: getEmailSender(),
            repository: new DrizzleSendNudgeRepository(),
          });
        },
        useModel: true,
      });
    });

    for (const [index, workflowEvent] of result.events.entries()) {
      await step.sendEvent(`emit-${workflowEvent.name}-${index}`, workflowEvent);
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
