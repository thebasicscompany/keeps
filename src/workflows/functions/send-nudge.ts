/**
 * send-nudge — Inngest function triggered by 'loop.nudge_due'.
 *
 * Architecture mirrors send-activation-email.ts exactly:
 *   - Pure core functions: checkNudge → composeNudge → (steps) createNudgeRow,
 *     send-only, record.
 *   - No step.sleepUntil (AR-5).
 *   - Reply-To is a top-level OutboundEmail field, never inside Headers (Postmark rule).
 *   - PRIVACY GUARD: nudges are NEVER addressed to a non-owner address.
 *     `to` is always resolved from users.email (the Clerk-verified primary email).
 *   - AR-3: ordinal→loopId mapping persisted in nudges.metadata under `ordinalMap`
 *     (the exact key that asPrivateReplyMetadata in resolve-reply-target.ts reads).
 *
 * Idempotency: we do NOT set a custom Inngest idempotency key so that future
 * legitimate nudges for the same loop are not suppressed. Instead, the in-function
 * re-validation (checkNudge) is the authoritative guard against double-sends.
 */

import { randomUUID } from "node:crypto";
import { getOptionalEnv } from "@/config/env";
import { buildNudgeReplyTo, type OutboundEmail, type OutboundEmailStore } from "@/email/outbound";
import { DrizzleOutboundEmailStore } from "@/email/outbound";
import { getEmailSender } from "@/email/sender-factory";
import type { NudgeCandidate, NudgeRepository } from "@/nudges/repository";
import { DrizzleNudgeRepository } from "@/nudges/repository";
import { advanceNextCheckAt, isEligibleForNudge } from "@/nudges/selectors";
import { startOfLocalDay } from "@/users/timezone";
import { MAX_NUDGES_PER_USER_PER_DAY } from "@/nudges/policy";
import type { EventMap } from "@/workflows/events";
import { inngest } from "@/workflows/client";
import type { EmailSender } from "@/email/outbound";
import { withInngestSentry } from "@/observability/inngest-sentry";

// ---------------------------------------------------------------------------
// AR-3 metadata shape — must match asPrivateReplyMetadata in resolve-reply-target.ts
// ---------------------------------------------------------------------------

/**
 * Metadata stored on the nudges row. The `ordinalMap` key is what
 * `asPrivateReplyMetadata` in `src/loops/resolve-reply-target.ts` reads to
 * resolve reply ordinals back to loop ids.
 */
export type NudgeMetadata = {
  kind: "nudge";
  loopCount: number;
  /** 1-based ordinal (as listed in the email body) → loop id. AR-3. */
  ordinalMap: Record<number, string>;
  inngestRunId?: string;
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type CheckNudgeResult =
  | { status: "suppressed_not_found" }
  | { status: "suppressed_ineligible"; reason: string }
  | { status: "suppressed_daily_cap" }
  | { status: "clear"; loop: NudgeCandidate; toEmail: string };

export type SendNudgeResult =
  | { status: "suppressed_not_found" }
  | { status: "suppressed_ineligible"; reason: string }
  | { status: "suppressed_daily_cap" }
  | { status: "sent"; nudgeId: string; providerMessageId: string };

// ---------------------------------------------------------------------------
// Phase A: check — reload loop, re-validate eligibility + daily cap
// ---------------------------------------------------------------------------

/**
 * Re-validates that a loop is still eligible for a nudge.
 * Sweep emission is a hint; this check is authoritative (Deliverable #5).
 *
 * `now` MUST be injected from inside an Inngest step.
 */
export async function checkNudge(
  loopId: string,
  options: {
    repository: NudgeRepository;
    now: Date;
  },
): Promise<CheckNudgeResult> {
  const { repository, now } = options;

  const loop = await repository.findCandidateById(loopId);
  if (!loop) {
    return { status: "suppressed_not_found" };
  }

  if (!isEligibleForNudge(loop, { now })) {
    return { status: "suppressed_ineligible", reason: "isEligibleForNudge returned false" };
  }

  // Re-check daily cap
  const startOfDay = startOfLocalDay(loop.userTimezone, now);
  const sentTodayCount = await repository.countNudgesSentSince(loop.userId, startOfDay);
  if (sentTodayCount >= MAX_NUDGES_PER_USER_PER_DAY) {
    return { status: "suppressed_daily_cap" };
  }

  // Resolve owner email — PRIVACY GUARD: always use users.email (Clerk-verified)
  const toEmail = await repository.findUserEmail(loop.userId);
  if (!toEmail) {
    return { status: "suppressed_not_found" };
  }

  return { status: "clear", loop, toEmail };
}

// ---------------------------------------------------------------------------
// Phase B: compose — build email content + metadata (pure, no I/O)
// ---------------------------------------------------------------------------

export type ComposedNudge = {
  subject: string;
  textBody: string;
  /** AR-3: ordinal→loopId map for reply resolution. */
  metadata: NudgeMetadata;
};

/**
 * Composes the nudge email subject, text body, and AR-3 metadata.
 * Pure function — no I/O.
 */
export function composeNudge(loop: NudgeCandidate): ComposedNudge {
  const summaryTruncated =
    loop.summary.length > 60 ? `${loop.summary.slice(0, 57)}…` : loop.summary;

  const subject = `Checking in: ${summaryTruncated}`;

  const textBody = [
    `Just checking in on this:`,
    ``,
    `  1. ${loop.summary}`,
    ``,
    `Reply with one of these commands:`,
    `  done 1         — mark it complete`,
    `  snooze 1 until Monday  — remind me later`,
    `  dismiss 1      — remove from tracking`,
    ``,
    `— Keeps`,
  ].join("\n");

  // AR-3: ordinalMap uses the exact key that asPrivateReplyMetadata reads.
  const metadata: NudgeMetadata = {
    kind: "nudge",
    loopCount: 1,
    ordinalMap: { 1: loop.id },
  };

  return { subject, textBody, metadata };
}

// ---------------------------------------------------------------------------
// Combined pure flow (used directly in tests via injected fakes)
// ---------------------------------------------------------------------------

/**
 * Full nudge flow: check → compose → createNudgeRow → send-only → record.
 *
 * The Inngest wrapper splits this into four steps for retry safety; this
 * function composes the same pieces in order for test use.
 */
export async function sendNudgeEmail(
  loopId: string,
  options: {
    repository: NudgeRepository;
    sender: EmailSender;
    store: OutboundEmailStore;
    replyToBase: string;
    now: Date;
    inngestRunId?: string;
  },
): Promise<SendNudgeResult> {
  const { repository, sender, store, replyToBase, now, inngestRunId } = options;

  // Phase A: check
  const checkResult = await checkNudge(loopId, { repository, now });
  if (checkResult.status !== "clear") {
    return checkResult;
  }
  const { loop, toEmail } = checkResult;

  // Phase B: compose
  const composed = composeNudge(loop);
  const metadataWithRunId: NudgeMetadata = inngestRunId
    ? { ...composed.metadata, inngestRunId }
    : composed.metadata;

  // Phase C: create nudge row (status=pending)
  const nudgeRow = await repository.createNudgeRow({
    userId: loop.userId,
    loopId: loop.id,
    inboundEmailId: null,
    subject: composed.subject,
    body: composed.textBody,
    type: "nudge",
    metadata: metadataWithRunId as unknown as Record<string, unknown>,
    scheduledFor: null,
  });
  const nudgeId = nudgeRow.id;

  // Phase D: send-only — NO DB writes in this phase
  const replyTo = buildNudgeReplyTo(nudgeId, replyToBase);
  const mailboxHash = `n_${nudgeId}`;

  const email: OutboundEmail = {
    userId: loop.userId,
    nudgeId,
    to: toEmail,
    subject: composed.subject,
    textBody: composed.textBody,
    // Reply-To is a top-level field — never inside headers (Postmark rule)
    replyTo,
    mailboxHash,
  };

  const { providerMessageId } = await sender.send(email);

  // Phase E: record — DB writes after confirmed send
  const outboundId = randomUUID();
  await store.recordSend({
    id: outboundId,
    userId: loop.userId,
    nudgeId,
    provider: sender.provider,
    providerMessageId,
    toEmail,
    subject: composed.subject,
    textBody: composed.textBody,
    headers: {},
    replyTo,
    inReplyTo: null,
    referencesHeader: null,
    mailboxHash,
  });

  await store.markNudgeSent({ nudgeId, sentAt: now });

  await repository.markLoopNudged({
    loopId: loop.id,
    nextCheckAt: advanceNextCheckAt(loop, now),
    now,
  });

  await repository.writeLoopEvent({
    userId: loop.userId,
    loopId: loop.id,
    eventType: "nudged",
    metadata: { nudgeId, inngestRunId },
  });

  await repository.writeAudit({
    userId: loop.userId,
    action: "nudge.sent",
    metadata: {
      nudgeId,
      loopId: loop.id,
      providerMessageId,
      inngestRunId,
    },
  });

  return { status: "sent", nudgeId, providerMessageId };
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding of Drizzle ports to the pure core
// ---------------------------------------------------------------------------

export const sendNudgeFunction = inngest.createFunction(
  {
    id: "send-nudge",
    triggers: { event: "loop.nudge_due" },
    // No custom idempotency key — rely on in-function re-validation so future
    // legitimate nudges for the same loop are not suppressed by Inngest dedup.
  },
  async ({ event, step, runId }) => withInngestSentry(
    { functionId: "send-nudge", eventId: event.id },
    async () => {
    const loopId = (event.data as EventMap["loop.nudge_due"]).loopId;

    // Step 1: check — re-validate eligibility + daily cap with a fresh `now`.
    // Return only serialisation-safe primitives (strings, numbers) so Inngest's
    // JSON memoisation round-trip doesn't corrupt Date fields in subsequent steps.
    const checkResult = await step.run("check-nudge", async () => {
      const now = new Date();
      const result = await checkNudge(loopId, {
        repository: new DrizzleNudgeRepository(),
        now,
      });
      if (result.status !== "clear") {
        return { status: result.status } as Exclude<CheckNudgeResult, { status: "clear" }>;
      }
      // Return only primitive fields to avoid Date serialisation issues.
      return {
        status: "clear" as const,
        userId: result.loop.userId,
        toEmail: result.toEmail,
      };
    });

    if (checkResult.status !== "clear") {
      return { ok: true, ...checkResult };
    }

    // Step 2: create-nudge-row — reload loop (fresh Dates), compose, insert pending row.
    const nudgeRowResult = await step.run("create-nudge-row", async () => {
      const now = new Date();
      const repository = new DrizzleNudgeRepository();
      const loop = await repository.findCandidateById(loopId);
      if (!loop) {
        throw new Error(`send-nudge: loop ${loopId} disappeared before create-nudge-row step`);
      }
      const composed = composeNudge(loop);
      const nudgeRow = await repository.createNudgeRow({
        userId: loop.userId,
        loopId: loop.id,
        inboundEmailId: null,
        subject: composed.subject,
        body: composed.textBody,
        type: "nudge",
        metadata: { ...composed.metadata, inngestRunId: runId } as unknown as Record<string, unknown>,
        scheduledFor: null,
      });
      return {
        nudgeId: nudgeRow.id,
        subject: composed.subject,
        textBody: composed.textBody,
        nowIso: now.toISOString(),
      };
    });

    // Step 3: send-only — Postmark/dev call with NO DB writes.
    const sendResult = await step.run("send-nudge-email", async () => {
      const env = getOptionalEnv();
      const sender = getEmailSender();
      const replyTo = buildNudgeReplyTo(nudgeRowResult.nudgeId, env.POSTMARK_REPLY_TO_BASE);

      const email: OutboundEmail = {
        userId: checkResult.userId,
        nudgeId: nudgeRowResult.nudgeId,
        to: checkResult.toEmail,
        subject: nudgeRowResult.subject,
        textBody: nudgeRowResult.textBody,
        replyTo,
        mailboxHash: `n_${nudgeRowResult.nudgeId}`,
      };

      const { providerMessageId } = await sender.send(email);
      return {
        providerMessageId,
        provider: sender.provider,
        replyTo,
        mailboxHash: `n_${nudgeRowResult.nudgeId}`,
      };
    });

    // Step 4: record — stamp nudge sent, update loop, write loop_events + audit.
    await step.run("record-nudge-sent", async () => {
      const now = new Date();
      const repository = new DrizzleNudgeRepository();
      const store = new DrizzleOutboundEmailStore();

      // Reload loop to get fresh Date objects for advanceNextCheckAt.
      const loop = await repository.findCandidateById(loopId);
      if (!loop) {
        throw new Error(`send-nudge: loop ${loopId} disappeared before record step`);
      }

      const outboundId = randomUUID();
      await store.recordSend({
        id: outboundId,
        userId: loop.userId,
        nudgeId: nudgeRowResult.nudgeId,
        provider: sendResult.provider,
        providerMessageId: sendResult.providerMessageId,
        toEmail: checkResult.toEmail,
        subject: nudgeRowResult.subject,
        textBody: nudgeRowResult.textBody,
        headers: {},
        replyTo: sendResult.replyTo,
        inReplyTo: null,
        referencesHeader: null,
        mailboxHash: sendResult.mailboxHash,
      });

      await store.markNudgeSent({ nudgeId: nudgeRowResult.nudgeId, sentAt: now });

      await repository.markLoopNudged({
        loopId: loop.id,
        nextCheckAt: advanceNextCheckAt(loop, now),
        now,
      });

      await repository.writeLoopEvent({
        userId: loop.userId,
        loopId: loop.id,
        eventType: "nudged",
        metadata: { nudgeId: nudgeRowResult.nudgeId, inngestRunId: runId },
      });

      await repository.writeAudit({
        userId: loop.userId,
        action: "nudge.sent",
        metadata: {
          nudgeId: nudgeRowResult.nudgeId,
          loopId: loop.id,
          providerMessageId: sendResult.providerMessageId,
          inngestRunId: runId,
        },
      });
    });

    // Operability E4: log that this run completed.
    console.log(
      `[send-nudge] loopId=${loopId} nudgeId=${nudgeRowResult.nudgeId} runId=${runId}`,
    );

    return {
      ok: true,
      status: "sent",
      nudgeId: nudgeRowResult.nudgeId,
      providerMessageId: sendResult.providerMessageId,
    };
  }),
);
