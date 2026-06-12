import { DrizzleApprovalRepository, type ApprovalRepository } from "@/approvals/repository";
import { decideApproval } from "@/approvals/service";
import { getEmailSender } from "@/email/sender-factory";
import { sendSystemEmail } from "@/email/system-send";
import { inngest } from "@/workflows/client";
import {
  DrizzleApprovalLifecycleAuditWriter,
  DrizzleOwnerEmailResolver,
  expiryNoticeLine,
  type ApprovalLifecycleAuditWriter,
  type EmitEvent,
  type OwnerEmailResolver,
} from "@/workflows/functions/handle-approval";

// ---------------------------------------------------------------------------
// Pure core: expire ONE past-due approval. Sends ONLY when decideApproval
// returns { status: 'decided' } (EXACTLY-ONCE EMAIL RULE).
// ---------------------------------------------------------------------------

export type SweepOneResult = "expired_and_notified" | "already_decided" | "not_found";

/**
 * The failsafe half of expiry (Deliverable #17), complementing handle-approval's
 * waitForEvent timeout. Both call decideApproval(decision:'expired'); the winner
 * gets 'decided' and sends the one-liner, the loser gets 'already_decided' and is
 * silent. decideApproval ALSO emits `approval.received { decision:'expired' }` on
 * the winning transition, which wakes any still-waiting handle-approval run — that
 * run audits and exits WITHOUT sending (the sweep already sent).
 */
export async function expireOneApproval(input: {
  approval: { id: string; userId: string; actionKind: string };
  repository: ApprovalRepository;
  ownerResolver: OwnerEmailResolver;
  audit: ApprovalLifecycleAuditWriter;
  sendSystemNotice: (notice: { to: string; subject: string; textBody: string }) => Promise<void>;
  /** Injectable for tests; defaults to the real Inngest emitter inside decideApproval. */
  emitEvent?: EmitEvent;
  now: Date;
}): Promise<SweepOneResult> {
  const decided = await decideApproval({
    approvalId: input.approval.id,
    decision: "expired",
    channel: "cron",
    now: input.now,
    repository: input.repository,
    emitEvent: input.emitEvent,
  });

  if (decided.status === "not_found") {
    return "not_found";
  }

  if (decided.status !== "decided") {
    // Lost the race to the waitForEvent timeout (or a prior sweep run). Stay silent.
    return "already_decided";
  }

  const ownerEmail = await input.ownerResolver.findOwnerEmail(decided.request.userId);
  if (ownerEmail) {
    await input.sendSystemNotice({
      to: ownerEmail,
      subject: "Your Keeps approval expired",
      textBody: expiryNoticeLine(decided.request.actionKind),
    });
  }

  await input.audit.writeAudit({
    action: "approval.expired",
    userId: decided.request.userId,
    metadata: { approvalId: input.approval.id, channel: "sweep" },
  });

  return "expired_and_notified";
}

// ---------------------------------------------------------------------------
// Pure core: sweep ALL past-due approvals at `now`. Returns counts.
// ---------------------------------------------------------------------------

export type SweepResult = {
  scanned: number;
  expired: number;
  alreadyDecided: number;
};

/**
 * Finds every pending approval whose expires_at <= now and expires each. `now` MUST
 * be minted once inside the first step and threaded through so the scan and every
 * decideApproval call share the same instant (Inngest determinism).
 */
export async function sweepApprovalExpiry(input: {
  repository: ApprovalRepository;
  ownerResolver: OwnerEmailResolver;
  audit: ApprovalLifecycleAuditWriter;
  sendSystemNotice: (notice: { to: string; subject: string; textBody: string }) => Promise<void>;
  emitEvent?: EmitEvent;
  now: Date;
}): Promise<SweepResult> {
  const due = await input.repository.findPendingExpired(input.now);

  let expired = 0;
  let alreadyDecided = 0;

  for (const row of due) {
    const result = await expireOneApproval({
      approval: { id: row.id, userId: row.userId, actionKind: row.actionKind },
      repository: input.repository,
      ownerResolver: input.ownerResolver,
      audit: input.audit,
      sendSystemNotice: input.sendSystemNotice,
      emitEvent: input.emitEvent,
      now: input.now,
    });
    if (result === "expired_and_notified") {
      expired += 1;
    } else if (result === "already_decided") {
      alreadyDecided += 1;
    }
  }

  return { scanned: due.length, expired, alreadyDecided };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — cron every 15 minutes. `now` minted once in step 1.
// ---------------------------------------------------------------------------

export const sweepApprovalExpiryFunction = inngest.createFunction(
  { id: "sweep-approval-expiry", triggers: { cron: "*/15 * * * *" } },
  async ({ step }) => {
    // Mint `now` once and read it back from the memoized return, then scan. Each
    // expiry below is its own send-only step with a keyed name so re-execution
    // never re-sends a notice that already went out.
    const due = await step.run("scan-expired", async () => {
      const now = new Date();
      const rows = await new DrizzleApprovalRepository().findPendingExpired(now);
      return {
        nowIso: now.toISOString(),
        approvals: rows.map((r) => ({ id: r.id, userId: r.userId, actionKind: r.actionKind })),
      };
    });

    const now = new Date(due.nowIso);
    let expired = 0;
    let alreadyDecided = 0;

    for (const approval of due.approvals) {
      const result = await step.run(`expire-${approval.id}`, async () => {
        return expireOneApproval({
          approval,
          repository: new DrizzleApprovalRepository(),
          ownerResolver: new DrizzleOwnerEmailResolver(),
          audit: new DrizzleApprovalLifecycleAuditWriter(),
          sendSystemNotice: async (notice) => {
            await sendSystemEmail({ email: notice, sender: getEmailSender() });
          },
          now,
        });
      });
      if (result === "expired_and_notified") {
        expired += 1;
      } else if (result === "already_decided") {
        alreadyDecided += 1;
      }
    }

    console.log(
      `[sweep-approval-expiry] scanned=${due.approvals.length} expired=${expired} alreadyDecided=${alreadyDecided}`,
    );

    return { ok: true, scanned: due.approvals.length, expired, alreadyDecided };
  },
);
