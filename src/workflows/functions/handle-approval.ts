import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getEnv, getOptionalEnv } from "@/config/env";
import { getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import type { ApprovalRequest, Draft } from "@/db/schema";
import { buildApprovalLinks } from "@/approvals/links";
import { renderButtonEmailHtml } from "@/email/button-html";
import {
  DrizzleApprovalRepository,
  type ApprovalRepository,
  type ApprovalRequestWithDraft,
} from "@/approvals/repository";
import { decideApproval, rotateApprovalToken } from "@/approvals/service";
import type { EventMap } from "@/workflows/events";
import {
  DrizzleApprovalAuditWriter,
  DrizzleApprovalDraftLoader,
  executeApprovedDraft,
  type ApprovalDraftLoader,
  type ApprovalErrorEmailSender,
  type ExecuteApprovedDraftResult,
} from "@/approvals/execute";
import {
  buildNudgeReplyTo,
  DrizzleOutboundEmailStore,
  parseNudgeMailboxHash,
  type EmailSender,
  type OutboundEmail,
  type OutboundEmailStore,
} from "@/email/outbound";
import { getEmailSender } from "@/email/sender-factory";
import { sendSystemEmail } from "@/email/system-send";
import { DrizzleNudgeRepository, type NudgeRepository } from "@/nudges/repository";
import { inngest } from "@/workflows/client";

// ---------------------------------------------------------------------------
// Ports — pure interfaces so tests inject in-memory fakes (no live DB/Inngest).
// ---------------------------------------------------------------------------

/** Resolves the OWNER's canonical email — the only address an approval email may reach. */
export interface OwnerEmailResolver {
  findOwnerEmail(userId: string): Promise<string | null>;
}

/**
 * Event emitter port — defaults to the real typed sendEvent in production. Tests inject
 * an in-memory fake so decideApproval's `approval.received` emission never hits Inngest.
 */
export type EmitEvent = <K extends keyof EventMap>(name: K, data: EventMap[K]) => Promise<void>;

/**
 * Audit writer for the approval.* lifecycle actions THIS workflow owns
 * (`approval.requested`, `approval.decided`, `approval.expired`). The
 * `approval.executed` / `approval.execution_failed` rows are written by
 * `executeApprovedDraft` itself — never here.
 *
 * SECURITY: metadata MUST NOT carry a plaintext token (rule 7).
 */
export interface ApprovalLifecycleAuditWriter {
  writeAudit(input: {
    action: "approval.requested" | "approval.decided" | "approval.expired";
    userId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers — email body composition (no I/O, fully unit-testable)
// ---------------------------------------------------------------------------

/** One-line, deterministic summary of what an approved draft will do. */
export function summarizeDraftPayload(draft: Pick<Draft, "actionKind" | "payload">): string {
  const payload = draft.payload as Record<string, unknown> | null | undefined;
  if (!payload || Object.keys(payload).length === 0) {
    return `Action: ${draft.actionKind} (no parameters).`;
  }
  // Stable key order so the body is deterministic across Inngest re-executions.
  const parts = Object.keys(payload)
    .sort()
    .map((key) => `${key}: ${formatValue(payload[key])}`);
  return `Action: ${draft.actionKind}\n  ${parts.join("\n  ")}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Builds the subject, text body, and HTML part of the approval nudge email.
 *
 * The plaintext token reaches the user ONLY through the approve/cancel URLs
 * embedded in this body — it is the user's own one-time link. It never appears
 * in nudge metadata, events, audit rows, or logs.
 *
 * SECURITY: `html` carries the same token URLs as `textBody`. Both are returned
 * together and must flow only through the in-memory send path. The caller is
 * responsible for keeping them out of logs and DB columns other than the outbound
 * email record (where textBody already lives).
 */
export function buildApprovalEmail(input: {
  approvalId: string;
  draft: Pick<Draft, "actionKind" | "payload">;
  token: string;
  appUrl: string;
}): { subject: string; textBody: string; html: string } {
  const { approveUrl, cancelUrl } = buildApprovalLinks({
    approvalId: input.approvalId,
    token: input.token,
    appUrl: input.appUrl,
  });

  const subject = `Approval needed: ${input.draft.actionKind}`;

  const textBody = [
    "Keeps needs your approval before running this:",
    "",
    summarizeDraftPayload(input.draft),
    "",
    `Approve: ${approveUrl}`,
    `Cancel:  ${cancelUrl}`,
    "",
    "Or just reply to this email:",
    "  reply  approve            — run it",
    "  reply  reject             — don't run it",
    "  reply  edit: <changes>    — tell me what to change",
  ].join("\n");

  const html = renderButtonEmailHtml({
    paragraphs: [
      "Keeps needs your approval before running this:",
      summarizeDraftPayload(input.draft),
    ],
    button: { label: "Approve", url: approveUrl },
    textLinks: [
      { label: "Cancel", url: cancelUrl },
    ],
    footnote:
      "Or reply to this email: “approve” to run it, “reject” to cancel, or “edit: …” to change it.",
  });

  return { subject, textBody, html };
}

/** The one-line system notice for each terminal decision. */
export function decisionConfirmationLine(
  decision: "approved" | "rejected" | "cancelled",
  executed?: ExecuteApprovedDraftResult["status"],
): string {
  if (decision === "rejected") {
    return "Got it — I won't run that.";
  }
  if (decision === "cancelled") {
    return "Cancelled — that action won't run.";
  }
  // approved
  switch (executed) {
    case "executed":
      return "Approved — done.";
    case "unknown_action":
      return "Approved, but I don't know how to run that action yet. Nothing ran.";
    case "denied":
      return "Approved, but the action was blocked by policy. Nothing ran.";
    case "not_found":
      return "Approved, but I couldn't find the action to run.";
    default:
      return "Approved.";
  }
}

export function expiryNoticeLine(actionKind: string): string {
  return `Your pending approval for "${actionKind}" expired without a decision, so nothing ran.`;
}

// ---------------------------------------------------------------------------
// Drizzle-backed default ports
// ---------------------------------------------------------------------------

export class DrizzleOwnerEmailResolver implements OwnerEmailResolver {
  private readonly db = getDb();
  async findOwnerEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.email ?? null;
  }
}

export class DrizzleApprovalLifecycleAuditWriter implements ApprovalLifecycleAuditWriter {
  private readonly db = getDb();
  async writeAudit(input: {
    action: "approval.requested" | "approval.decided" | "approval.expired";
    userId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(auditLog).values({
      id: randomUUID(),
      userId: input.userId,
      action: input.action,
      actorType: "system",
      metadata: input.metadata,
    });
  }
}

// ---------------------------------------------------------------------------
// Pure core: prepare the approval (rotate token, create nudge) — NO send.
// ---------------------------------------------------------------------------

export type PrepareApprovalResult =
  | { status: "not_pending" }
  | {
      status: "prepared";
      nudgeId: string;
      ownerEmail: string;
      subject: string;
      textBody: string;
      /**
       * HTML part carrying the same approve/cancel token URLs as textBody. Exposure surface
       * is identical to textBody — both live in the memoized prepare-approval step return and
       * flow only to the send step. Never written to nudge metadata, audit logs, or any DB
       * column other than the outbound email record (where textBody already lives).
       */
      html: string;
    };

/**
 * Loads the approval, re-mints the plaintext token (rotateApprovalToken), composes
 * the email body with the approve/cancel links, and persists the approval nudge.
 *
 * AR-3: the nudge metadata is EXACTLY `{ approvalId }` — no token. The rotated
 * plaintext token lives only in `textBody` (the user's own link) which the caller
 * hands to a SEND-ONLY step.
 *
 * `now` and the rotation happen via the injected repository; the caller mints `now`
 * inside its step. Returns `not_pending` (early-exit) if the approval is missing or
 * already decided.
 */
export async function prepareApproval(input: {
  approvalId: string;
  repository: ApprovalRepository;
  ownerResolver: OwnerEmailResolver;
  nudges: NudgeRepository;
  appUrl: string;
}): Promise<PrepareApprovalResult> {
  const { approvalId, repository, ownerResolver, nudges, appUrl } = input;

  const approval = await repository.findApprovalById(approvalId);
  if (!approval || approval.status !== "pending") {
    return { status: "not_pending" };
  }

  const ownerEmail = await ownerResolver.findOwnerEmail(approval.userId);
  if (!ownerEmail) {
    return { status: "not_pending" };
  }

  // Re-mint: the original plaintext token from createApprovalRequest never reached
  // this workflow (it is not in the event — rule 7). We mint a fresh one and
  // supersede the stored hash. Returns null if the row stopped being pending.
  const rotated = await rotateApprovalToken({ approvalId, repository });
  if (!rotated) {
    return { status: "not_pending" };
  }

  const { subject, textBody, html } = buildApprovalEmail({
    approvalId,
    draft: approval.draft,
    token: rotated.token,
    appUrl,
  });

  // AR-3: metadata carries ONLY { approvalId }. The token is NOT here — it lives
  // solely in textBody (the user's email link). html is NOT stored in the nudge row
  // either — outbound_emails has no html column and the nudge body stays plain-text.
  const nudge = await nudges.createNudgeRow({
    userId: approval.userId,
    loopId: approval.draft.sourceLoopId ?? null,
    inboundEmailId: null,
    subject,
    body: textBody,
    type: "approval",
    metadata: { approvalId },
  });

  return {
    status: "prepared",
    nudgeId: nudge.id,
    ownerEmail,
    subject,
    textBody,
    html,
  };
}

// ---------------------------------------------------------------------------
// Pure core: SEND-ONLY the approval email. NO DB writes.
// ---------------------------------------------------------------------------

/**
 * Sends the prepared approval email to the owner with a plus-routed Reply-To so a
 * plaintext reply ("approve" / "reject" / "edit: ...") routes back to the nudge.
 * Performs NO DB writes — bookkeeping lives in the following record step so a
 * Postmark-accepted send followed by a DB failure never double-sends on retry.
 */
export async function sendApprovalEmailOnly(input: {
  nudgeId: string;
  ownerEmail: string;
  subject: string;
  textBody: string;
  /**
   * Optional HTML part. Exposure surface is identical to textBody — both come from the
   * memoized prepare-approval step and flow only through this send-only step (no DB writes).
   */
  html?: string;
  sender: EmailSender;
  replyToBase: string;
}): Promise<{ providerMessageId: string; outbound: OutboundEmail }> {
  const replyTo = buildNudgeReplyTo(input.nudgeId, input.replyToBase);
  const outbound: OutboundEmail = {
    userId: null,
    nudgeId: input.nudgeId,
    to: input.ownerEmail,
    subject: input.subject,
    textBody: input.textBody,
    ...(input.html !== undefined ? { htmlBody: input.html } : {}),
    replyTo,
    mailboxHash: `n_${input.nudgeId}`,
    // Reply-To travels as a top-level field; Postmark rejects it inside Headers (error 300).
    headers: {},
  };

  const result = await input.sender.send(outbound);
  return { providerMessageId: result.providerMessageId, outbound };
}

// ---------------------------------------------------------------------------
// Pure core: record the approval send (outbound row + mark sent + audit).
// ---------------------------------------------------------------------------

/**
 * Persists the outbound row, flips the nudge to `sent`, and writes the
 * `approval.requested` audit. Isolated from the send so a retry here never
 * re-sends. The audit metadata carries `{ approvalId, inngestRunId }` — never a token.
 *
 * (createApprovalRequest does NOT write an audit row, so the canonical
 * approval.requested audit is written here, at the point the request is surfaced.)
 */
export async function recordApprovalEmailSent(input: {
  approvalId: string;
  userId: string;
  nudgeId: string;
  providerMessageId: string;
  outbound: OutboundEmail;
  provider: string;
  store: OutboundEmailStore;
  audit: ApprovalLifecycleAuditWriter;
  inngestRunId: string;
  now: Date;
}): Promise<void> {
  await input.store.recordSend({
    id: randomUUID(),
    // The approval email is a user-owned nudge send — attribute the outbound row to
    // the owner (unlike system sends, which have no user row and record null).
    userId: input.userId,
    nudgeId: input.nudgeId,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    toEmail: input.outbound.to,
    subject: input.outbound.subject,
    textBody: input.outbound.textBody,
    headers: input.outbound.headers ?? {},
    replyTo: input.outbound.replyTo ?? null,
    inReplyTo: input.outbound.inReplyTo ?? null,
    referencesHeader: input.outbound.references ?? null,
    mailboxHash: input.outbound.mailboxHash ?? parseNudgeMailboxHash(input.outbound.replyTo),
  });

  await input.store.markNudgeSent({ nudgeId: input.nudgeId, sentAt: input.now });

  await input.audit.writeAudit({
    action: "approval.requested",
    userId: input.userId,
    metadata: { approvalId: input.approvalId, inngestRunId: input.inngestRunId },
  });
}

// ---------------------------------------------------------------------------
// Pure core: the timeout branch — expire via decideApproval, send ONLY on 'decided'.
// ---------------------------------------------------------------------------

export type ExpireTimeoutResult =
  | { status: "expired_and_notified"; ownerEmail: string | null }
  | { status: "already_decided" }
  | { status: "not_found" };

/**
 * EXACTLY-ONCE EMAIL RULE: both this timeout branch and the sweep call
 * decideApproval(decision:'expired'). Whichever transitions the row gets
 * { status: 'decided' } and sends the one-liner; the loser gets 'already_decided'
 * and MUST NOT send. This core sends ONLY on 'decided'.
 */
export async function expireOnTimeout(input: {
  approvalId: string;
  repository: ApprovalRepository;
  ownerResolver: OwnerEmailResolver;
  audit: ApprovalLifecycleAuditWriter;
  sendSystemNotice: (notice: { to: string; subject: string; textBody: string }) => Promise<void>;
  /** Injectable for tests; defaults to the real Inngest emitter inside decideApproval. */
  emitEvent?: EmitEvent;
  now: Date;
}): Promise<ExpireTimeoutResult> {
  const decided = await decideApproval({
    approvalId: input.approvalId,
    decision: "expired",
    channel: "cron",
    now: input.now,
    repository: input.repository,
    emitEvent: input.emitEvent,
  });

  if (decided.status === "not_found") {
    return { status: "not_found" };
  }

  if (decided.status !== "decided") {
    // Sweep (or anything else) won the race — it already sent. Audit nothing here;
    // the winner owns the approval.expired audit + email.
    return { status: "already_decided" };
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
    metadata: { approvalId: input.approvalId, channel: "timeout" },
  });

  return { status: "expired_and_notified", ownerEmail };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding of Drizzle ports to the pure cores.
// ---------------------------------------------------------------------------

/** Override for tests / shorter timeouts; defaults to the 7-day approval window. */
const APPROVAL_TIMEOUT = process.env.APPROVAL_TIMEOUT_OVERRIDE ?? "7d";

export const handleApprovalFunction = inngest.createFunction(
  {
    id: "handle-approval",
    triggers: { event: "approval.requested" },
    idempotency: "event.data.approvalId",
  },
  async ({ event, step, runId }) => {
    const approvalId = event.data.approvalId as string;

    // ── Prepare: load + rotate token + create nudge. `now` is not needed here;
    // the rotation/load happen against the live row. Token rotation lives inside
    // this step so its memoized return (the prepared body) is stable on re-execution.
    const prepared = await step.run("prepare-approval", async () => {
      const env = getEnv();
      return prepareApproval({
        approvalId,
        repository: new DrizzleApprovalRepository(),
        ownerResolver: new DrizzleOwnerEmailResolver(),
        nudges: new DrizzleNudgeRepository(),
        appUrl: env.NEXT_PUBLIC_APP_URL,
      });
    });

    if (prepared.status !== "prepared") {
      return { ok: true, status: prepared.status };
    }

    // ── Send-only: Postmark call, NO DB writes.
    // `prepared.html` carries token URLs — identical exposure surface as `prepared.textBody`.
    // Both come from the memoized prepare-approval step and never leave this send step.
    const sent = await step.run("send-approval-email", async () => {
      const env = getOptionalEnv();
      return sendApprovalEmailOnly({
        nudgeId: prepared.nudgeId,
        ownerEmail: prepared.ownerEmail,
        subject: prepared.subject,
        textBody: prepared.textBody,
        html: prepared.html,
        sender: getEmailSender(),
        replyToBase: env.POSTMARK_REPLY_TO_BASE,
      });
    });

    // ── Record: outbound row + mark sent + approval.requested audit.
    await step.run("record-approval-email", async () => {
      const now = new Date();
      await recordApprovalEmailSent({
        approvalId,
        userId: event.data.userId as string,
        nudgeId: prepared.nudgeId,
        providerMessageId: sent.providerMessageId,
        outbound: sent.outbound,
        provider: getEmailSender().provider,
        store: new DrizzleOutboundEmailStore(),
        audit: new DrizzleApprovalLifecycleAuditWriter(),
        inngestRunId: runId,
        now,
      });
    });

    // ── Wait for the decision. AR-5: waitForEvent (never sleepUntil).
    const decided = await step.waitForEvent("wait-approval-decision", {
      event: "approval.received",
      match: "data.approvalId",
      timeout: APPROVAL_TIMEOUT,
    });

    // ── Timeout: expire. Sends the one-liner ONLY when decideApproval transitions.
    if (decided === null) {
      const result = await step.run("expire", async () => {
        const now = new Date();
        return expireOnTimeout({
          approvalId,
          repository: new DrizzleApprovalRepository(),
          ownerResolver: new DrizzleOwnerEmailResolver(),
          audit: new DrizzleApprovalLifecycleAuditWriter(),
          // The send-only notice lives inside this same expire result so the
          // 'decided'-gated send and the audit are one atomic memoized unit.
          sendSystemNotice: async (notice) => {
            await sendSystemEmail({
              email: notice,
              sender: getEmailSender(),
            });
          },
          now,
        });
      });
      return { ok: true, branch: "timeout", ...result };
    }

    const decision = decided.data.decision as
      | "approved"
      | "rejected"
      | "cancelled"
      | "expired";

    // ── Expired via the sweep's event: the sweep already sent. Audit-only, NO email.
    if (decision === "expired") {
      await step.run("audit-expired-by-sweep", async () => {
        await new DrizzleApprovalLifecycleAuditWriter().writeAudit({
          action: "approval.expired",
          userId: event.data.userId as string,
          metadata: { approvalId, channel: "sweep" },
        });
      });
      return { ok: true, branch: "expired_by_sweep" };
    }

    // ── Approved: run through the execute funnel, then confirm.
    if (decision === "approved") {
      const executed = await step.run("execute", async () => {
        const now = new Date();
        const loader: ApprovalDraftLoader = new DrizzleApprovalDraftLoader();
        const sendErrorEmail: ApprovalErrorEmailSender = async ({ approval }) => {
          const ownerEmail = await new DrizzleOwnerEmailResolver().findOwnerEmail(
            approval.userId,
          );
          if (ownerEmail) {
            await sendSystemEmail({
              email: {
                to: ownerEmail,
                subject: "Keeps couldn't run your approved action",
                textBody:
                  "You approved an action, but I don't know how to run it yet. Nothing ran.",
              },
              sender: getEmailSender(),
            });
          }
        };
        return executeApprovedDraft(approvalId, {
          loader,
          audit: new DrizzleApprovalAuditWriter(),
          sendErrorEmail,
          now,
        });
      });

      // Confirmation one-liner — send-only step.
      await step.run("confirm-approved", async () => {
        const ownerEmail = await new DrizzleOwnerEmailResolver().findOwnerEmail(
          event.data.userId as string,
        );
        if (ownerEmail) {
          await sendSystemEmail({
            email: {
              to: ownerEmail,
              subject: "Re: Approval",
              textBody: decisionConfirmationLine("approved", executed.status),
            },
            sender: getEmailSender(),
          });
        }
      });

      await step.run("audit-decided", async () => {
        await new DrizzleApprovalLifecycleAuditWriter().writeAudit({
          action: "approval.decided",
          userId: event.data.userId as string,
          metadata: {
            approvalId,
            decision: "approved",
            channel: decided.data.channel,
            executeStatus: executed.status,
          },
        });
      });

      return { ok: true, branch: "approved", executeStatus: executed.status };
    }

    // ── Rejected / cancelled: audit + one-line confirmation. NEVER executes.
    await step.run("confirm-rejected", async () => {
      const ownerEmail = await new DrizzleOwnerEmailResolver().findOwnerEmail(
        event.data.userId as string,
      );
      if (ownerEmail) {
        await sendSystemEmail({
          email: {
            to: ownerEmail,
            subject: "Re: Approval",
            textBody: decisionConfirmationLine(decision),
          },
          sender: getEmailSender(),
        });
      }
    });

    await step.run("audit-decided", async () => {
      await new DrizzleApprovalLifecycleAuditWriter().writeAudit({
        action: "approval.decided",
        userId: event.data.userId as string,
        metadata: { approvalId, decision, channel: decided.data.channel },
      });
    });

    return { ok: true, branch: decision };
  },
);
