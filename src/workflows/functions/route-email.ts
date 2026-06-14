import {
  classifyEmailIntent,
  classifyInsightCommand,
  type EmailIntent,
} from "@/agent/classify-intent";
import type { ApprovalRepository } from "@/approvals/repository";
import type { NormalizedEmail } from "@/email/normalize";
import { parseLoopReplyCommand } from "@/loops/commands";
import { parseReconcileConfirmReply } from "@/loops/reconcile-reply";
import {
  applyLoopReplyCommand,
  processInboundEmailForLoops,
  type LoopProcessingRepository,
  type PersistedLoop,
  type Phase2WorkflowEvent,
} from "@/loops/service";
import {
  resolveReplyTarget,
  type ReplyTargetStore,
  type ResolvedReplyTarget,
} from "@/loops/resolve-reply-target";
import type { ConnectorCommandDraft } from "@/agent/schemas";
import type { EventMap, KeepsWorkflowEvent } from "@/workflows/events";
import {
  answerQuestion,
  isInsightsQuestion,
  type AnswerQuestionPorts,
} from "@/workflows/functions/handlers/answer-question";
import {
  handleApprovalReply,
  type ApprovalReplyAudit,
} from "@/workflows/functions/handlers/handle-approval-reply";
import { handleReconcileConfirm } from "@/workflows/functions/handlers/reconcile-confirm";

/**
 * Branch label recorded on `email.classified`. Mirrors `intent` today but is kept
 * distinct so a future multi-intent email can dispatch a different branch than the
 * single classified intent (forward compatibility, see Events section of the plan).
 *
 * 'connector_command' is a sub-branch of 'command' — the intent field on
 * email.classified carries 'command', but branch carries 'connector_command' so
 * downstream consumers can distinguish connector commands from loop commands.
 */
export type RouterBranch = EmailIntent | "connector_command" | "insight_command";

export type RouterClassified = {
  name: "email.classified";
  data: {
    inboundEmailId: string;
    emailThreadId: string;
    userId: string;
    intent: EmailIntent;
    branch: RouterBranch;
    loopCount: number;
  };
};

/**
 * Side-effect ports the router composes. The Inngest wrapper binds Drizzle-backed
 * implementations; unit tests pass in-memory fakes (matching the rest of the codebase,
 * which never touches a live Postgres in tests).
 */
export type RouterDeps = {
  repository: LoopProcessingRepository;
  replyTargetStore: ReplyTargetStore;
  /** Persists+sends the private reply for a nudge id; returns nothing the router needs. */
  sendReply: (nudgeId: string) => Promise<void>;
  useModel?: boolean;
  now?: Date;
  /**
   * Approval reply ports (Deliverable #13). Optional so pre-C4 callers/tests that never
   * exercise the approval branch don't have to provide them; when an inbound reply
   * resolves to an approval nudge but these are absent, the router degrades to the
   * polite stub rather than throwing.
   */
  approvalRepository?: ApprovalRepository;
  approvalAudit?: ApprovalReplyAudit;
  /**
   * Event emitter for the approval decision (approval.received). Optional — defaults to
   * the live Inngest sendEvent inside decideApproval. Tests inject a fake so they never
   * touch Inngest.
   */
  approvalEmit?: <K extends keyof EventMap>(name: K, data: EventMap[K]) => Promise<void>;
  /**
   * Question/insights ports (Deliverable #9). Optional for the same reason; absent →
   * the question branch degrades to the polite fallback even for an insights request.
   */
  questionPorts?: AnswerQuestionPorts;
  /**
   * Connector command parser (Phase 4 B4). Optional port — when absent the connector
   * branch degrades to a polite stub ("Connector commands land soon.") so pre-B4
   * callers and tests that never exercise the connector branch don't have to provide it.
   *
   * The real implementation lives at src/agent/parse-connector-command.ts (parallel
   * task B3). process-email.ts wires the real parser here; tests inject a fake.
   *
   * Signature mirrors parseConnectorCommand from B3:
   *   input.emailBody — the stripped/plain body text
   *   input.now       — current timestamp for relative time resolution
   *   input.timezone  — IANA timezone string (optional; defaults to UTC in the parser)
   *   options.useModel — whether to call the AI model (false in tests / deterministic mode)
   */
  parseConnectorCommand?: (
    input: { emailBody: string; now: Date; timezone?: string },
    options: { useModel: boolean },
  ) => Promise<ConnectorCommandDraft>;
  /**
   * Insight-command port (Phase 5 / task C2). Returns the distinct participant
   * names + emails across the user's currently-tracked loops. Used to (a) resolve
   * entity-scoped insight commands deterministically without a model and (b) build
   * the "did you mean…" clarification when an entity matches no tracked participant.
   * Optional so pre-Phase-5 callers / tests that never exercise an entity command
   * don't have to provide it; absent → entity commands fall back to the model (if
   * useModel) or a generic clarification reply.
   */
  listTrackedParticipants?: (userId: string) => Promise<string[]>;
  /**
   * Entity-graph lookup port (Phase 7 C2). Resolves a raw entity-candidate string
   * (name, email, or domain) to an existing entity-graph id for the recall view.
   * READ-ONLY — never creates an entity. Optional: absent → no entityId is set on
   * the emitted scope, so the report falls back to the legacy substring filter.
   */
  findEntityByQuery?: (input: { userId: string; query: string }) => Promise<{ id: string; displayName: string; kind: string } | null>;
};

export type RouteEmailResult = {
  status: "processed" | "already_processed" | "missing_inbound_email";
  intent: EmailIntent | null;
  branch: RouterBranch | null;
  /** All workflow events to emit (capture phase-2 events plus the per-branch classified). */
  events: KeepsWorkflowEvent[];
  /** Loops touched by this run (created on capture, updated on command). */
  loops: PersistedLoop[];
  /** Nudge id of the private reply this run sent, if any. */
  nudgeId: string | null;
};

/**
 * Intent router (Deliverable 2 / task C2; extended in C4). Loads the inbound email,
 * classifies it, and dispatches one branch. Every branch emits `email.classified`
 * (with `intent` + `branch`) and produces a private reply through `sendReply`. The
 * capture branch is guarded by the persistence-level idempotency check inside
 * `processInboundEmailForLoops`.
 *
 * DISPATCH PRECEDENCE (C4 — important):
 *   1. NUDGE-TYPE DISPATCH runs FIRST. We resolve the inbound reply to its source
 *      nudge (MailboxHash → nudge) BEFORE honoring the classified intent. If that
 *      nudge's persisted metadata carries an `approvalId` (nudge_type 'approval'),
 *      the reply is routed to the approval handler REGARDLESS of what classify-intent
 *      labeled it (e.g. "edit: ..." classifies as correction, "no thanks" as capture —
 *      both must still reach the approval handler). This is gotcha 6: the approvalId is
 *      always read from the nudge metadata, never from a fresh listing.
 *   2. INTENT DISPATCH runs only for emails that do NOT reference an approval nudge.
 *      Capture / command / correction / question branches behave as in C2, plus:
 *        - a free-text reply to a DIGEST nudge that is not a recognized loop command
 *          and is not a question falls through to the CAPTURE branch (AR-9), so a
 *          brain-dump reply to the digest creates loops.
 */
export async function routeEmail(inboundEmailId: string, deps: RouterDeps): Promise<RouteEmailResult> {
  const email = await deps.repository.findInboundEmailById(inboundEmailId);

  if (!email) {
    return {
      status: "missing_inbound_email",
      intent: null,
      branch: null,
      events: [],
      loops: [],
      nudgeId: null,
    };
  }

  const classification = classifyEmailIntent({
    body: email.normalized.textBody,
    subject: email.normalized.subject,
  });
  const intent = classification.intent;

  const classified = (branch: RouterBranch, loopCount: number): RouterClassified => ({
    name: "email.classified",
    data: {
      inboundEmailId: email.id,
      emailThreadId: email.emailThreadId,
      userId: email.userId,
      intent,
      branch,
      loopCount,
    },
  });

  // ---- (1) NUDGE-TYPE DISPATCH — precedes intent dispatch ----
  // Resolve the reply target once and reuse it for nudge-type and command dispatch.
  const target = await resolveReplyTarget(email.normalized, { store: deps.replyTargetStore });

  if (target?.metadata.approvalId) {
    return runApprovalBranch(email, deps, classified("approval", 0), target.metadata.approvalId);
  }

  // Reconcile-confirm nudge-type dispatch (Phase 7 B2c): when the originating nudge
  // carries pending suppressed-duplicate asks AND this reply parses as a YES/NO answer,
  // resolve the merge / keep-separate BEFORE intent dispatch — same precedence rule as
  // approvalId (nudge-type dispatch precedes intent dispatch). This only fires when the
  // nudge actually posed an ask, so a bare "YES"/"NO" elsewhere is untouched; and only
  // when the answer is recognizably YES/NO, so an ordinary command ("done 1") on a nudge
  // that HAS pending asks still parses as a normal command (parseReconcileConfirmReply
  // returns null → no hijack).
  const replyText = email.normalized.strippedTextReply ?? email.normalized.textBody;
  const pending = target?.metadata.pendingReconciliations ?? [];
  if (pending.length > 0) {
    const answer = parseReconcileConfirmReply(replyText);
    if (answer) {
      return runReconcileConfirmBranch(email, deps, classified("command", 0), answer, pending);
    }
  }

  // ---- (2) INTENT DISPATCH ----
  // Connector-command sub-branch: checked BEFORE the generic command switch so that
  // @Slack / @Calendar emails never fall into the loop-command branch.
  if (classification.subtype === "connector_command") {
    return runConnectorCommandBranch(email, deps, classified("connector_command", 0));
  }

  // Insight-command sub-branch (Phase 5 / C2): "what are my insights?", "what is
  // stale?", "weekly summary", "show Acme loops", etc. Resolves kind+scope and emits
  // report.requested for the generate-report function, which produces the report and
  // sends the private reply (so this branch sends no inline digest reply).
  if (classification.subtype === "insight_command") {
    return runInsightCommandBranch(email, deps, classified("insight_command", 0));
  }

  switch (intent) {
    case "capture":
      return runCaptureBranch(inboundEmailId, deps);
    case "command":
      return runCommandBranch(email.normalized, email, deps, classified("command", 0), target);
    case "correction":
      return runCorrectionBranch(email.normalized, email, deps, classified("correction", 0), target);
    case "question":
      return runQuestionBranch(email, deps, classified("question", 0));
    case "approval":
      // An "approve"-style email that does NOT reference an approval nudge: there is no
      // approval to decide. Fall back to the polite stub (unchanged from C2 behavior).
      return finishStub(email, deps, classified("approval", 0), "Approvals land in Phase 3.");
  }
}

type RoutableEmail = NonNullable<Awaited<ReturnType<LoopProcessingRepository["findInboundEmailById"]>>>;

// ---------------------------------------------------------------------------
// Connector command branch (Phase 4 B4)
// ---------------------------------------------------------------------------

async function runConnectorCommandBranch(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
): Promise<RouteEmailResult> {
  // If the parser port is absent (pre-B3 callers, tests that don't wire it),
  // degrade to a polite stub so existing tests remain green.
  if (!deps.parseConnectorCommand) {
    return finishStub(email, deps, classified, "Connector commands land soon.");
  }

  const emailBody = email.normalized.strippedTextReply ?? email.normalized.textBody;
  const timezone = await resolveUserTimezone(deps, email.userId);

  const command = await deps.parseConnectorCommand(
    { emailBody, now: deps.now ?? new Date(), timezone },
    { useModel: deps.useModel ?? false },
  );

  // Build the connector.action_requested event. The connector_actions row is
  // created at EXECUTE time by Wave D (connector_account_id is NOT NULL so the
  // row cannot exist before an account is resolved). The parsed command travels
  // inline so the handler has everything it needs to proceed.
  const actionRequestedEvent: KeepsWorkflowEvent = {
    name: "connector.action_requested",
    data: {
      userId: email.userId,
      inboundEmailId: email.id,
      emailThreadId: email.emailThreadId,
      provider: command.provider,
      kind: command.kind,
      command,
    },
  };

  // The downstream connector workflow owns ALL user-facing replies (connect-link /
  // clarification / approval email). This branch sends no nudge itself.
  return {
    status: "processed",
    intent: "command",
    branch: "connector_command",
    events: [classified, actionRequestedEvent],
    loops: [],
    nudgeId: null,
  };
}

// ---------------------------------------------------------------------------
// Insight command branch (Phase 5 C2)
// ---------------------------------------------------------------------------

async function runInsightCommandBranch(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
): Promise<RouteEmailResult> {
  const body = email.normalized.strippedTextReply ?? email.normalized.textBody;
  const knownParticipants = deps.listTrackedParticipants
    ? await deps.listTrackedParticipants(email.userId)
    : [];

  const classification = await classifyInsightCommand(body, {
    useModel: deps.useModel ?? false,
    knownParticipants,
  });

  // Unresolved entity (deterministic patterns matched an entity shape but it maps to
  // no tracked participant and the model could not resolve it): send a clarification
  // reply instead of generating a wrong/empty report.
  if (classification.kind === "unknown") {
    const suggestions = knownParticipants.slice(0, 3);
    const reply =
      suggestions.length > 0
        ? `I do not see any loops matching that. Did you mean one of these: ${suggestions.join(", ")}?`
        : 'I could not tell which loops you meant. Try "what are my insights?", "what is stale?", or "what am I waiting on?".';
    return finishStub(email, deps, classified, reply);
  }

  // For entity queries: attempt to resolve the raw candidate string to an existing
  // entity-graph id (Phase 7 C2). This is read-only and conservative — if it resolves,
  // scope.entityId is set so generate-report uses assembleEntityReport (real graph view).
  // If it does NOT resolve (or the port is absent), we keep the existing scope (entity
  // string only) which falls back to the participant-list substring match inside
  // assembleReport. The port is injected by process-email.ts in production and by tests;
  // absent means no entity-graph lookup (graceful degradation, no live DB call here).
  let resolvedScope = classification.scope as Record<string, unknown>;
  if (classification.kind === "entity" && "entity" in classification.scope && deps.findEntityByQuery) {
    const entityCandidate = (classification.scope as { entity: string }).entity;
    const resolved = await deps.findEntityByQuery({ userId: email.userId, query: entityCandidate });
    if (resolved) {
      resolvedScope = { ...resolvedScope, entityId: resolved.id };
    }
  }

  // Emit the canonical report.requested; generate-report builds the report and sends
  // the private reply (with the /r/<token> link). No inline reply nudge here.
  const reportRequested: KeepsWorkflowEvent = {
    name: "report.requested",
    data: {
      userId: email.userId,
      kind: classification.kind,
      scope: resolvedScope,
      requestedVia: "email_command",
      inboundEmailId: email.id,
    },
  };

  return {
    status: "processed",
    intent: "command",
    branch: "insight_command",
    events: [classified, reportRequested],
    loops: [],
    nudgeId: null,
  };
}

async function runCaptureBranch(inboundEmailId: string, deps: RouterDeps): Promise<RouteEmailResult> {
  const result = await processInboundEmailForLoops({
    inboundEmailId,
    repository: deps.repository,
    useModel: deps.useModel,
  });

  if (result.status === "already_processed") {
    return {
      status: "already_processed",
      intent: "capture",
      branch: "capture",
      events: [],
      loops: result.loops,
      nudgeId: null,
    };
  }

  if (result.status === "missing_inbound_email") {
    return {
      status: "missing_inbound_email",
      intent: "capture",
      branch: "capture",
      events: [],
      loops: [],
      nudgeId: null,
    };
  }

  await deps.sendReply(result.nudgeId);

  return {
    status: "processed",
    intent: "capture",
    branch: "capture",
    events: result.events,
    loops: result.loops,
    nudgeId: result.nudgeId,
  };
}

async function runCommandBranch(
  normalized: NormalizedEmail,
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
  target: ResolvedReplyTarget | null,
): Promise<RouteEmailResult> {
  if (!target) {
    return finishStub(
      email,
      deps,
      classified,
      "I could not tell which nudge you meant. Reply directly to the nudge that listed the loop.",
    );
  }

  const commandText = normalized.strippedTextReply ?? normalized.textBody;
  const timezone = await resolveUserTimezone(deps, email.userId);

  // AR-9 digest free-text fallthrough: a reply to a digest nudge that does NOT parse to
  // a recognized loop command is a brain dump — route it through the capture/extraction
  // path so it creates loops. A recognized command ("done 2") still runs the command
  // branch below, resolving ordinals from the digest nudge's stored map.
  if (isDigestNudge(target) && parseLoopReplyCommand(commandText, { timezone }).type === "unknown") {
    return runCaptureBranch(email.id, deps);
  }

  const applied = await applyLoopReplyCommand({
    userId: email.userId,
    emailThreadId: email.emailThreadId,
    text: commandText,
    repository: deps.repository,
    loops: target.loops,
    timezone,
    now: deps.now,
  });

  const nudge = await deps.repository.createReplyNudge({
    userId: email.userId,
    inboundEmailId: email.id,
    subject: replySubject(normalized.subject),
    body: applied.reply,
    intent: "command",
  });
  await deps.sendReply(nudge.id);

  return {
    status: "processed",
    intent: "command",
    branch: "command",
    events: [classified, ...applied.events],
    loops: applied.updatedLoops,
    nudgeId: nudge.id,
  };
}

async function runCorrectionBranch(
  normalized: NormalizedEmail,
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
  target: ResolvedReplyTarget | null,
): Promise<RouteEmailResult> {
  const commandText = normalized.strippedTextReply ?? normalized.textBody;
  const targetLoop = target?.loops[0] ?? null;

  if (targetLoop) {
    await deps.repository.recordLoopCorrection({
      userId: email.userId,
      loopId: targetLoop.id,
      commandText,
    });
  }

  return finishStub(email, deps, classified, "Got it — I will use that correction.");
}

async function runQuestionBranch(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
): Promise<RouteEmailResult> {
  const body = email.normalized.strippedTextReply ?? email.normalized.textBody;

  // Only insights/status/open-loops questions get the digest answer; the question ports
  // must be wired for it. Anything else (or missing ports) → polite fallback.
  if (isInsightsQuestion(body) && deps.questionPorts) {
    const answer = await answerQuestion({
      userId: email.userId,
      inboundEmailId: email.id,
      emailThreadId: email.emailThreadId,
      now: deps.now ?? new Date(),
      ports: deps.questionPorts,
    });
    await deps.sendReply(answer.nudgeId);

    return {
      status: "processed",
      intent: "question",
      branch: "question",
      events: answer.events,
      loops: [],
      nudgeId: answer.nudgeId,
    };
  }

  return finishStub(
    email,
    deps,
    classified,
    "I can't answer that yet — I'll learn to in a future update.",
  );
}

async function runApprovalBranch(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
  approvalId: string,
): Promise<RouteEmailResult> {
  if (!deps.approvalRepository) {
    return finishStub(email, deps, classified, "Approvals land in Phase 3.");
  }

  const text = email.normalized.strippedTextReply ?? email.normalized.textBody;
  const result = await handleApprovalReply({
    userId: email.userId,
    approvalId,
    text,
    now: deps.now ?? new Date(),
    repository: deps.approvalRepository,
    audit: deps.approvalAudit,
    emitEvent: deps.approvalEmit,
  });

  return finishStub(email, deps, classified, result.reply);
}

async function runReconcileConfirmBranch(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
  answer: "same" | "different",
  pending: { suppressedLoopId: string; candidateLoopId: string }[],
): Promise<RouteEmailResult> {
  const commandText = email.normalized.strippedTextReply ?? email.normalized.textBody;
  const result = await handleReconcileConfirm({
    userId: email.userId,
    answer,
    pendingReconciliations: pending,
    commandText,
    sourceInboundEmailId: email.id,
    repository: deps.repository,
  });

  const nudge = await deps.repository.createReplyNudge({
    userId: email.userId,
    inboundEmailId: email.id,
    subject: replySubject(email.normalized.subject),
    body: result.reply,
    intent: "command",
  });
  await deps.sendReply(nudge.id);

  return {
    status: "processed",
    intent: "command",
    branch: "command",
    events: [classified, ...result.events],
    loops: [],
    nudgeId: nudge.id,
  };
}

async function finishStub(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
  body: string,
): Promise<RouteEmailResult> {
  const nudge = await deps.repository.createReplyNudge({
    userId: email.userId,
    inboundEmailId: email.id,
    subject: replySubject(email.normalized.subject),
    body,
    intent: classified.data.branch,
  });
  await deps.sendReply(nudge.id);

  return {
    status: "processed",
    intent: classified.data.intent,
    branch: classified.data.branch,
    events: [classified],
    loops: [],
    nudgeId: nudge.id,
  };
}

/** A resolved reply target is a digest nudge when it lists loops but is not an approval. */
function isDigestNudge(target: ResolvedReplyTarget): boolean {
  if (target.metadata.approvalId) {
    return false;
  }
  if (target.metadata.nudgeType === "digest") {
    return true;
  }
  // Fallback: any non-approval nudge carrying an ordinal map behaves like a digest for
  // free-text fallthrough purposes (the digest and the capture private-reply share the
  // same ordinal-map metadata shape).
  return Object.keys(target.metadata.ordinalMap).length > 0;
}

async function resolveUserTimezone(deps: RouterDeps, userId: string): Promise<string | undefined> {
  if (!deps.repository.findUserTimezone) {
    return undefined;
  }
  return (await deps.repository.findUserTimezone(userId)) ?? undefined;
}

function replySubject(subject: string): string {
  return subject ? (subject.startsWith("Re:") ? subject : `Re: ${subject}`) : "Re: your Keeps loop";
}
