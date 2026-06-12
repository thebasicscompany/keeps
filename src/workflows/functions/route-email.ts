import { classifyEmailIntent, type EmailIntent } from "@/agent/classify-intent";
import type { ApprovalRepository } from "@/approvals/repository";
import type { NormalizedEmail } from "@/email/normalize";
import { parseLoopReplyCommand } from "@/loops/commands";
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

/**
 * Branch label recorded on `email.classified`. Mirrors `intent` today but is kept
 * distinct so a future multi-intent email can dispatch a different branch than the
 * single classified intent (forward compatibility, see Events section of the plan).
 */
export type RouterBranch = EmailIntent;

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

  const intent = classifyEmailIntent({
    body: email.normalized.textBody,
    subject: email.normalized.subject,
  }).intent;

  const classified = (branchIntent: EmailIntent, loopCount: number): RouterClassified => ({
    name: "email.classified",
    data: {
      inboundEmailId: email.id,
      emailThreadId: email.emailThreadId,
      userId: email.userId,
      intent,
      branch: branchIntent,
      loopCount,
    },
  });

  // ---- (1) NUDGE-TYPE DISPATCH — precedes intent dispatch ----
  // Resolve the reply target once and reuse it for nudge-type and command dispatch.
  const target = await resolveReplyTarget(email.normalized, { store: deps.replyTargetStore });

  if (target?.metadata.approvalId) {
    return runApprovalBranch(email, deps, classified("approval", 0), target.metadata.approvalId);
  }

  // ---- (2) INTENT DISPATCH ----
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
