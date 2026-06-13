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
 *
 * Retry policy: retries=5. After all retries are exhausted, the onFailure handler
 * marks the nudge row status='failed' (if one was created) and emits `nudge.failed`.
 *
 * Deliverable 12 (outbound idempotency): the send step sets
 * X-Keeps-Idempotency-Key: nudge-<nudgeId> on the outbound email and defensively
 * re-reads nudges.status before sending — if the row is already 'sent' the step
 * returns an already-sent marker so an Inngest replay never double-sends.
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
    // Deliverable 12: outbound idempotency header so Postmark dedups replays.
    headers: { "X-Keeps-Idempotency-Key": `nudge-${nudgeId}` },
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
    headers: { "X-Keeps-Idempotency-Key": `nudge-${nudgeId}` },
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
// onFailure handler — exported for unit testing (Deliverable 13)
// ---------------------------------------------------------------------------

/**
 * Called by Inngest after all retries (5) are exhausted for a send-nudge run.
 *
 * Resolution strategy:
 *   1. The create-nudge-row step stamps `inngestRunId: runId` into the nudge row
 *      metadata. We call `repository.findLatestNudgeByRunId(runId)` to locate it.
 *   2. If found, mark status='failed' (merging error metadata) and emit nudge.failed.
 *   3. If not found (failure pre-dates the create-nudge-row step), still emit
 *      nudge.failed with nudgeId="" so downstream can react.
 *
 * NOTE: Inngest's onFailure `event` has shape:
 *   { data: { event: <original event>, error: <JsonError> } }
 * The original event's runId is NOT available in onFailure, but Inngest passes
 * the failed run id as `event.data.run_id` (v4 schema).
 */
export async function sendNudgeOnFailure({
  event,
  error,
  step,
  repository,
}: {
  event: {
    data: {
      /** The original loop.nudge_due event */
      event: { data: unknown; name?: string };
      /** The terminal error from Inngest */
      error: { message?: string; name?: string; stack?: string };
      /** Inngest v4: the failed run id */
      run_id?: string;
    };
  };
  error: { message?: string };
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    sendEvent: (id: string, evt: { name: string; data: unknown }) => Promise<void>;
  };
  repository?: NudgeRepository;
}): Promise<void> {
  const originalData = (event.data.event?.data ?? {}) as Record<string, unknown>;
  const userId = typeof originalData.userId === "string" ? originalData.userId : null;
  const runId = event.data.run_id ?? null;
  const errorMessage =
    error?.message ?? event.data.error?.message ?? "send-nudge failed (no message).";

  const nudgeInfo = await step.run("mark-nudge-failed", async () => {
    const repo = repository ?? new DrizzleNudgeRepository();

    let nudgeId: string | null = null;
    let resolvedUserId: string | null = userId;

    // Primary: find by inngestRunId stamped in nudge row metadata (Deliverable 13).
    if (runId) {
      const found = await repo.findLatestNudgeByRunId(runId);
      if (found) {
        nudgeId = found.id;
        resolvedUserId = found.userId;
        await repo.markNudgeFailed({
          nudgeId: found.id,
          extraMetadata: {
            reason: "inngest_final_failure",
            error: errorMessage,
            failedAt: new Date().toISOString(),
          },
        });
      }
    }

    return { nudgeId, resolvedUserId };
  });

  await step.sendEvent("emit-nudge-failed", {
    name: "nudge.failed",
    data: {
      nudgeId: nudgeInfo.nudgeId ?? "",
      userId: nudgeInfo.resolvedUserId ?? userId ?? "",
      error: errorMessage,
    } satisfies EventMap["nudge.failed"],
  });
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding of Drizzle ports to the pure core
// ---------------------------------------------------------------------------

export const sendNudgeFunction = inngest.createFunction(
  {
    id: "send-nudge",
    triggers: { event: "loop.nudge_due" },
    // Deliverable 13: explicit retry policy. 5 retries gives Inngest ~31 min of
    // total backoff before the run is declared terminal and onFailure fires.
    retries: 5,
    // No custom idempotency key — rely on in-function re-validation so future
    // legitimate nudges for the same loop are not suppressed by Inngest dedup.
    //
    // Dead-letter rail: after the 5 retries above are exhausted, flip the nudge
    // row to status='failed' and emit `nudge.failed` for downstream observability.
    onFailure: async ({ event, error, step }) => {
      // Cast to unknown first: the Inngest SDK's FailureEventPayload / StepTools
      // generics don't align with the hand-written interface used for unit-testing.
      // The runtime shape matches what sendNudgeOnFailure reads.
      await sendNudgeOnFailure({
        event: event as unknown as Parameters<typeof sendNudgeOnFailure>[0]["event"],
        error: error as { message?: string },
        step: step as unknown as Parameters<typeof sendNudgeOnFailure>[0]["step"],
      });
    },
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
        // Stamp inngestRunId so onFailure can find this row by runId.
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
    // Deliverable 12: defensively re-read nudges.status before sending so an
    // Inngest replay of this step never double-sends a nudge that already went out.
    const sendResult = await step.run("send-nudge-email", async () => {
      // Deliverable 12 idempotency guard: re-read nudges.status before sending.
      // If this step is being replayed and the record-nudge-sent step already
      // committed (status='sent'), skip the Postmark call and return an
      // already-sent sentinel so the record step is still idempotent.
      const repository = new DrizzleNudgeRepository();
      const currentStatus = await repository.findNudgeStatus(nudgeRowResult.nudgeId);
      if (currentStatus === "sent") {
        return {
          providerMessageId: "",
          skipped: false,
          alreadySent: true,
          provider: "dev" as const,
          replyTo: buildNudgeReplyTo(nudgeRowResult.nudgeId, getOptionalEnv().POSTMARK_REPLY_TO_BASE),
          mailboxHash: `n_${nudgeRowResult.nudgeId}`,
        };
      }

      const env = getOptionalEnv();
      const sender = getEmailSender();
      const replyTo = buildNudgeReplyTo(nudgeRowResult.nudgeId, env.POSTMARK_REPLY_TO_BASE);

      // Deliverable 12: idempotency header so Postmark deduplicates replays on
      // its end (belt-and-suspenders alongside the status re-read above).
      const email: OutboundEmail = {
        userId: checkResult.userId,
        nudgeId: nudgeRowResult.nudgeId,
        to: checkResult.toEmail,
        subject: nudgeRowResult.subject,
        textBody: nudgeRowResult.textBody,
        replyTo,
        mailboxHash: `n_${nudgeRowResult.nudgeId}`,
        headers: { "X-Keeps-Idempotency-Key": `nudge-${nudgeRowResult.nudgeId}` },
      };

      const { providerMessageId, skipped } = await sender.send(email);
      return {
        providerMessageId,
        skipped: skipped ?? false,
        alreadySent: false,
        provider: sender.provider,
        replyTo,
        mailboxHash: `n_${nudgeRowResult.nudgeId}`,
      };
    });

    // Deliverable 12 idempotency: the send step returned alreadySent=true when it
    // detected nudges.status='sent' on replay. Skip all remaining record steps —
    // the nudge is already fully recorded. Return sent so the caller sees success.
    if (sendResult.alreadySent) {
      console.log(
        `[send-nudge] loopId=${loopId} nudgeId=${nudgeRowResult.nudgeId} ALREADY_SENT (idempotent replay) runId=${runId}`,
      );
      return {
        ok: true,
        status: "sent",
        nudgeId: nudgeRowResult.nudgeId,
        providerMessageId: "",
      };
    }

    // Suppression (Phase 6): a non-active outbound user causes the suppression guard to
    // refuse the send (no network call) and flip the nudge row to `status='skipped'`.
    // Do NOT record an outbound row or mark the nudge `sent`. Advance the loop's next
    // check so the sweep does not re-attempt this nudge every cycle.
    if (sendResult.skipped) {
      await step.run("record-nudge-suppressed", async () => {
        const now = new Date();
        const repository = new DrizzleNudgeRepository();
        const loop = await repository.findCandidateById(loopId);
        if (loop) {
          await repository.markLoopNudged({
            loopId: loop.id,
            nextCheckAt: advanceNextCheckAt(loop, now),
            now,
          });
        }
      });

      console.log(
        `[send-nudge] loopId=${loopId} nudgeId=${nudgeRowResult.nudgeId} SUPPRESSED (user_suppressed) runId=${runId}`,
      );
      return { ok: true, suppressed: true, nudgeId: nudgeRowResult.nudgeId };
    }

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
        headers: { "X-Keeps-Idempotency-Key": `nudge-${nudgeRowResult.nudgeId}` },
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
