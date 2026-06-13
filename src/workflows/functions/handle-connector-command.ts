/**
 * handle-connector-command (Phase 4 — D1).
 *
 * The connector analogue of handle-approval: it turns a parsed connector command
 * (carried inline on the `connector.action_requested` event) into an approval,
 * waits for the user, and executes EXACTLY ONCE through the D2 execute-once layer.
 *
 * It mirrors handle-approval's discipline:
 *   - pure cores (no I/O on their own — they take injected ports) + a thin Inngest
 *     wrapper that binds Drizzle/Composio/email implementations to those cores;
 *   - SEND-ONLY steps (Postmark calls) separated from DB-write steps so a retry
 *     after an accepted send never double-sends;
 *   - `now` minted inside a step and passed across step boundaries as primitives;
 *   - step.waitForEvent (never sleepUntil) for the approval wait (AR-5);
 *   - the FROZEN-PAYLOAD invariant: the recipient is resolved UPSTREAM (recipient.ts)
 *     and the resolved destination is frozen into the payload before approval.
 *
 * Step structure (see the createFunction body at the bottom):
 *   (a) load the active connector account; MISSING → connect-link email, stop.
 *   (b) slack_dm only: resolve the recipient; ambiguous/not_found → clarify, stop.
 *   (c) build the frozen ConnectorActionPayload; calendar with whenAt === null →
 *       clarify, stop (prevents the action-registry epoch fallback from firing).
 *   (d) createApprovalRequest (Phase 3) + create the connector_actions row.
 *   (e) gate by reversibility: irreversible → hard approval (7d); reversible
 *       (calendar self) → confirmation window (15m), timeout = auto-confirm.
 *   (f) on approval: executeConnectorAction (D2) + emit completed/failed; on
 *       reject/cancel: mark the row cancelled. Final confirmation email.
 *
 * @see src/workflows/functions/handle-approval.ts — the structural template
 * @see src/connectors/execute.ts — executeConnectorAction (D2, execute-once)
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getEnv, getOptionalEnv } from "@/config/env";
import { getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import { inngest } from "@/workflows/client";
import { sendEvent, type EventMap } from "@/workflows/events";
import type { ConnectorCommandDraft, ConnectorActionPayload } from "@/agent/schemas";
import {
  DrizzleConnectorAccountsRepository,
  type ConnectorAccountsRepository,
  type ConnectorProvider,
} from "@/connectors/accounts-repository";
import type { ConnectorAccount } from "@/db/schema";
import {
  resolveRecipient,
  type ToolExecutor,
  type ResolveRecipientResult,
} from "@/connectors/recipient";
import { classifyReversibility } from "@/connectors/action-registry";
import {
  createApprovalRequest,
  decideApproval,
} from "@/approvals/service";
import { DrizzleApprovalRepository, type ApprovalRepository } from "@/approvals/repository";
import {
  DrizzleConnectorActionsRepository,
  executeConnectorAction,
  type ConnectorActionsRepository,
  type ExecuteConnectorActionResult,
} from "@/connectors/execute";
import { buildConnectorMissingEmail } from "@/email/templates/connector-missing";
import { buildConnectorAmbiguousEmail } from "@/email/templates/connector-ambiguous";
import { buildConnectorApprovalEmail } from "@/email/templates/connector-approval";
import { sendSystemEmail } from "@/email/system-send";
import { getEmailSender } from "@/email/sender-factory";
import {
  buildNudgeReplyTo,
  type EmailSender,
} from "@/email/outbound";

// ---------------------------------------------------------------------------
// Ports — pure interfaces so the unit test injects in-memory fakes.
// ---------------------------------------------------------------------------

/** Resolves the owner's canonical email — the only address a reply may reach. */
export interface OwnerResolver {
  findOwnerEmail(userId: string): Promise<string | null>;
  findTimezone(userId: string): Promise<string | null>;
}

/** Audit writer for the connector lifecycle actions this workflow owns. */
export interface ConnectorAuditWriter {
  writeAudit(input: {
    action:
      | "connector.action_requested"
      | "connector.recipient_ambiguous"
      | "connector.action_executed"
      | "connector.action_failed";
    userId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/** Sends a plain system notice (connect-link / clarification / confirmation). */
export type SystemNoticeSender = (notice: {
  to: string;
  subject: string;
  textBody: string;
}) => Promise<void>;

/** Event emitter — defaults to the real typed sendEvent; tests inject a fake. */
export type EmitEvent = <K extends keyof EventMap>(name: K, data: EventMap[K]) => Promise<void>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The connector_accounts provider for an action kind. */
export function providerForKind(kind: ConnectorCommandDraft["kind"]): ConnectorProvider {
  return kind === "slack_dm" ? "slack" : "google_calendar";
}

/** A one-line, human-readable summary of a connector command (for emails / audit). */
export function summarizeCommand(command: ConnectorCommandDraft): string {
  if (command.kind === "slack_dm") {
    const who = command.destination.nameText ?? command.destination.emailText ?? "someone";
    return `send a Slack message to ${who}`;
  }
  const title = command.eventTitle ?? "an event";
  const when = command.whenText ?? command.whenAt ?? "an unspecified time";
  return `add "${title}" to your calendar at ${when}`;
}

// ---------------------------------------------------------------------------
// (a) Load account — pure core
// ---------------------------------------------------------------------------

export type LoadAccountResult =
  | { status: "found"; account: ConnectorAccount }
  | { status: "missing" };

export async function loadConnectorAccount(input: {
  userId: string;
  provider: ConnectorProvider;
  accounts: ConnectorAccountsRepository;
}): Promise<LoadAccountResult> {
  const account = await input.accounts.findActiveByUserAndProvider(input.userId, input.provider);
  return account ? { status: "found", account } : { status: "missing" };
}

// ---------------------------------------------------------------------------
// (b) Resolve recipient — pure core (slack_dm only)
// ---------------------------------------------------------------------------

export type RecipientOutcome =
  | { status: "resolved"; destination: string; name: string | null; email: string | null }
  | { status: "ambiguous"; result: Extract<ResolveRecipientResult, { status: "ambiguous" }> }
  | { status: "not_found" }
  | { status: "self" };

/**
 * Resolves the slack_dm recipient UPSTREAM of approval. Calendar self-events skip
 * resolution. A 'person' destination with neither name nor email is treated as
 * not_found (nothing to resolve). The resolved destination is the value frozen
 * into the payload as `channel`.
 */
export async function resolveCommandRecipient(input: {
  command: ConnectorCommandDraft;
  keepsUserId: string;
  connectedAccountId: string;
  execute?: ToolExecutor;
}): Promise<RecipientOutcome> {
  const { command } = input;

  if (command.kind !== "slack_dm") {
    return { status: "self" };
  }
  if (command.destination.kind === "self") {
    // A slack self-DM: target the user's own account. recipient.ts resolves people,
    // not self — a self-DM uses the user's own entity, which Composio addresses via
    // a null/empty channel is not supported here, so V0 requires a named person.
    return { status: "not_found" };
  }
  if (!command.destination.nameText && !command.destination.emailText) {
    return { status: "not_found" };
  }

  const result = await resolveRecipient(
    {
      provider: "slack",
      nameText: command.destination.nameText,
      emailText: command.destination.emailText,
    },
    {
      keepsUserId: input.keepsUserId,
      connectedAccountId: input.connectedAccountId,
      ...(input.execute ? { execute: input.execute } : {}),
    },
  );

  if (result.status === "ambiguous") {
    return { status: "ambiguous", result };
  }
  if (result.status === "not_found") {
    return { status: "not_found" };
  }
  return {
    status: "resolved",
    destination: result.destination,
    name: result.name,
    email: result.email,
  };
}

// ---------------------------------------------------------------------------
// (c) Build the frozen payload — pure core
// ---------------------------------------------------------------------------

export type BuildPayloadResult =
  | { status: "ok"; payload: ConnectorActionPayload }
  | { status: "needs_when" };

/**
 * Builds the FROZEN ConnectorActionPayload. The resolved Slack destination is
 * frozen into `channel`. A calendar_event with whenAt === null is rejected
 * (needs_when) so the action-registry's epoch fallback can never fire.
 */
export function buildFrozenPayload(input: {
  command: ConnectorCommandDraft;
  recipient: RecipientOutcome;
}): BuildPayloadResult {
  const { command, recipient } = input;

  if (command.kind === "slack_dm") {
    // resolveCommandRecipient guarantees a 'resolved' recipient before we reach here.
    const resolved =
      recipient.status === "resolved"
        ? recipient
        : { destination: "", name: null as string | null, email: null as string | null };
    const payload: ConnectorActionPayload = {
      kind: "slack_dm",
      destination: command.destination,
      message: command.message,
      channel: resolved.destination,
      recipientName: resolved.name,
      recipientEmail: resolved.email,
    };
    return { status: "ok", payload };
  }

  // calendar_event
  if (command.whenAt === null) {
    return { status: "needs_when" };
  }
  const payload: ConnectorActionPayload = {
    kind: "calendar_event",
    destination: command.destination,
    eventTitle: command.eventTitle,
    whenAt: command.whenAt,
    durationMinutes: command.durationMinutes,
    reminderMinutesBefore: command.reminderMinutesBefore,
    description: null,
    attendees: null,
  };
  return { status: "ok", payload };
}

// ---------------------------------------------------------------------------
// (d) Create approval + connector_actions row — pure core
// ---------------------------------------------------------------------------

/**
 * Reuses Phase 3 createApprovalRequest (creates draft + approval_request, emits
 * approval.requested) then creates the connector_actions row keyed by the approval id.
 * Returns the approvalId, the connectorActionId, and the rotated-once plaintext token
 * (createApprovalRequest hands the token back to its synchronous caller — we ARE that
 * caller, so unlike handle-approval we do not need to re-rotate; the token flows only
 * into the approval email body).
 */
export async function createApprovalAndAction(input: {
  command: ConnectorCommandDraft;
  payload: ConnectorActionPayload;
  account: ConnectorAccount;
  inboundEmailId: string;
  provider: "slack" | "google_calendar";
  approvals: ApprovalRepository;
  actions: ConnectorActionsRepository;
  now: Date;
  /** calendar confirmation window is shorter than the 7d hard-approval window. */
  ttlMs: number;
  emitEvent?: EmitEvent;
}): Promise<{ approvalId: string; connectorActionId: string; token: string }> {
  const { request, token } = await createApprovalRequest({
    userId: input.account.userId,
    draft: {
      actionKind: input.command.kind,
      payload: input.payload as unknown as Record<string, unknown>,
      sourceLoopId: input.command.linkedLoopId ?? undefined,
    },
    ttlMs: input.ttlMs,
    now: input.now,
    repository: input.approvals,
    ...(input.emitEvent ? { emitEvent: input.emitEvent } : {}),
  });

  const action = await input.actions.createAction({
    userId: input.account.userId,
    connectorAccountId: input.account.id,
    kind: input.command.kind,
    payload: input.payload,
    idempotencyKey: `connector:${input.provider}:${request.id}`,
    approvalRequestId: request.id,
    draftId: request.draftId,
    inboundEmailId: input.inboundEmailId,
    loopId: input.command.linkedLoopId ?? null,
    now: input.now,
  });

  return { approvalId: request.id, connectorActionId: action.id, token };
}

// ---------------------------------------------------------------------------
// Drizzle-backed default ports
// ---------------------------------------------------------------------------

export class DrizzleOwnerResolver implements OwnerResolver {
  private readonly db = getDb();
  async findOwnerEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.email ?? null;
  }
  async findTimezone(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.timezone ?? null;
  }
}

export class DrizzleConnectorAuditWriter implements ConnectorAuditWriter {
  private readonly db = getDb();
  async writeAudit(input: Parameters<ConnectorAuditWriter["writeAudit"]>[0]): Promise<void> {
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
// Inngest wrapper — thin binding of Drizzle/Composio/email to the pure cores.
// ---------------------------------------------------------------------------

/** Hard-approval window (slack_dm, calendar-with-attendees). Overridable for tests. */
const HARD_APPROVAL_TIMEOUT = process.env.CONNECTOR_APPROVAL_TIMEOUT_OVERRIDE ?? "7d";
/** Confirmation window for reversible (self-calendar) actions: the user has this
 * long to cancel before the event is auto-created. */
const CONFIRM_WINDOW_TIMEOUT = process.env.CONNECTOR_CONFIRM_TIMEOUT_OVERRIDE ?? "15m";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Approval TTL for a reversible confirmation-window action. This MUST be strictly
 * LONGER than CONFIRM_WINDOW_TIMEOUT: when the wait times out (~15m), the
 * confirm-on-timeout step calls decideApproval(approved) — which is rejected by
 * decideApproval's expiry guard if expiresAt has already passed. With TTL == window
 * the approval expires at the exact instant the timeout fires, so auto-confirm
 * silently fails and AR-7 then denies the execute, meaning the event the user was
 * promised "in 15 minutes unless you cancel" is NEVER created. A 1h TTL leaves the
 * approval valid through the confirm, and the every-15m expiry sweep won't expire it
 * before the confirm fires.
 */
const CONFIRM_WINDOW_TTL_MS = 60 * 60 * 1000;

export const handleConnectorCommandFunction = inngest.createFunction(
  {
    id: "handle-connector-command",
    triggers: { event: "connector.action_requested" },
    // V0: one connector command per inbound email.
    idempotency: "event.data.inboundEmailId",
  },
  async ({ event, step }) => {
    const userId = event.data.userId as string;
    const inboundEmailId = event.data.inboundEmailId as string;
    const provider = event.data.provider as "slack" | "google_calendar";
    const command = event.data.command as ConnectorCommandDraft;
    const accountProvider = providerForKind(command.kind);

    // ── (a) Load the active connector account. MISSING → connect-link, stop.
    const accountStep = await step.run("load-connector-account", async () => {
      const result = await loadConnectorAccount({
        userId,
        provider: accountProvider,
        accounts: new DrizzleConnectorAccountsRepository(),
      });
      if (result.status === "missing") {
        return { status: "missing" as const };
      }
      // Return only the primitives the later steps need (Inngest serializes the return).
      return {
        status: "found" as const,
        account: {
          id: result.account.id,
          userId: result.account.userId,
          composioConnectedAccountId: result.account.composioConnectedAccountId,
        },
      };
    });

    if (accountStep.status === "missing") {
      await step.run("send-connect-link", async () => {
        const env = getEnv();
        const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
        if (ownerEmail) {
          const { subject, textBody } = buildConnectorMissingEmail({
            provider: accountProvider,
            commandSummary: summarizeCommand(command),
            connectUrl: `${env.NEXT_PUBLIC_APP_URL}/settings/connectors`,
          });
          await sendSystemEmail({ email: { to: ownerEmail, subject, textBody }, sender: getEmailSender() });
        }
        await new DrizzleConnectorAuditWriter().writeAudit({
          action: "connector.action_failed",
          userId,
          metadata: { reason: "connector_account_missing", provider: accountProvider },
        });
      });
      return { ok: true, branch: "missing_account" };
    }

    const account = accountStep.account;

    // ── (b) Resolve recipient (slack_dm). ambiguous/not_found → clarify, stop.
    const recipientStep = await step.run("resolve-recipient", async () => {
      const outcome = await resolveCommandRecipient({
        command,
        keepsUserId: account.userId,
        connectedAccountId: account.composioConnectedAccountId,
      });
      return outcome;
    });

    if (recipientStep.status === "ambiguous") {
      await step.run("send-ambiguous", async () => {
        const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
        if (ownerEmail) {
          const { subject, textBody } = buildConnectorAmbiguousEmail({
            recipientNameText: command.destination.nameText ?? "that person",
            candidates: recipientStep.result.candidates.map((c) => ({ name: c.name, email: c.email })),
            commandSummary: summarizeCommand(command),
          });
          await sendSystemEmail({ email: { to: ownerEmail, subject, textBody }, sender: getEmailSender() });
        }
        await new DrizzleConnectorAuditWriter().writeAudit({
          action: "connector.recipient_ambiguous",
          userId,
          metadata: { nameText: command.destination.nameText, count: recipientStep.result.candidates.length },
        });
      });
      return { ok: true, branch: "recipient_ambiguous" };
    }

    if (recipientStep.status === "not_found") {
      await step.run("send-not-found", async () => {
        const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
        if (ownerEmail) {
          const who = command.destination.nameText ?? command.destination.emailText ?? "that person";
          await sendSystemEmail({
            email: {
              to: ownerEmail,
              subject: `Couldn't find ${who} in Slack`,
              textBody: `I couldn't find ${who} in your Slack workspace, so I didn't send anything. Reply with their exact name or email and I'll try again.`,
            },
            sender: getEmailSender(),
          });
        }
      });
      return { ok: true, branch: "recipient_not_found" };
    }

    // ── (c) Build the frozen payload. calendar whenAt === null → clarify, stop.
    const payloadStep = await step.run("build-frozen-payload", async () => {
      return buildFrozenPayload({ command, recipient: recipientStep });
    });

    if (payloadStep.status === "needs_when") {
      await step.run("send-needs-when", async () => {
        const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
        if (ownerEmail) {
          const title = command.eventTitle ?? "that event";
          await sendSystemEmail({
            email: {
              to: ownerEmail,
              subject: `When should I add "${title}"?`,
              textBody: `I'd like to add "${title}" to your calendar, but I couldn't tell when. Reply with a specific date and time and I'll set it up.`,
            },
            sender: getEmailSender(),
          });
        }
        await new DrizzleConnectorAuditWriter().writeAudit({
          action: "connector.action_failed",
          userId,
          metadata: { reason: "calendar_when_missing", eventTitle: command.eventTitle },
        });
      });
      return { ok: true, branch: "needs_when" };
    }

    const frozenPayload = payloadStep.payload;
    const reversibility = classifyReversibility(frozenPayload);

    // ── (d) Create approval + connector_actions row. `now` minted in-step.
    const created = await step.run("create-approval-and-action", async () => {
      const now = new Date();
      const ttlMs = reversibility === "reversible" ? CONFIRM_WINDOW_TTL_MS : SEVEN_DAYS_MS;
      return createApprovalAndAction({
        command,
        payload: frozenPayload,
        account: { id: account.id, userId: account.userId } as ConnectorAccount,
        inboundEmailId,
        provider,
        approvals: new DrizzleApprovalRepository(),
        actions: new DrizzleConnectorActionsRepository(),
        now,
        ttlMs,
        // SUPPRESS approval.requested: this workflow OWNS the connector approval
        // lifecycle (its own approval email + waitForEvent + execute-once). The
        // Phase 3 handle-approval function also triggers on approval.requested —
        // if we broadcast it, every connector command would get a SECOND generic
        // approval email and an "I don't know how to run that action" reply
        // (executeApprovedDraft has no handler for slack_dm/calendar_event). The
        // approval.received this workflow waits on is emitted by decideApproval
        // (web decide route / reply handler), independent of approval.requested,
        // so suppression here is safe.
        emitEvent: async () => {},
      });
    });

    // ── (e) Gate by reversibility: send the right email, then waitForEvent.
    await step.run("send-approval-email", async () => {
      const env = getOptionalEnv();
      const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
      if (!ownerEmail) return;

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
              whenLocal: command.whenText ?? frozenPayload.whenAt ?? "",
              durationMinutes: frozenPayload.durationMinutes,
            };

      const { subject, textBody } = buildConnectorApprovalEmail({
        approvalId: created.approvalId,
        token: created.token,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        action,
      });

      // Reply-To plus-routes a plaintext "approve"/"cancel"/"edit" back to the
      // approval reply handler (the nudge mailbox-hash pattern from handle-approval).
      const replyTo = buildNudgeReplyTo(created.approvalId, env.POSTMARK_REPLY_TO_BASE);
      await sendApprovalReply(ownerEmail, subject, textBody, replyTo, getEmailSender());
    });

    const timeout = reversibility === "reversible" ? CONFIRM_WINDOW_TIMEOUT : HARD_APPROVAL_TIMEOUT;
    // CRITICAL: `match: "data.approvalId"` would compare the incoming approval.received
    // against the TRIGGERING event (connector.action_requested) — which has NO approvalId
    // (the approval is created at runtime inside this function). That match can never
    // succeed, so the function would wait until timeout and never execute. We instead use
    // an `if` expression binding the awaited event to the approval id we just created.
    const decided = await step.waitForEvent("wait-approval-decision", {
      event: "approval.received",
      if: `async.data.approvalId == "${created.approvalId}"`,
      timeout,
    });

    // Decide the effective decision.
    let decision: "approved" | "rejected" | "cancelled";
    if (decided === null) {
      // Timeout. For a reversible confirmation window this is AUTO-CONFIRM; for a
      // hard approval, a timeout means the approval expired with no decision → stop.
      if (reversibility !== "reversible") {
        await step.run("audit-approval-timeout", async () => {
          await new DrizzleConnectorAuditWriter().writeAudit({
            action: "connector.action_failed",
            userId,
            metadata: { connectorActionId: created.connectorActionId, reason: "approval_timeout" },
          });
        });
        return { ok: true, branch: "approval_timeout" };
      }
      // Reversible timeout → confirm: actually decide the approval row 'approved' via
      // channel:'cron' so the AR-7 gate in D2 sees an approved row before execute.
      await step.run("confirm-on-timeout", async () => {
        const now = new Date();
        await decideApproval({
          approvalId: created.approvalId,
          decision: "approved",
          channel: "cron",
          now,
          repository: new DrizzleApprovalRepository(),
        });
      });
      decision = "approved";
    } else {
      const d = decided.data.decision as "approved" | "rejected" | "cancelled" | "expired";
      if (d === "expired") {
        // The approval expired via the sweep — treat as no-go.
        await step.run("mark-cancelled-expired", async () => {
          await new DrizzleConnectorActionsRepository().markCancelled(created.connectorActionId);
        });
        return { ok: true, branch: "expired" };
      }
      decision = d;
    }

    // ── (f) Terminal handling.
    if (decision === "approved") {
      const executed = await step.run("execute-connector-action", async () => {
        const now = new Date();
        return executeConnectorAction({ connectorActionId: created.connectorActionId, now });
      });

      // Emit completed/failed in their own step (event send).
      await step.run("emit-execution-outcome", async () => {
        await emitOutcome({
          executed,
          userId,
          connectorActionId: created.connectorActionId,
          provider,
          kind: command.kind,
        });
      });

      // Confirmation one-liner.
      await step.run("confirm-executed", async () => {
        const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
        if (ownerEmail) {
          await sendSystemEmail({
            email: { to: ownerEmail, subject: "Re: Approval", textBody: executedConfirmationLine(executed) },
            sender: getEmailSender(),
          });
        }
      });

      return { ok: true, branch: "executed", executeStatus: executed.status };
    }

    // rejected / cancelled → mark the row cancelled, confirm, audit. NEVER executes.
    await step.run("cancel-connector-action", async () => {
      await new DrizzleConnectorActionsRepository().markCancelled(created.connectorActionId);
      const ownerEmail = await new DrizzleOwnerResolver().findOwnerEmail(userId);
      if (ownerEmail) {
        await sendSystemEmail({
          email: {
            to: ownerEmail,
            subject: "Re: Approval",
            textBody: decision === "rejected" ? "Got it — I won't run that." : "Cancelled — that action won't run.",
          },
          sender: getEmailSender(),
        });
      }
    });

    return { ok: true, branch: decision };
  },
);

// ---------------------------------------------------------------------------
// Wrapper-local helpers (thin transport glue, not pure cores)
// ---------------------------------------------------------------------------

/** Emits the right typed connector.* event for an execute-once outcome. */
async function emitOutcome(input: {
  executed: ExecuteConnectorActionResult;
  userId: string;
  connectorActionId: string;
  provider: "slack" | "google_calendar";
  kind: "slack_dm" | "calendar_event";
  emitEvent?: EmitEvent;
}): Promise<void> {
  const emit = input.emitEvent ?? sendEvent;
  const { executed } = input;
  if (executed.status === "completed") {
    await emit("connector.action_completed", {
      userId: input.userId,
      connectorActionId: input.connectorActionId,
      provider: input.provider,
      kind: input.kind,
      result: executed.result,
    });
    return;
  }
  if (executed.status === "denied" || executed.status === "failed") {
    await emit("connector.action_failed", {
      userId: input.userId,
      connectorActionId: input.connectorActionId,
      provider: input.provider,
      kind: input.kind,
      error: executed.error,
    });
  }
  // 'executing' / 'cancelled' / 'not_found' emit nothing (no terminal outcome here).
}

/** One-line confirmation for the user after an execute-once attempt. */
export function executedConfirmationLine(executed: ExecuteConnectorActionResult): string {
  switch (executed.status) {
    case "completed":
      return "Approved — done.";
    case "denied":
      return "Approved, but the action was blocked by policy. Nothing ran.";
    case "failed":
      return "Approved, but the action failed to run. I'll let you know if I can retry.";
    default:
      return "Approved.";
  }
}

/** Send-only helper for the approval email with a plus-routed Reply-To. */
async function sendApprovalReply(
  to: string,
  subject: string,
  textBody: string,
  replyTo: string,
  sender: EmailSender,
): Promise<void> {
  await sender.send({
    userId: null,
    nudgeId: null,
    to,
    subject,
    textBody,
    replyTo,
    headers: {},
  });
}
