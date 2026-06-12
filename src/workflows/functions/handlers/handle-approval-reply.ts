import { parseApprovalReplyCommand } from "@/approvals/commands";
import { decideApproval, type DecideApprovalResult } from "@/approvals/service";
import type { ApprovalRepository } from "@/approvals/repository";
import type { EventMap } from "@/workflows/events";

type EmitEvent = <K extends keyof EventMap>(name: K, data: EventMap[K]) => Promise<void>;

/**
 * Approval-reply handler (Deliverable #13 / task C4).
 *
 * Consumes the Wave-B approval primitives (parseApprovalReplyCommand, decideApproval).
 * The approvalId is ALWAYS taken from the nudge's persisted metadata (gotcha 6) — the
 * router passes it in; this handler never re-derives it from a fresh listing.
 *
 *   approve / approve_all → decideApproval('approved')
 *   reject  (± ordinal)   → decideApproval('rejected')
 *   cancel                → decideApproval('cancelled')
 *   edit                  → record the edit text on the still-pending approval; no decision
 *   unknown               → explain valid commands; no state change
 *
 * Every outcome (incl. already_decided / expired) produces a one-line reply body the
 * router persists + sends. Audit of the decision lives in decideApproval; the edit path
 * writes an explicit audit entry via the injected `audit` port.
 */

export type ApprovalReplyAudit = (entry: {
  userId: string;
  action: string;
  approvalId: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

export type HandleApprovalReplyInput = {
  userId: string;
  /** Resolved from the nudge metadata (gotcha 6) — never from a live listing. */
  approvalId: string;
  /** strippedTextReply ?? textBody. */
  text: string;
  now: Date;
  repository: ApprovalRepository;
  audit?: ApprovalReplyAudit;
  /**
   * Event emitter passed straight through to `decideApproval`. Defaults (inside
   * decideApproval) to the live Inngest `sendEvent`; tests inject a fake so they
   * never touch Inngest.
   */
  emitEvent?: EmitEvent;
};

export type HandleApprovalReplyOutcome =
  | "approved"
  | "rejected"
  | "cancelled"
  | "edited"
  | "already_decided"
  | "expired"
  | "not_found"
  | "unknown_command";

export type HandleApprovalReplyResult = {
  outcome: HandleApprovalReplyOutcome;
  /** One-line reply body for the user. */
  reply: string;
};

export async function handleApprovalReply(
  input: HandleApprovalReplyInput,
): Promise<HandleApprovalReplyResult> {
  const { userId, approvalId, text, now, repository, audit, emitEvent } = input;
  const command = parseApprovalReplyCommand(text, { now });

  if (command.type === "unknown") {
    return {
      outcome: "unknown_command",
      reply:
        "I didn't recognize that. Reply with: approve, reject, cancel, or edit: <your changes>.",
    };
  }

  if (command.type === "edit") {
    // Record the edit without deciding — the approval stays pending with the change noted.
    if (repository.appendDecisionMetadata) {
      await repository.appendDecisionMetadata(approvalId, {
        editRequested: true,
        editText: command.payloadText,
        editedAt: now.toISOString(),
      });
    }
    if (audit) {
      await audit({
        userId,
        action: "approval.edit_requested",
        approvalId,
        metadata: { editText: command.payloadText },
      });
    }
    return {
      outcome: "edited",
      reply: "Got your edit — the approval stays pending with your changes noted.",
    };
  }

  const decision =
    command.type === "approve" || command.type === "approve_all"
      ? "approved"
      : command.type === "reject"
        ? "rejected"
        : "cancelled";

  const result = await decideApproval({
    approvalId,
    decision,
    channel: "email_reply",
    now,
    repository,
    emitEvent,
  });

  return interpretDecision(decision, result);
}

function interpretDecision(
  decision: "approved" | "rejected" | "cancelled",
  result: DecideApprovalResult,
): HandleApprovalReplyResult {
  switch (result.status) {
    case "decided":
      return { outcome: decision, reply: replyForDecision(decision) };
    case "already_decided":
      return {
        outcome: "already_decided",
        reply: `This approval was already ${result.request.status}.`,
      };
    case "expired":
      return {
        outcome: "expired",
        reply: "This approval has expired, so I couldn't apply your reply.",
      };
    case "not_found":
      return {
        outcome: "not_found",
        reply: "I couldn't find that approval anymore.",
      };
  }
}

function replyForDecision(decision: "approved" | "rejected" | "cancelled"): string {
  switch (decision) {
    case "approved":
      return "Approved — I'll take it from here.";
    case "rejected":
      return "Rejected — I won't proceed.";
    case "cancelled":
      return "Cancelled — this approval is closed.";
  }
}
