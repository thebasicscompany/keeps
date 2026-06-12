import { classifyEmailIntent, type EmailIntent } from "@/agent/classify-intent";
import type { NormalizedEmail } from "@/email/normalize";
import {
  applyLoopReplyCommand,
  processInboundEmailForLoops,
  type LoopProcessingRepository,
  type PersistedLoop,
  type Phase2WorkflowEvent,
} from "@/loops/service";
import { resolveReplyTarget, type ReplyTargetStore } from "@/loops/resolve-reply-target";

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
};

export type RouteEmailResult = {
  status: "processed" | "already_processed" | "missing_inbound_email";
  intent: EmailIntent | null;
  branch: RouterBranch | null;
  /** All workflow events to emit (capture phase-2 events plus the per-branch classified). */
  events: Phase2WorkflowEvent[];
  /** Loops touched by this run (created on capture, updated on command). */
  loops: PersistedLoop[];
  /** Nudge id of the private reply this run sent, if any. */
  nudgeId: string | null;
};

/**
 * Intent router (Deliverable 2 / task C2). Loads the inbound email, classifies it, and
 * dispatches one branch. Every branch emits `email.classified` (with `intent` + `branch`)
 * and produces a private reply through `sendReply`. The capture branch is guarded by the
 * persistence-level idempotency check inside `processInboundEmailForLoops`.
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

  const classified = (loopCount: number): RouterClassified => ({
    name: "email.classified",
    data: {
      inboundEmailId: email.id,
      emailThreadId: email.emailThreadId,
      userId: email.userId,
      intent,
      branch: intent,
      loopCount,
    },
  });

  switch (intent) {
    case "capture":
      return runCaptureBranch(inboundEmailId, deps);
    case "command":
      return runCommandBranch(email.normalized, email, deps, classified(0));
    case "correction":
      return runCorrectionBranch(email.normalized, email, deps, classified(0));
    case "question":
      return runStubBranch(email, deps, classified(0), "I will handle questions when Phase 3 ships.");
    case "approval":
      return runStubBranch(email, deps, classified(0), "Approvals land in Phase 3.");
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
): Promise<RouteEmailResult> {
  const target = await resolveReplyTarget(normalized, { store: deps.replyTargetStore });

  if (!target) {
    return finishStub(
      email,
      deps,
      classified,
      "I could not tell which nudge you meant. Reply directly to the nudge that listed the loop.",
    );
  }

  const commandText = normalized.strippedTextReply ?? normalized.textBody;
  const applied = await applyLoopReplyCommand({
    userId: email.userId,
    emailThreadId: email.emailThreadId,
    text: commandText,
    repository: deps.repository,
    loops: target.loops,
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
): Promise<RouteEmailResult> {
  const target = await resolveReplyTarget(normalized, { store: deps.replyTargetStore });
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

async function runStubBranch(
  email: RoutableEmail,
  deps: RouterDeps,
  classified: RouterClassified,
  body: string,
): Promise<RouteEmailResult> {
  return finishStub(email, deps, classified, body);
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
    intent: classified.data.intent,
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

function replySubject(subject: string): string {
  return subject ? (subject.startsWith("Re:") ? subject : `Re: ${subject}`) : "Re: your Keeps loop";
}
