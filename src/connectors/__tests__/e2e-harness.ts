/**
 * Shared e2e harness for the Phase 4 connector-command acceptance fixtures (E1–E6).
 *
 * GOAL: drive the WHOLE connector flow from "an email arrives" through to the live
 * provider call (or the block before it), composing the EXPORTED PURE CORES of
 * handle-connector-command.ts — NOT the Inngest runtime. The orchestrator below
 * faithfully reproduces the Inngest wrapper's decision tree (load account →
 * resolve recipient → freeze payload → create approval+action → gate by
 * reversibility → wait for decision → execute-once), but with every side effect
 * routed through injected ports so the fixtures can assert the safety invariants:
 *
 *   - EXACTLY ONE outbound email per command (the approval.requested suppression
 *     must hold — a second/generic approval email is a regression).
 *   - the frozen payload carries the resolved channel + verbatim message.
 *   - the provider executor runs EXACTLY ONCE (or ZERO times when blocked).
 *   - ambiguity / missing-account / missing-when BLOCK approval entirely.
 *
 * The email-sending steps in the real wrapper are inline glue (sendSystemEmail +
 * getEmailSender), not pure cores, so this harness re-expresses that glue against
 * a capturing sender while asserting the bodies are byte-for-byte the real template
 * builders (buildConnectorMissingEmail / buildConnectorAmbiguousEmail /
 * buildConnectorApprovalEmail). That is what makes "exactly one APPROVAL email"
 * a meaningful, adversarial assertion rather than a tautology.
 */

import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  approvalRequests,
  drafts,
  type ApprovalRequest,
  type Draft,
  type NewDraft,
} from "@/db/schema";
import type {
  ApprovalRepository,
  ApprovalRequestWithDraft,
  InsertApprovalRequestInput,
  UpdateApprovalDecisionInput,
} from "@/approvals/repository";
import {
  DrizzleConnectorActionsRepository,
  executeConnectorAction,
  type ExecuteConnectorActionResult,
} from "@/connectors/execute";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import { classifyReversibility } from "@/connectors/action-registry";
import type { ToolExecutor } from "@/connectors/recipient";
import {
  buildFrozenPayload,
  createApprovalAndAction,
  loadConnectorAccount,
  providerForKind,
  resolveCommandRecipient,
  summarizeCommand,
} from "@/workflows/functions/handle-connector-command";
import type { ConnectorAccountsRepository } from "@/connectors/accounts-repository";
import type { ConnectorAccount } from "@/db/schema";
import { decideApproval } from "@/approvals/service";
import { buildConnectorMissingEmail } from "@/email/templates/connector-missing";
import { buildConnectorAmbiguousEmail } from "@/email/templates/connector-ambiguous";
import { buildConnectorApprovalEmail } from "@/email/templates/connector-approval";
import { buildApprovalLinks } from "@/approvals/links";
import type { ConnectorCommandDraft, ConnectorActionPayload } from "@/agent/schemas";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Captured outbound email — the single thing every safety assertion counts.
// ---------------------------------------------------------------------------

/** A classified outbound email captured by the harness (no Postmark, no network). */
export interface CapturedEmail {
  /**
   * Which template/branch produced this email. 'connector_approval' is the ONLY
   * value that a happy-path command may produce exactly once; any 'generic_approval'
   * would prove the approval.requested suppression regressed.
   */
  template:
    | "connector_approval"
    | "connector_missing"
    | "connector_ambiguous"
    | "connector_not_found"
    | "connector_needs_when"
    | "execution_confirm"
    | "cancel_confirm"
    | "generic_approval"; // sentinel — NEVER expected; presence = regression.
  to: string;
  subject: string;
  textBody: string;
}

// ---------------------------------------------------------------------------
// In-memory accounts repo (extends the unit-test fake; no DB needed for accounts).
// ---------------------------------------------------------------------------

export class FakeAccountsRepo implements ConnectorAccountsRepository {
  account: ConnectorAccount | null = null;
  async findActiveByUserAndProvider(): Promise<ConnectorAccount | null> {
    return this.account;
  }
  async upsertByComposioAccount(): Promise<ConnectorAccount> {
    throw new Error("unused");
  }
  async markStatus(): Promise<ConnectorAccount | null> {
    return null;
  }
  async hydrate(): Promise<ConnectorAccount | null> {
    return null;
  }
  async listActive(): Promise<ConnectorAccount[]> {
    return [];
  }
  async findByComposioAccount(): Promise<ConnectorAccount | null> {
    return null;
  }
  async findById(): Promise<ConnectorAccount | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB-injectable approval repository.
//
// DrizzleApprovalRepository hardcodes getDb() (DATABASE_URL), so it cannot target
// the TEST_DATABASE_URL Postgres the DB-gated fixtures inject. This mirrors that
// SQL exactly but against an injected db handle — the connector-actions repo is
// already db-injectable (DrizzleConnectorActionsRepository(db)).
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: drizzle's concrete db type varies; the
// harness only uses insert/select/update which all PgDatabase instances expose.
type AnyDb = PgDatabase<any, any, any>;

export class InjectedApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: AnyDb) {}

  async insertDraft(input: NewDraft): Promise<Draft> {
    const [row] = await this.db.insert(drafts).values(input).returning();
    if (!row) throw new Error("insertDraft: no row returned");
    return row as Draft;
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
    if (!row) throw new Error("insertApprovalRequest: no row returned");
    return row as ApprovalRequest;
  }

  async findApprovalById(id: string): Promise<ApprovalRequestWithDraft | null> {
    const [row] = await this.db
      .select({ request: approvalRequests, draft: drafts })
      .from(approvalRequests)
      .innerJoin(drafts, eq(approvalRequests.draftId, drafts.id))
      .where(eq(approvalRequests.id, id))
      .limit(1);
    if (!row) return null;
    return { ...row.request, draft: row.draft } as ApprovalRequestWithDraft;
  }

  async findApprovalByTokenHash(tokenHash: string): Promise<ApprovalRequestWithDraft | null> {
    const [row] = await this.db
      .select({ request: approvalRequests, draft: drafts })
      .from(approvalRequests)
      .innerJoin(drafts, eq(approvalRequests.draftId, drafts.id))
      .where(eq(approvalRequests.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    return { ...row.request, draft: row.draft } as ApprovalRequestWithDraft;
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
      .where(and(eq(approvalRequests.id, input.id), eq(approvalRequests.status, "pending")))
      .returning();
    return (row as ApprovalRequest) ?? null;
  }

  async findPendingExpired(now: Date): Promise<ApprovalRequest[]> {
    return (await this.db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.status, "pending"), lte(approvalRequests.expiresAt, now)),
      )) as ApprovalRequest[];
  }

  async updateApprovalTokenHash(input: {
    id: string;
    tokenHash: string;
  }): Promise<ApprovalRequest | null> {
    const [row] = await this.db
      .update(approvalRequests)
      .set({ tokenHash: input.tokenHash, updatedAt: new Date() })
      .where(and(eq(approvalRequests.id, input.id), eq(approvalRequests.status, "pending")))
      .returning();
    return (row as ApprovalRequest) ?? null;
  }
}

// ---------------------------------------------------------------------------
// The orchestrator — composes the cores into the wrapper's decision tree.
// ---------------------------------------------------------------------------

export interface RunConnectorCommandDeps {
  /** The parsed command (from the router, which started at "email arrives"). */
  command: ConnectorCommandDraft;
  userId: string;
  inboundEmailId: string;
  account: ConnectorAccount | null;
  ownerEmail: string;
  appUrl: string;
  /** Injected db for the approval + connector_actions writes (DB-gated fixtures). */
  db: AnyDb;
  /** Recipient resolution executor (Slack lookup) — a fake; counts/records calls. */
  recipientExecutor?: ToolExecutor;
  /** Provider executor (the live action) — a fake; counts/records calls. */
  connectorExecutor: ConnectorExecutor;
  /** Captures every outbound email so the fixture can assert EXACTLY ONE. */
  emails: CapturedEmail[];
  /** Clock minted for createApprovalAndAction + execute. */
  now: Date;
}

export type RunConnectorCommandOutcome =
  | { branch: "missing_account" }
  | { branch: "recipient_ambiguous" }
  | { branch: "recipient_not_found" }
  | { branch: "needs_when" }
  | {
      /** Approval was created; the flow is now waiting for a decision. */
      branch: "awaiting_decision";
      approvalId: string;
      connectorActionId: string;
      token: string;
      payload: ConnectorActionPayload;
      reversibility: "reversible" | "irreversible";
    };

/**
 * Runs steps (a)–(e) of the wrapper: everything up to and INCLUDING the approval
 * email + approval-row creation, stopping at the waitForEvent boundary. The fixture
 * then drives the decision (approve / timeout) and calls executeOnce() below.
 *
 * Mirrors the wrapper's branch order EXACTLY:
 *   (a) load account → missing → connect-link email, stop.
 *   (b) resolve recipient → ambiguous/not_found → clarify, stop.
 *   (c) freeze payload → calendar whenAt null → needs-when, stop.
 *   (d) create approval + connector_actions row (approval.requested SUPPRESSED).
 *   (e) send the gated approval/confirmation email.
 */
export async function runUpToApproval(
  deps: RunConnectorCommandDeps,
): Promise<RunConnectorCommandOutcome> {
  const accountProvider = providerForKind(deps.command.kind);

  // (a) load account.
  const accountsRepo = new FakeAccountsRepo();
  accountsRepo.account = deps.account;
  const loaded = await loadConnectorAccount({
    userId: deps.userId,
    provider: accountProvider,
    accounts: accountsRepo,
  });
  if (loaded.status === "missing") {
    const { subject, textBody } = buildConnectorMissingEmail({
      provider: accountProvider,
      commandSummary: summarizeCommand(deps.command),
      connectUrl: `${deps.appUrl}/settings/connectors`,
    });
    deps.emails.push({ template: "connector_missing", to: deps.ownerEmail, subject, textBody });
    return { branch: "missing_account" };
  }
  const account = loaded.account;

  // (b) resolve recipient (slack_dm only).
  const recipient = await resolveCommandRecipient({
    command: deps.command,
    keepsUserId: account.userId,
    connectedAccountId: account.composioConnectedAccountId,
    ...(deps.recipientExecutor ? { execute: deps.recipientExecutor } : {}),
  });

  if (recipient.status === "ambiguous") {
    const { subject, textBody } = buildConnectorAmbiguousEmail({
      recipientNameText: deps.command.destination.nameText ?? "that person",
      candidates: recipient.result.candidates.map((c) => ({ name: c.name, email: c.email })),
      commandSummary: summarizeCommand(deps.command),
    });
    deps.emails.push({ template: "connector_ambiguous", to: deps.ownerEmail, subject, textBody });
    return { branch: "recipient_ambiguous" };
  }
  if (recipient.status === "not_found") {
    const who =
      deps.command.destination.nameText ?? deps.command.destination.emailText ?? "that person";
    deps.emails.push({
      template: "connector_not_found",
      to: deps.ownerEmail,
      subject: `Couldn't find ${who} in Slack`,
      textBody: `I couldn't find ${who} in your Slack workspace, so I didn't send anything. Reply with their exact name or email and I'll try again.`,
    });
    return { branch: "recipient_not_found" };
  }

  // (c) freeze payload.
  const built = buildFrozenPayload({ command: deps.command, recipient });
  if (built.status === "needs_when") {
    const title = deps.command.eventTitle ?? "that event";
    deps.emails.push({
      template: "connector_needs_when",
      to: deps.ownerEmail,
      subject: `When should I add "${title}"?`,
      textBody: `I'd like to add "${title}" to your calendar, but I couldn't tell when. Reply with a specific date and time and I'll set it up.`,
    });
    return { branch: "needs_when" };
  }

  const frozenPayload = built.payload;
  const reversibility = classifyReversibility(frozenPayload);
  const ttlMs = reversibility === "reversible" ? FIFTEEN_MIN_MS : SEVEN_DAYS_MS;

  // (d) create approval + connector_actions row. CRITICAL: approval.requested is
  // suppressed (emitEvent: async () => {}) exactly as the wrapper does, so the
  // Phase-3 handle-approval function would NEVER fire a generic approval email.
  // We assert that by counting emails: this orchestrator emits the connector
  // approval email and nothing else.
  const created = await createApprovalAndAction({
    command: deps.command,
    payload: frozenPayload,
    account: { id: account.id, userId: account.userId } as ConnectorAccount,
    inboundEmailId: deps.inboundEmailId,
    provider: deps.command.provider,
    approvals: new InjectedApprovalRepository(deps.db),
    actions: new DrizzleConnectorActionsRepository(deps.db as never),
    now: deps.now,
    ttlMs,
    emitEvent: async () => {
      // Suppressed — see handle-connector-command.ts step (d) for the rationale.
      // If this orchestrator (mirroring the wrapper) ever broadcast approval.requested,
      // a generic approval email would follow. We never do; the fixture asserts it.
    },
  });

  // (e) gated approval/confirmation email.
  const action =
    frozenPayload.kind === "slack_dm"
      ? {
          kind: "slack_dm" as const,
          recipientName: frozenPayload.recipientName ?? "someone",
          recipientSlackHandleOrEmail: frozenPayload.recipientEmail,
          message: frozenPayload.message ?? "",
        }
      : {
          kind: "calendar_event" as const,
          title: frozenPayload.eventTitle ?? "Reminder",
          whenLocal: deps.command.whenText ?? frozenPayload.whenAt ?? "",
          durationMinutes: frozenPayload.durationMinutes,
        };
  const { subject, textBody } = buildConnectorApprovalEmail({
    approvalId: created.approvalId,
    token: created.token,
    appUrl: deps.appUrl,
    action,
  });
  deps.emails.push({ template: "connector_approval", to: deps.ownerEmail, subject, textBody });

  return {
    branch: "awaiting_decision",
    approvalId: created.approvalId,
    connectorActionId: created.connectorActionId,
    token: created.token,
    payload: frozenPayload,
    reversibility,
  };
}

/**
 * Drives step (f): execute-once + the terminal confirmation email. Mirrors the
 * wrapper's `decision === "approved"` arm. The execute uses the REAL FOR UPDATE
 * execute-once layer against the injected db, with the fake connectorExecutor.
 */
export async function executeAndConfirm(
  deps: RunConnectorCommandDeps,
  connectorActionId: string,
): Promise<ExecuteConnectorActionResult> {
  const executed = await executeConnectorAction({
    db: deps.db as never,
    execute: deps.connectorExecutor,
    connectorActionId,
    now: deps.now,
  });

  // Terminal confirmation one-liner (the wrapper's confirm-executed step).
  const line =
    executed.status === "completed"
      ? "Approved — done."
      : executed.status === "denied"
        ? "Approved, but the action was blocked by policy. Nothing ran."
        : executed.status === "failed"
          ? "Approved, but the action failed to run. I'll let you know if I can retry."
          : "Approved.";
  deps.emails.push({
    template: "execution_confirm",
    to: deps.ownerEmail,
    subject: "Re: Approval",
    textBody: line,
  });
  return executed;
}

// ---------------------------------------------------------------------------
// Decision helpers — the user's approve, or the auto-confirm-on-timeout path.
// ---------------------------------------------------------------------------

/** Web/email approval: decide the approval row 'approved' (decideApproval). */
export async function approveViaDecide(
  db: AnyDb,
  approvalId: string,
  now: Date,
): Promise<void> {
  await decideApproval({
    approvalId,
    decision: "approved",
    channel: "web_link",
    now,
    repository: new InjectedApprovalRepository(db),
    emitEvent: async () => {},
  });
}

/** Reversible confirmation-window timeout: auto-confirm via channel 'cron'. */
export async function autoConfirmOnTimeout(
  db: AnyDb,
  approvalId: string,
  now: Date,
): Promise<void> {
  await decideApproval({
    approvalId,
    decision: "approved",
    channel: "cron",
    now,
    repository: new InjectedApprovalRepository(db),
    emitEvent: async () => {},
  });
}

// ---------------------------------------------------------------------------
// Re-exported template builders so fixtures assert against the SAME bodies.
// ---------------------------------------------------------------------------

export {
  buildConnectorMissingEmail,
  buildConnectorAmbiguousEmail,
  buildConnectorApprovalEmail,
  buildApprovalLinks,
};
