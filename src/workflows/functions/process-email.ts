import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import { DrizzleApprovalRepository } from "@/approvals/repository";
import { DrizzleDigestRepository } from "@/digests/repository";
import { getEmailSender } from "@/email/sender-factory";
import { DrizzleLoopProcessingRepository } from "@/loops/repository";
import { DrizzleReplyTargetStore } from "@/loops/resolve-reply-target";
import { DrizzleSendNudgeRepository, sendNudge } from "@/loops/send-nudge";
import type { AnswerQuestionPorts } from "@/workflows/functions/handlers/answer-question";
import type { ApprovalReplyAudit } from "@/workflows/functions/handlers/handle-approval-reply";
import { routeEmail } from "@/workflows/functions/route-email";
import { parseConnectorCommand } from "@/agent/parse-connector-command";
import { inngest } from "@/workflows/client";

/**
 * Question-branch ports (Deliverable #9): a digest user loader + the digest loop query +
 * the ordinal-map-preserving nudge writer (createPrivateReplyNudge persists metadata).
 */
function buildQuestionPorts(): AnswerQuestionPorts {
  const digestRepo = new DrizzleDigestRepository();
  const loopRepo = new DrizzleLoopProcessingRepository();

  return {
    async loadUser(userId) {
      const [row] = await getDb()
        .select({ id: users.id, email: users.email, displayName: users.displayName, timezone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row ? { id: row.id, email: row.email, displayName: row.displayName, timezone: row.timezone } : null;
    },
    findLoopsForDigest: (userId, now) => digestRepo.findLoopsForDigest(userId, now),
    createDigestReplyNudge: (input) => loopRepo.createPrivateReplyNudge(input),
  };
}

/**
 * Audit writer for the approval-reply edit path. The handler's logical action string
 * (e.g. "approval.edit_requested") is recorded under the existing `approval.decided`
 * enum value — no new enum value / migration needed — with the logical action and
 * approvalId carried in metadata.
 */
const approvalAudit: ApprovalReplyAudit = async (entry) => {
  await getDb().insert(auditLog).values({
    userId: entry.userId,
    action: "approval.decided",
    actorType: "user",
    metadata: { logicalAction: entry.action, approvalId: entry.approvalId, ...(entry.metadata ?? {}) },
  });
};

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
        approvalRepository: new DrizzleApprovalRepository(),
        approvalAudit,
        questionPorts: buildQuestionPorts(),
        // Phase 4 (D3): wire the real connector-command parser. The router's connector
        // branch now reaches the live parser instead of degrading to the polite stub.
        // useModel is threaded through by the router (deps.useModel) per the existing
        // convention, so the parser uses the model in production and the deterministic
        // regex in tests.
        parseConnectorCommand,
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
