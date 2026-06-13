/**
 * generate-report handler — consumes `report.requested`.
 *
 * Generates a tokenized report and sends a PRIVATE reply to the report owner
 * containing the `/r/<token>` link. The reply is commandable: the nudge row
 * carries an `ordinalMap` (1-based ordinal → loop id) so a user can reply
 * "done 2" against the top rows (AR-3).
 *
 * Step breakdown (mirrors send-digest.ts):
 *   A. build-and-persist   — mint `now`, load loops, assembleReport (deterministic
 *                            inclusion/order), summarize (model writes ONLY
 *                            headline+bullets), createReport (mint token), build the
 *                            email (subject/textBody embed the link), createNudgeRow.
 *                            Returns serializable primitives ONLY — the raw token
 *                            never leaves this step; only the textBody/link (which
 *                            already embed it inside the step) and the tokenHash do.
 *   B. send-report-email   — SEND ONLY, no DB writes (Gotcha 2).
 *   C. record-and-emit     — recordSend + markNudgeSent + writeAudit + emit
 *                            report.generated.
 *
 * Gotcha 1: `now` and the minted token are created INSIDE step.run and read back
 *           from memoized returns. Dates cross step boundaries as ISO strings.
 * Gotcha 2: the send step performs NO DB writes; bookkeeping is the next step.
 * Gotcha 3: the model NEVER adds/removes/re-orders loops — assembleReport decides
 *           inclusion + order; summarize only writes headline+bullets.
 *
 * PRIVACY: the report goes ONLY to the owner's users.email (never any other
 * address). If the owner has no email row, the send is skipped (no throw).
 */

import { randomUUID } from "node:crypto";
import { inngest } from "@/workflows/client";
import { getOptionalEnv } from "@/config/env";
import type { EmailSender, OutboundEmailStore } from "@/email/outbound";
import { buildNudgeReplyTo, DrizzleOutboundEmailStore } from "@/email/outbound";
import { getEmailSender } from "@/email/sender-factory";
import type { NudgeRepository } from "@/nudges/repository";
import { DrizzleNudgeRepository } from "@/nudges/repository";
import { assembleReport, type ReportKind } from "@/reports/query";
import type { ReportsRepository } from "@/reports/repository";
import { DrizzleReportsRepository } from "@/reports/repository";
import { buildReportEmail, type ReportEmailKind } from "@/reports/reply";
import { createReport } from "@/reports/service";
import { generateSuggestedSummary } from "@/reports/summarize";
import { hashReportToken } from "@/reports/token";

// ---------------------------------------------------------------------------
// Ports — pure interfaces so the test injects in-memory fakes (no DB/model/Inngest)
// ---------------------------------------------------------------------------

export type GenerateReportPorts = {
  reportsRepository: ReportsRepository;
  nudgeRepository: NudgeRepository;
  sender: EmailSender;
  store: OutboundEmailStore;
  /**
   * Resolves the report owner's verified email (users.email). PRIVACY: the report
   * is sent ONLY to this address. Returns null when the user has no email row, in
   * which case the send is skipped (the report is still persisted).
   */
  loadOwnerEmail: (userId: string) => Promise<string | null>;
};

export type GenerateReportInput = {
  userId: string;
  kind: ReportKind;
  scope: Record<string, unknown>;
  requestedVia: string;
  inboundEmailId?: string | null;
  now: Date;
  useModel: boolean;
  /** NEXT_PUBLIC_APP_URL — base of the /r/<token> link. */
  appBaseUrl: string;
  replyToBase?: string;
  ports: GenerateReportPorts;
};

export type GenerateReportResult = {
  reportId: string;
  nudgeId: string;
  tokenHash: string;
  expiresAt: Date;
  summaryHeadline: string;
};

// ---------------------------------------------------------------------------
// AR-3 metadata shape — MUST match asPrivateReplyMetadata() in resolve-reply-target.ts:
//   - top-level `ordinalMap` key, keys are 1-based numeric ordinals, values loop UUIDs.
// ---------------------------------------------------------------------------

type ReportNudgeMetadata = {
  kind: "report";
  ordinalMap: Record<number, string>;
  ordinalCount: number;
  loopCount: number;
};

// ---------------------------------------------------------------------------
// Pure core — composes everything via injected ports
// ---------------------------------------------------------------------------

/**
 * Compute the 1-based ordinal → loopId map from the first up-to-3 rows across
 * sections in order (skipping empty sections). This is the deterministic pre-ranked
 * set assembleReport produced; it makes the report reply commandable (AR-3).
 */
function buildOrdinalMap(
  sections: { rows: { loop: { id: string } }[] }[],
): Record<number, string> {
  const ordinalMap: Record<number, string> = {};
  let ordinal = 1;
  for (const section of sections) {
    for (const row of section.rows) {
      if (ordinal > 3) break;
      ordinalMap[ordinal] = row.loop.id;
      ordinal += 1;
    }
    if (ordinal > 3) break;
  }
  return ordinalMap;
}

export async function generateReport(
  input: GenerateReportInput,
): Promise<GenerateReportResult> {
  const {
    userId,
    kind,
    scope,
    requestedVia,
    inboundEmailId = null,
    now,
    useModel,
    appBaseUrl,
    replyToBase,
    ports,
  } = input;

  // 1. Load loops live for the scope.
  const { loops, loopActivity } = await ports.reportsRepository.loadLoopsForScope(
    userId,
    scope,
  );

  // 2. assembleReport — deterministic inclusion + order (Gotcha 3).
  const sections = assembleReport({ kind, scope, now, loops, loopActivity });

  // 3. ordinalMap from the first ≤3 rows across sections in order (AR-3).
  const ordinalMap = buildOrdinalMap(sections.sections);
  const ordinalCount = Object.keys(ordinalMap).length;

  // 4. summarize — model writes ONLY headline+bullets (or deterministic fallback).
  const summary = await generateSuggestedSummary({
    totalOpen: sections.totalOpen,
    sections: sections.sections,
    useModel,
  });

  // 5. createReport — mints the token internally; returns the plaintext token ONCE.
  //    The persisted summary is the model headline (frozen intent).
  const { reportId, token, expiresAt } = await createReport({
    userId,
    kind,
    scope,
    summary: summary.headline,
    requestedVia,
    inboundEmailId,
    repository: ports.reportsRepository,
  });

  // 6. Build the link + email. The link/textBody embed the raw token — these never
  //    cross a step boundary in the wrapper beyond the build step that minted them.
  const link = `${appBaseUrl.replace(/\/$/, "")}/r/${token}`;
  const { subject, textBody, html: htmlBody } = buildReportEmail({
    kind: kind as ReportEmailKind,
    scope,
    totalOpen: sections.totalOpen,
    sections: sections.sections,
    link,
    summary,
  });

  // 7. Create the nudge row with the ordinalMap at TOP LEVEL (resolve-reply-target.ts
  //    reads `record.ordinalMap`).
  const metadata: ReportNudgeMetadata = {
    kind: "report",
    ordinalMap,
    ordinalCount,
    loopCount: sections.totalOpen,
  };

  const nudge = await ports.nudgeRepository.createNudgeRow({
    userId,
    loopId: null,
    inboundEmailId,
    subject,
    body: textBody,
    // `report` is a new nudge type; the column is text and NudgeType has not yet
    // been extended (out of this task's file scope), so cast at the boundary.
    type: "report",
    metadata: metadata as unknown as Record<string, unknown>,
  });

  const nudgeId = nudge.id;
  const tokenHash = hashReportToken(token);

  // 8. SEND — PRIVACY: only to the owner's verified email. No DB writes here.
  const ownerEmail = await ports.loadOwnerEmail(userId);
  if (!ownerEmail) {
    // No owner email → skip the send but still return the persisted result.
    return { reportId, nudgeId, tokenHash, expiresAt, summaryHeadline: summary.headline };
  }

  const effectiveReplyToBase = replyToBase ?? getOptionalEnv().POSTMARK_REPLY_TO_BASE;
  const replyTo = buildNudgeReplyTo(nudgeId, effectiveReplyToBase);

  const { providerMessageId } = await ports.sender.send({
    userId,
    nudgeId,
    to: ownerEmail,
    subject,
    textBody,
    htmlBody,
    replyTo,
    mailboxHash: `n_${nudgeId}`,
    headers: {},
  });

  // 9. Bookkeeping — after confirmed send.
  await ports.store.recordSend({
    id: randomUUID(),
    userId,
    nudgeId,
    provider: ports.sender.provider,
    providerMessageId,
    toEmail: ownerEmail,
    subject,
    textBody,
    headers: {},
    replyTo,
    inReplyTo: null,
    referencesHeader: null,
    mailboxHash: `n_${nudgeId}`,
  });

  await ports.store.markNudgeSent({ nudgeId, sentAt: now });

  await ports.nudgeRepository.writeAudit({
    userId,
    // `report.generated` is a new audit action; the column is text and the audit
    // action union has not yet been extended (out of this task's file scope).
    action: "report.generated",
    metadata: { reportId, nudgeId },
  });

  return { reportId, nudgeId, tokenHash, expiresAt, summaryHeadline: summary.headline };
}

// ---------------------------------------------------------------------------
// Drizzle ownerEmail port
// ---------------------------------------------------------------------------

async function loadOwnerEmailDrizzle(userId: string): Promise<string | null> {
  const { getDb } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");

  const db = getDb();
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.email ?? null;
}

// ---------------------------------------------------------------------------
// Inngest wrapper — thin binding of Drizzle ports, split at nondeterministic
// boundaries (Gotcha 1 + 2).
// ---------------------------------------------------------------------------

export const generateReportFunction = inngest.createFunction(
  {
    id: "generate-report",
    triggers: { event: "report.requested" },
    // Idempotency: one report per (user, kind, inbound email). A webhook redelivery
    // of the same inbound email cannot create two reports. (scope-hash refinement
    // deferred — a single inbound command yields exactly one kind+scope, so this key
    // is unique per request.)
    idempotency: "event.data.userId + ':' + event.data.kind + ':' + event.data.inboundEmailId",
    retries: 3,
  },
  async ({ event, step }) => {
    const userId = event.data.userId as string;
    const kind = (event.data.kind ?? "insights") as ReportKind;
    const scope = ((event.data.scope as Record<string, unknown> | undefined) ?? {}) as Record<
      string,
      unknown
    >;
    const requestedVia = (event.data.requestedVia as string | undefined) ?? "email_command";
    const inboundEmailId = (event.data.inboundEmailId as string | undefined) ?? null;

    // ── Step A: build-and-persist ──────────────────────────────────────────────
    // Mint `now`, load loops, assemble, summarize (model), createReport (mint token),
    // build the email (subject/textBody embed the link), create the nudge row.
    //
    // CRITICAL: the raw token is minted in createReport INSIDE this step. It is
    // never returned from the step. Only `subject`/`textBody` (which already embed
    // the link built inside this step) and `tokenHash` leave the boundary.
    const built = await step.run("build-and-persist", async () => {
      const now = new Date();
      const reportsRepository = new DrizzleReportsRepository();
      const nudgeRepository = new DrizzleNudgeRepository();

      const { loops, loopActivity } = await reportsRepository.loadLoopsForScope(
        userId,
        scope,
      );
      const sections = assembleReport({ kind, scope, now, loops, loopActivity });
      const ordinalMap = buildOrdinalMap(sections.sections);
      const ordinalCount = Object.keys(ordinalMap).length;

      const summary = await generateSuggestedSummary({
        totalOpen: sections.totalOpen,
        sections: sections.sections,
        // Drives the model in production; falls back deterministically if no model.
        useModel: true,
      });

      const { reportId, token, expiresAt } = await createReport({
        userId,
        kind,
        scope,
        summary: summary.headline,
        requestedVia,
        inboundEmailId,
        repository: reportsRepository,
      });

      const env = getOptionalEnv();
      const link = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/r/${token}`;
      const { subject, textBody, html: htmlBody } = buildReportEmail({
        kind: kind as ReportEmailKind,
        scope,
        totalOpen: sections.totalOpen,
        sections: sections.sections,
        link,
        summary,
      });

      const metadata: ReportNudgeMetadata = {
        kind: "report",
        ordinalMap,
        ordinalCount,
        loopCount: sections.totalOpen,
      };

      const nudge = await nudgeRepository.createNudgeRow({
        userId,
        loopId: null,
        inboundEmailId,
        subject,
        body: textBody,
        type: "report",
        metadata: metadata as unknown as Record<string, unknown>,
      });

      const ownerEmail = await loadOwnerEmailDrizzle(userId);

      // tokenHash is the only token-derived value that crosses the boundary; the raw
      // token does NOT (the link/textBody already embed it, built above in-step).
      return {
        reportId,
        nudgeId: nudge.id,
        nowIso: now.toISOString(),
        subject,
        textBody,
        htmlBody,
        ownerEmail,
        expiresAtIso: expiresAt.toISOString(),
        summaryHeadline: summary.headline,
        tokenHash: hashReportToken(token),
      };
    });

    // No owner email → report persisted, send skipped. Still emit nothing further.
    if (!built.ownerEmail) {
      return {
        ok: true,
        status: "sent_skipped_no_owner_email",
        reportId: built.reportId,
        nudgeId: built.nudgeId,
      };
    }

    // ── Step B: send-report-email — SEND ONLY, no DB writes (Gotcha 2). ─────────
    const sent = await step.run("send-report-email", async () => {
      const env = getOptionalEnv();
      const replyTo = buildNudgeReplyTo(built.nudgeId, env.POSTMARK_REPLY_TO_BASE);

      const sender = getEmailSender();
      const { providerMessageId } = await sender.send({
        userId,
        nudgeId: built.nudgeId,
        to: built.ownerEmail!,
        subject: built.subject,
        textBody: built.textBody,
        htmlBody: built.htmlBody,
        replyTo,
        mailboxHash: `n_${built.nudgeId}`,
        headers: {},
      });

      return { providerMessageId, replyTo };
    });

    // ── Step C: record-and-emit — bookkeeping + report.generated. ──────────────
    await step.run("record-and-emit", async () => {
      const now = new Date(built.nowIso);
      const store = new DrizzleOutboundEmailStore();
      const sender = getEmailSender();

      await store.recordSend({
        id: randomUUID(),
        userId,
        nudgeId: built.nudgeId,
        provider: sender.provider,
        providerMessageId: sent.providerMessageId,
        toEmail: built.ownerEmail!,
        subject: built.subject,
        textBody: built.textBody,
        headers: {},
        replyTo: sent.replyTo,
        inReplyTo: null,
        referencesHeader: null,
        mailboxHash: `n_${built.nudgeId}`,
      });

      await store.markNudgeSent({ nudgeId: built.nudgeId, sentAt: now });

      const nudgeRepository = new DrizzleNudgeRepository();
      await nudgeRepository.writeAudit({
        userId,
        action: "report.generated",
        metadata: { reportId: built.reportId, nudgeId: built.nudgeId },
      });
    });

    await step.sendEvent("emit-report-generated", {
      name: "report.generated",
      data: {
        userId,
        reportId: built.reportId,
        kind,
        scope,
        expiresAt: built.expiresAtIso,
        tokenHash: built.tokenHash,
        summaryHeadline: built.summaryHeadline,
        replyNudgeId: built.nudgeId,
      },
    });

    console.log(
      `[generate-report] userId=${userId} reportId=${built.reportId} nudgeId=${built.nudgeId} kind=${kind}`,
    );

    return {
      ok: true,
      status: "sent",
      reportId: built.reportId,
      nudgeId: built.nudgeId,
      providerMessageId: sent.providerMessageId,
    };
  },
);
