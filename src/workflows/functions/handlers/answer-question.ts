import { buildDigest, type DigestLoopInput, type DigestUserInput } from "@/digests/build";
import { renderDigestEmail } from "@/digests/render";
import type { PersistedNudge, PrivateReplyNudgeMetadata } from "@/loops/service";
import type { KeepsWorkflowEvent } from "@/workflows/events";

/**
 * Question branch handler (Deliverable #9 / task C4).
 *
 * For an "insights" / "what are my open loops" / "status" question, this builds a
 * digest from the user's CURRENT loop state — works on a fresh inbound with no prior
 * nudge to map against (exit criterion). The digest-style reply nudge persists the
 * renderer's ordinal → loopId map in `metadata.ordinalMap` (AR-3) so a follow-up
 * "done 2" resolves against this answer. It then asks the caller to send the reply
 * and returns the `report.requested` + `email.classified` events to emit.
 *
 * Any non-insights question is handled by the router's polite fallback, NOT here.
 */

export type AnswerQuestionUser = DigestUserInput & {
  /** IANA timezone, used only for forward-compatible scheduling context. */
  timezone?: string;
};

export type AnswerQuestionPorts = {
  /** Loads the digest user (id, email, displayName) for `buildDigest`. */
  loadUser(userId: string): Promise<AnswerQuestionUser | null>;
  /** Loops eligible for the digest at `now` (DigestRepository.findLoopsForDigest). */
  findLoopsForDigest(userId: string, now: Date): Promise<DigestLoopInput[]>;
  /**
   * Persists the digest-style reply nudge carrying the ordinal map in metadata,
   * exactly as the command branch expects (so "done 2" later resolves). Mirrors the
   * shape of `createPrivateReplyNudge`.
   */
  createDigestReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge>;
};

export type AnswerQuestionInput = {
  userId: string;
  inboundEmailId: string;
  emailThreadId: string;
  now: Date;
  ports: AnswerQuestionPorts;
};

export type AnswerQuestionResult = {
  nudgeId: string;
  /** report.requested (stub) + email.classified, in emit order. */
  events: KeepsWorkflowEvent[];
};

export async function answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
  const { userId, inboundEmailId, emailThreadId, now, ports } = input;

  const user = (await ports.loadUser(userId)) ?? {
    id: userId,
    email: "",
    displayName: null,
  };

  const loops = await ports.findLoopsForDigest(userId, now);
  const model = buildDigest({ user: { id: user.id, email: user.email, displayName: user.displayName }, loops, now });
  const rendered = renderDigestEmail(model);

  const metadata: PrivateReplyNudgeMetadata = {
    kind: "private_reply",
    intent: "question",
    // The digest-answer reply doubles as a digest nudge for follow-up commands.
    nudgeType: "digest",
    loopCount: model.totalActiveLoops,
    lowConfidence: false,
    // AR-3: the renderer's ordinal → loopId map drives "done 2" / "snooze 1 until Monday".
    ordinalMap: rendered.ordinalToLoopId,
  };

  const nudge = await ports.createDigestReplyNudge({
    userId,
    inboundEmailId,
    subject: rendered.subject,
    body: rendered.textBody,
    metadata,
  });

  const reportRequested: KeepsWorkflowEvent = {
    name: "report.requested",
    data: {
      userId,
      kind: "insights",
      scope: {},
      requestedVia: "email_question",
      inboundEmailId,
      nudgeId: nudge.id,
    },
  };

  const classified: KeepsWorkflowEvent = {
    name: "email.classified",
    data: {
      inboundEmailId,
      emailThreadId,
      userId,
      intent: "question",
      branch: "question",
      loopCount: model.totalActiveLoops,
    },
  };

  return {
    nudgeId: nudge.id,
    events: [reportRequested, classified],
  };
}

/** True when the question body is an insights/status/open-loops request (Deliverable #9). */
export function isInsightsQuestion(body: string): boolean {
  return /what are my open loops/i.test(body) || /^insights\b/i.test(body.trim()) || /^status\b/i.test(body.trim());
}
