/**
 * Send-digest handler — consumes `digest.daily_due`.
 *
 * Step breakdown (mirrors send-activation-email.ts pattern):
 *   A. check-digest        — reload user, recheck eligibility (authoritative 23h guard).
 *   B. build-digest        — load loops, build model, render email.
 *   C. create-nudge-row    — persist the nudges row with ordinal→loopId metadata (AR-3).
 *   D. send-digest-email   — SEND ONLY, no DB writes (Gotcha 2).
 *   E. record-digest-send  — bookkeeping after confirmed send (recordSend + markNudgeSent
 *                            + writeAudit + writeLoopEvents).
 *
 * AR-3: The nudges.metadata carries `{ ordinalMap: Record<number, string> }` in EXACTLY
 * the shape that `resolve-reply-target.ts`'s `asPrivateReplyMetadata()` reads:
 *   - Top-level key is `ordinalMap`
 *   - Keys are 1-based numeric ordinals (serialised as numbers, not strings)
 *   - Values are loop UUIDs
 * Also includes `kind: "digest"` (for type discrimination if callers need it),
 * `loopCount` and `ordinalCount` for operability.
 *
 * AR-5: NO step.sleepUntil anywhere in this file.
 * AR-9: An empty digest still sends — the coverage line and capture prompt are the ritual.
 * PRIVACY: the digest goes ONLY to the owner's users.email (never any other address).
 * Gotcha 1: `now` is minted once inside the first step.run (memoised by Inngest).
 * Gotcha 2: the send step does NO DB writes; bookkeeping is the NEXT step.
 */

import { randomUUID } from "node:crypto";
import { inngest } from "@/workflows/client";
import { getOptionalEnv } from "@/config/env";
import { buildDigest } from "@/digests/build";
import type { DigestLoopInput } from "@/digests/build";
import type { DigestUser } from "@/digests/repository";
import { DrizzleDigestRepository } from "@/digests/repository";
import { renderDigestEmail } from "@/digests/render";
import { buildNudgeReplyTo, DevRecordingSender } from "@/email/outbound";
import type { EmailSender, OutboundEmailStore } from "@/email/outbound";
import { DrizzleOutboundEmailStore } from "@/email/outbound";
import { getEmailSender } from "@/email/sender-factory";
import { DrizzleNudgeRepository } from "@/nudges/repository";
import type { NudgeRepository } from "@/nudges/repository";

// ---------------------------------------------------------------------------
// Ports — pure interfaces so tests inject in-memory fakes
// ---------------------------------------------------------------------------

/**
 * Subset of DigestRepository the send-digest function needs.
 * Extends with `findDigestUserById` (owned by this file's extension of the
 * DigestRepository port).
 */
export interface SendDigestRepository {
  /**
   * Reload the user row (re-validates digestEnabled before sending).
   * Returns null if the user does not exist.
   */
  findDigestUserById(userId: string): Promise<DigestUser | null>;

  /**
   * Returns true if a digest has been sent (sent_at IS NOT NULL) to the user
   * within the last 23 hours — the authoritative in-function idempotency guard.
   */
  hasRecentDigest(userId: string, now: Date): Promise<boolean>;

  /**
   * Returns loops for a user that should appear in their daily digest.
   */
  findLoopsForDigest(userId: string, now: Date): Promise<DigestLoopInput[]>;
}

// ---------------------------------------------------------------------------
// AR-3 metadata shape — MUST match asPrivateReplyMetadata() in resolve-reply-target.ts
// ---------------------------------------------------------------------------

/**
 * The metadata stored on the nudges row for a digest. The `ordinalMap` key is
 * the single critical field: `resolve-reply-target.ts`'s `asPrivateReplyMetadata()`
 * reads `record.ordinalMap` to build the ordinal→loopId map used for reply commands
 * like "snooze 1 until Monday" or "done 2".
 *
 * Shape is intentionally parallel to PrivateReplyNudgeMetadata (src/loops/service.ts)
 * so the resolver degrades gracefully for any nudge type that carries an ordinalMap.
 */
export type DigestNudgeMetadata = {
  kind: "digest";
  ordinalMap: Record<number, string>;
  ordinalCount: number;
  loopCount: number;
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type DigestCheckResult =
  | { status: "suppressed_digest_disabled" }
  | { status: "suppressed_recent_digest" }
  | { status: "suppressed_user_not_found" }
  | { status: "clear"; user: DigestUser; now: Date };

export type DigestSendResult =
  | { status: "suppressed_digest_disabled" }
  | { status: "suppressed_recent_digest" }
  | { status: "suppressed_user_not_found" }
  | { status: "sent"; nudgeId: string; providerMessageId: string };

// ---------------------------------------------------------------------------
// Phase A: check — authoritative eligibility guard
// ---------------------------------------------------------------------------

/**
 * Reloads the user and rechecks:
 *   1. digestEnabled (user may have disabled it since the sweep ran).
 *   2. hasRecentDigest within the last 23h (in-function idempotency guard).
 *
 * `now` must be injected from inside an Inngest step.run (Gotcha 1).
 */
export async function checkDigest(
  userId: string,
  options: {
    repository: SendDigestRepository;
    now: Date;
  },
): Promise<DigestCheckResult> {
  const user = await options.repository.findDigestUserById(userId);

  if (!user) {
    return { status: "suppressed_user_not_found" };
  }

  if (!user.digestEnabled) {
    return { status: "suppressed_digest_disabled" };
  }

  const recentlySent = await options.repository.hasRecentDigest(userId, options.now);
  if (recentlySent) {
    return { status: "suppressed_recent_digest" };
  }

  return { status: "clear", user, now: options.now };
}

// ---------------------------------------------------------------------------
// Full combined function (used directly in tests via ports)
// ---------------------------------------------------------------------------

/**
 * Full send-digest flow: check → build → create-nudge-row → send → record.
 * Designed for direct use in tests with injected fakes. The Inngest wrapper
 * splits this into separate steps for retry safety; this function composes the
 * same pieces in order.
 *
 * PRIVACY: digest is sent ONLY to `user.email` (the Clerk-verified primary).
 */
export async function sendDigest(
  userId: string,
  options: {
    repository: SendDigestRepository;
    nudgeRepository: NudgeRepository;
    sender: EmailSender;
    store?: OutboundEmailStore;
    replyToBase?: string;
    now: Date;
    inngestRunId?: string;
  },
): Promise<DigestSendResult> {
  // --- Phase A: check ---
  const checkResult = await checkDigest(userId, {
    repository: options.repository,
    now: options.now,
  });

  if (checkResult.status !== "clear") {
    return checkResult;
  }

  const { user, now } = checkResult;

  // --- Phase B: build ---
  const loops = await options.repository.findLoopsForDigest(userId, now);
  const model = buildDigest({ user, loops, now });
  const rendered = renderDigestEmail(model);

  // --- Phase C: create-nudge-row ---
  const metadata: DigestNudgeMetadata = {
    kind: "digest",
    ordinalMap: rendered.ordinalToLoopId,
    ordinalCount: Object.keys(rendered.ordinalToLoopId).length,
    loopCount: loops.length,
  };

  const nudgeRow = await options.nudgeRepository.createNudgeRow({
    userId,
    loopId: null, // digest spans all loops; no single loopId
    inboundEmailId: null,
    subject: rendered.subject,
    body: rendered.textBody,
    type: "digest",
    metadata: metadata as unknown as Record<string, unknown>,
  });

  const nudgeId = nudgeRow.id;

  // --- Phase D: send-only ---
  const replyToBase = options.replyToBase ?? getOptionalEnv().POSTMARK_REPLY_TO_BASE;
  const replyTo = buildNudgeReplyTo(nudgeId, replyToBase);

  const { providerMessageId } = await options.sender.send({
    userId,
    nudgeId,
    to: user.email, // PRIVACY: always the owner's verified email
    subject: rendered.subject,
    textBody: rendered.textBody,
    htmlBody: rendered.htmlBody,
    replyTo,
    mailboxHash: `n_${nudgeId}`,
    headers: {},
  });

  // --- Phase E: record ---
  const store = options.store ?? new DrizzleOutboundEmailStore();
  const sentAt = now;

  await store.recordSend({
    id: randomUUID(),
    userId,
    nudgeId,
    provider: options.sender.provider,
    providerMessageId,
    toEmail: user.email,
    subject: rendered.subject,
    textBody: rendered.textBody,
    headers: {},
    replyTo,
    inReplyTo: null,
    referencesHeader: null,
    mailboxHash: `n_${nudgeId}`,
  });

  await store.markNudgeSent({ nudgeId, sentAt });

  // Write audit row (operability: includes inngestRunId + ordinalCount).
  await options.nudgeRepository.writeAudit({
    userId,
    action: "digest.sent",
    metadata: {
      nudgeId,
      inngestRunId: options.inngestRunId ?? null,
      ordinalCount: metadata.ordinalCount,
    },
  });

  // Write loop events for every rendered loop (AR-9: cap respected — rendered only).
  const renderedLoopIds = Object.values(rendered.ordinalToLoopId);
  for (const loopId of renderedLoopIds) {
    await options.nudgeRepository.writeLoopEvent({
      userId,
      loopId,
      eventType: "digest_summarized",
      metadata: { nudgeId },
    });
  }

  return { status: "sent", nudgeId, providerMessageId };
}

// ---------------------------------------------------------------------------
// Drizzle-backed SendDigestRepository implementation
// ---------------------------------------------------------------------------

/**
 * Extends DrizzleDigestRepository with `findDigestUserById` — the additional
 * method the send-digest function needs to reload the user authoritatively.
 */
export class DrizzleSendDigestRepository implements SendDigestRepository {
  private readonly inner: InstanceType<typeof DrizzleDigestRepository>;

  constructor() {
    this.inner = new DrizzleDigestRepository();
  }

  async findDigestUserById(userId: string): Promise<DigestUser | null> {
    const users = await this.inner.findDigestEnabledUsers();
    // findDigestEnabledUsers returns digest-enabled users; if the user doesn't
    // appear here, they're either missing or have disabled digests — both cases
    // mean suppressed (the caller handles the distinction via digestEnabled flag).
    // For completeness, perform a direct look-up via the Drizzle db.
    return await this.findById(userId);
  }

  private async findById(userId: string): Promise<DigestUser | null> {
    // Use the inner Drizzle db directly via a cast — the DrizzleDigestRepository
    // exposes its db only through methods. We replicate the small select here.
    const { getDb } = await import("@/db/client");
    const { users: usersTable } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const db = getDb();
    const [row] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        timezone: usersTable.timezone,
        digestEnabled: usersTable.digestEnabled,
        digestSendHour: usersTable.digestSendHour,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    return row ?? null;
  }

  async hasRecentDigest(userId: string, now: Date): Promise<boolean> {
    return this.inner.hasRecentDigest(userId, now);
  }

  async findLoopsForDigest(userId: string, now: Date): Promise<DigestLoopInput[]> {
    return this.inner.findLoopsForDigest(userId, now);
  }
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding of Drizzle ports to the pure core
// ---------------------------------------------------------------------------

export const sendDigestFunction = inngest.createFunction(
  {
    id: "send-digest",
    triggers: { event: "digest.daily_due" },
  },
  async ({ event, runId, step }) => {
    const userId = event.data.userId;

    // Step A: check — mint `now` + authoritative eligibility guard.
    // `now` is minted inside this step so it is memoised across re-executions.
    // IMPORTANT: Dates are JSON-serialised by Inngest memoisation; we return
    // `nowIso` (string) from the step and reconstruct `now = new Date(nowIso)`
    // in subsequent steps.
    const checkResult = await step.run("check-digest", async () => {
      const now = new Date();
      const result = await checkDigest(userId, {
        repository: new DrizzleSendDigestRepository(),
        now,
      });
      // Attach nowIso to the result so downstream steps can reconstruct it.
      return { ...result, nowIso: now.toISOString() };
    });

    if (checkResult.status !== "clear") {
      return { ok: true, status: checkResult.status };
    }

    // Reconstruct `now` from the memoised ISO string (Inngest JSON round-trip).
    const now = new Date(checkResult.nowIso);
    const user = checkResult.user;

    // Step B: build — load loops + build model + render email.
    const buildResult = await step.run("build-digest", async () => {
      const repository = new DrizzleSendDigestRepository();
      const loops = await repository.findLoopsForDigest(userId, now);
      const model = buildDigest({ user, loops, now });
      const rendered = renderDigestEmail(model);
      return { loopCount: loops.length, rendered };
    });

    const { loopCount, rendered } = buildResult;

    // Step C: create-nudge-row — persist before send so we have a nudgeId.
    const nudgeRow = await step.run("create-nudge-row", async () => {
      const metadata: DigestNudgeMetadata = {
        kind: "digest",
        ordinalMap: rendered.ordinalToLoopId,
        ordinalCount: Object.keys(rendered.ordinalToLoopId).length,
        loopCount,
      };

      const repo = new DrizzleNudgeRepository();
      return repo.createNudgeRow({
        userId,
        loopId: null,
        inboundEmailId: null,
        subject: rendered.subject,
        body: rendered.textBody,
        type: "digest",
        metadata: metadata as unknown as Record<string, unknown>,
      });
    });

    const nudgeId = nudgeRow.id;

    // Step D: send-only — NO DB writes in this step (Gotcha 2).
    const sendResult = await step.run("send-digest-email", async () => {
      const env = getOptionalEnv();
      const replyToBase = env.POSTMARK_REPLY_TO_BASE;
      const replyTo = buildNudgeReplyTo(nudgeId, replyToBase);

      const sender = getEmailSender();
      const { providerMessageId } = await sender.send({
        userId,
        nudgeId,
        to: user.email, // PRIVACY: owner's verified email only
        subject: rendered.subject,
        textBody: rendered.textBody,
        htmlBody: rendered.htmlBody,
        replyTo,
        mailboxHash: `n_${nudgeId}`,
        headers: {},
      });

      return { providerMessageId, replyTo };
    });

    // Step E: record — bookkeeping after confirmed send.
    await step.run("record-digest-send", async () => {
      const store = new DrizzleOutboundEmailStore();
      const sentAt = now; // use the memoised `now` (already reconstructed above)

      await store.recordSend({
        id: randomUUID(),
        userId,
        nudgeId,
        provider: "postmark",
        providerMessageId: sendResult.providerMessageId,
        toEmail: user.email,
        subject: rendered.subject,
        textBody: rendered.textBody,
        headers: {},
        replyTo: sendResult.replyTo,
        inReplyTo: null,
        referencesHeader: null,
        mailboxHash: `n_${nudgeId}`,
      });

      await store.markNudgeSent({ nudgeId, sentAt });

      const nudgeRepo = new DrizzleNudgeRepository();

      await nudgeRepo.writeAudit({
        userId,
        action: "digest.sent",
        metadata: {
          nudgeId,
          inngestRunId: runId,
          ordinalCount: Object.keys(rendered.ordinalToLoopId).length,
        },
      });

      const renderedLoopIds = Object.values(rendered.ordinalToLoopId);
      for (const loopId of renderedLoopIds) {
        await nudgeRepo.writeLoopEvent({
          userId,
          loopId,
          eventType: "digest_summarized",
          metadata: { nudgeId },
        });
      }
    });

    console.log(
      `[send-digest] userId=${userId} nudgeId=${nudgeId} ordinalCount=${Object.keys(rendered.ordinalToLoopId).length}`,
    );

    return {
      ok: true,
      status: "sent",
      nudgeId,
      providerMessageId: sendResult.providerMessageId,
    };
  },
);
