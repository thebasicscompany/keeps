import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { approvalRequests, drafts } from "@/db/schema";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";

// ---------------------------------------------------------------------------
// Joined view: an approval request with its draft attached.
// ---------------------------------------------------------------------------

export type ApprovalRequestWithDraft = ApprovalRequest & {
  draft: Draft;
};

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export type InsertApprovalRequestInput = {
  id: string;
  userId: string;
  draftId: string;
  actionKind: string;
  tokenHash: string;
  expiresAt: Date;
};

export type UpdateApprovalDecisionInput = {
  id: string;
  status: "approved" | "rejected" | "cancelled" | "expired";
  decidedAt: Date;
  decisionChannel: string;
  decisionMetadata?: Record<string, unknown>;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Port interface — business logic never touches Drizzle directly.
// ---------------------------------------------------------------------------

export interface ApprovalRepository {
  /** Insert a new draft row and return the inserted row. */
  insertDraft(input: NewDraft): Promise<Draft>;

  /** Insert a new approval_request row and return the inserted row. */
  insertApprovalRequest(input: InsertApprovalRequestInput): Promise<ApprovalRequest>;

  /** Find an approval request by id, joined with its draft. Returns null if not found. */
  findApprovalById(id: string): Promise<ApprovalRequestWithDraft | null>;

  /**
   * Find an approval request by token_hash, joined with its draft.
   * Returns null if not found.
   */
  findApprovalByTokenHash(tokenHash: string): Promise<ApprovalRequestWithDraft | null>;

  /**
   * Update the decision fields on an approval_request WHERE id = input.id AND status = 'pending'.
   * The WHERE-pending guard makes the transition atomic — concurrent decides cannot both win.
   * Returns the updated row on success, or null if no row matched (already decided or not found).
   */
  updateApprovalDecision(input: UpdateApprovalDecisionInput): Promise<ApprovalRequest | null>;

  /**
   * Find pending approval_requests whose expires_at <= now.
   * Used by the expiry sweep (Deliverable #17).
   */
  findPendingExpired(now: Date): Promise<ApprovalRequest[]>;

  /**
   * Overwrite token_hash on an approval_request WHERE id = input.id AND status = 'pending'.
   * The WHERE-pending guard means a decided/expired row is never re-tokened.
   * Returns the updated row on success, or null if no row matched.
   *
   * Used by rotateApprovalToken (src/approvals/service.ts): the handle-approval
   * workflow re-mints the plaintext token here because it is not — and must not be —
   * carried in the approval.requested event payload (rule 7: tokens never in logs).
   */
  updateApprovalTokenHash(input: { id: string; tokenHash: string }): Promise<ApprovalRequest | null>;
}

// ---------------------------------------------------------------------------
// Drizzle-backed implementation — thin SQL only, no business logic.
// ---------------------------------------------------------------------------

export class DrizzleApprovalRepository implements ApprovalRepository {
  private readonly db = getDb();

  async insertDraft(input: NewDraft): Promise<Draft> {
    const [row] = await this.db.insert(drafts).values(input).returning();
    if (!row) {
      throw new Error("insertDraft: no row returned");
    }
    return row;
  }

  async insertApprovalRequest(input: InsertApprovalRequestInput): Promise<ApprovalRequest> {
    const [row] = await this.db
      .insert(approvalRequests)
      .values({
        id: input.id,
        userId: input.userId,
        draftId: input.draftId,
        actionKind: input.actionKind,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) {
      throw new Error("insertApprovalRequest: no row returned");
    }
    return row;
  }

  async findApprovalById(id: string): Promise<ApprovalRequestWithDraft | null> {
    const [row] = await this.db
      .select({
        request: approvalRequests,
        draft: drafts,
      })
      .from(approvalRequests)
      .innerJoin(drafts, eq(approvalRequests.draftId, drafts.id))
      .where(eq(approvalRequests.id, id))
      .limit(1);

    if (!row) {
      return null;
    }

    return { ...row.request, draft: row.draft };
  }

  async findApprovalByTokenHash(tokenHash: string): Promise<ApprovalRequestWithDraft | null> {
    const [row] = await this.db
      .select({
        request: approvalRequests,
        draft: drafts,
      })
      .from(approvalRequests)
      .innerJoin(drafts, eq(approvalRequests.draftId, drafts.id))
      .where(eq(approvalRequests.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      return null;
    }

    return { ...row.request, draft: row.draft };
  }

  async updateApprovalDecision(input: UpdateApprovalDecisionInput): Promise<ApprovalRequest | null> {
    const [row] = await this.db
      .update(approvalRequests)
      .set({
        status: input.status,
        decidedAt: input.decidedAt,
        decisionChannel: input.decisionChannel,
        decisionMetadata: input.decisionMetadata ?? {},
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(approvalRequests.id, input.id),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .returning();

    return row ?? null;
  }

  async findPendingExpired(now: Date): Promise<ApprovalRequest[]> {
    return this.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.status, "pending"),
          lte(approvalRequests.expiresAt, now),
        ),
      );
  }

  async updateApprovalTokenHash(input: {
    id: string;
    tokenHash: string;
  }): Promise<ApprovalRequest | null> {
    const [row] = await this.db
      .update(approvalRequests)
      .set({ tokenHash: input.tokenHash, updatedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.id, input.id),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .returning();

    return row ?? null;
  }
}
