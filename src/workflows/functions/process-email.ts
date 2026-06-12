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
        // Sends happen in their own step below. If they lived inside this step, a failed
        // send would retry the whole route, hit the idempotency guard (already_processed),
        // and silently skip the send forever — found live in the first real Postmark test.
        sendReply: async () => {},
        useModel: true,
      });
    });

    // Self-healing send: pick up every still-pending nudge for this inbound email
    // (covers fresh runs, retries, and reruns alike). `sendNudge` refuses to
    // double-send a nudge already marked `sent`.
    const pendingNudgeIds = await step.run("find-unsent-replies", async () => {
      return new DrizzleSendNudgeRepository().findPendingNudgeIds(payload.inboundEmailId);
    });

    for (const nudgeId of pendingNudgeIds) {
      await step.run(`send-private-reply-${nudgeId}`, async () => {
        return sendNudge({
          nudgeId,
          sender: getEmailSender(),
          repository: new DrizzleSendNudgeRepository(),
        });
      });
    }

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
