import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { approvalRequests, auditLog, drafts } from "@/db/schema";
import type { ApprovalRequest, Draft } from "@/db/schema";
import { getAction } from "@/approvals/actions/registry";
import { authorize, type KeepsActionKind } from "@/policy/actions";

/**
 * Loader port: resolves an approval id to its approval row and the draft it authorizes.
 *
 * This port is owned by execute.ts ON PURPOSE — `src/approvals/service.ts` and
 * `repository.ts` are owned by another agent, so we define our own thin loader here rather
 * than import theirs. The Drizzle default below is a self-contained join.
 */
export interface ApprovalDraftLoader {
  findApprovalWithDraft(
    approvalId: string,
  ): Promise<{ approval: ApprovalRequest; draft: Draft } | null>;
}

/** Audit writer port. Wave C wires the Drizzle default; tests inject an in-memory fake. */
export interface ApprovalAuditWriter {
  writeAudit(input: {
    action: "approval.executed" | "approval.execution_failed";
    userId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Error-email sender port. Invoked ONLY when an approved draft names an action the system
 * does not know how to run — a user-visible "we couldn't run this" signal. Typed callback;
 * the real transport is wired in Wave C.
 */
export type ApprovalErrorEmailSender = (input: {
  approval: ApprovalRequest;
  draft: Draft;
  reason: string;
}) => Promise<void>;

export interface ExecuteApprovedDraftDeps {
  loader: ApprovalDraftLoader;
  audit: ApprovalAuditWriter;
  sendErrorEmail: ApprovalErrorEmailSender;
  now?: Date;
}

export type ExecuteApprovedDraftResult =
  | { status: "executed"; detail?: unknown }
  | { status: "not_found" }
  | { status: "denied"; reason: string }
  | { status: "unknown_action" };

/**
 * The single funnel through which every approved action runs. This is the Phase 4 security
 * boundary: NO action — not even the `test_action` fixture — executes without passing
 * `authorize()` against the live approval. Every fail-closed branch writes a failure audit
 * row before returning.
 *
 * Flow:
 * 1. Load approval+draft. Missing → audit `approval.execution_failed`, return `not_found`.
 * 2. `authorize(action_kind, { userId, approval })`. result !== `allowed` → audit the
 *    reason, return `denied` WITHOUT executing. (Unrecognized kinds are authorized as
 *    external by `authorize`, so they fail closed here just like real external actions.)
 * 3. No registered handler for the kind → audit, send the user-visible error email, return
 *    `unknown_action`. (Authorized-but-unhandled: the grant was valid, we just can't run it.)
 * 4. Handler success → audit `approval.executed`, return `executed`.
 * 5. Handler throw → audit `approval.execution_failed`, rethrow (Inngest owns retries).
 */
export async function executeApprovedDraft(
  approvalId: string,
  deps: ExecuteApprovedDraftDeps,
): Promise<ExecuteApprovedDraftResult> {
  const now = deps.now ?? new Date();
  const loaded = await deps.loader.findApprovalWithDraft(approvalId);

  if (!loaded) {
    await deps.audit.writeAudit({
      action: "approval.execution_failed",
      userId: null,
      metadata: { approvalId, reason: "approval_or_draft_not_found" },
    });
    return { status: "not_found" };
  }

  const { approval, draft } = loaded;
  const actionKind = draft.actionKind;

  // `authorize` is total over arbitrary strings: unrecognized kinds (e.g. `test_action`)
  // are treated as EXTERNAL and require a valid approved approval. We never bypass it.
  const decision = authorize(
    actionKind as KeepsActionKind,
    {
      userId: approval.userId,
      approval: {
        id: approval.id,
        status: approval.status,
        expiresAt: approval.expiresAt,
      },
    },
    { now },
  );

  if (decision.result !== "allowed") {
    const reason = decision.reason ?? `authorization ${decision.result}`;
    await deps.audit.writeAudit({
      action: "approval.execution_failed",
      userId: approval.userId,
      metadata: { approvalId, actionKind, result: decision.result, reason },
    });
    return { status: "denied", reason };
  }

  const handler = getAction(actionKind);

  if (!handler) {
    const reason = `no handler registered for action_kind "${actionKind}"`;
    await deps.audit.writeAudit({
      action: "approval.execution_failed",
      userId: approval.userId,
      metadata: { approvalId, actionKind, reason: "unknown_action" },
    });
    await deps.sendErrorEmail({ approval, draft, reason });
    return { status: "unknown_action" };
  }

  let detail: unknown;
  try {
    const result = await handler({ draft, approval });
    detail = result.detail;
  } catch (error) {
    await deps.audit.writeAudit({
      action: "approval.execution_failed",
      userId: approval.userId,
      metadata: {
        approvalId,
        actionKind,
        reason: "handler_threw",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    // Inngest owns retries — surface the failure to the runtime by rethrowing.
    throw error;
  }

  await deps.audit.writeAudit({
    action: "approval.executed",
    userId: approval.userId,
    metadata: { approvalId, actionKind },
  });
  return { status: "executed", detail };
}

/**
 * Drizzle-backed default loader: joins the approval to its draft by `draftId`. Self-contained
 * so it does not depend on the approvals service/repository owned by another agent.
 */
export class DrizzleApprovalDraftLoader implements ApprovalDraftLoader {
  private readonly db = getDb();

  async findApprovalWithDraft(
    approvalId: string,
  ): Promise<{ approval: ApprovalRequest; draft: Draft } | null> {
    const [row] = await this.db
      .select({ approval: approvalRequests, draft: drafts })
      .from(approvalRequests)
      .innerJoin(drafts, eq(approvalRequests.draftId, drafts.id))
      .where(eq(approvalRequests.id, approvalId))
      .limit(1);

    return row ?? null;
  }
}

/** Drizzle-backed audit writer default (Wave C wiring). */
export class DrizzleApprovalAuditWriter implements ApprovalAuditWriter {
  private readonly db = getDb();

  async writeAudit(input: {
    action: "approval.executed" | "approval.execution_failed";
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
