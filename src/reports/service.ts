/**
 * reports/service (B2) — composes the Wave A/B primitives into the report
 * lifecycle: mint a tokenized report (createReport), resolve a report from its
 * link token (loadReportByToken), apply a web row action through the SAME loop
 * mutation funnel email commands use (applyReportRowAction), and record a debounced
 * view (recordReportView).
 *
 * This service never touches the DB directly — it depends only on the
 * `ReportsRepository` (B3) and `LoopProcessingRepository` (B1) ports, plus the
 * deterministic token (A2) and query (A4) primitives.
 */

import { assembleReport, type ReportSections } from "@/reports/query";
import {
  hashReportToken,
  mintReportToken,
  verifyReportToken,
} from "@/reports/token";
import type { ReportsRepository, StoredReport } from "@/reports/repository";
import { mutateLoopState, type LoopProcessingRepository } from "@/loops/service";

// ---------------------------------------------------------------------------
// createReport
// ---------------------------------------------------------------------------

export async function createReport(input: {
  userId: string;
  kind: StoredReport["kind"];
  scope: Record<string, unknown>;
  /** model-authored (or fallback) summary text to persist */
  summary: string;
  /** "email_command" | "digest" | "manual" */
  requestedVia: string;
  inboundEmailId?: string | null;
  nudgeId?: string | null;
  repository: ReportsRepository;
}): Promise<{ reportId: string; token: string; expiresAt: Date }> {
  // Mint a fresh token. Only the sha256 hash is persisted (mintReportToken returns
  // both); the plaintext `token` below is returned ONCE to the caller (C1) so it can
  // build the /r/<token> link. It is never stored on the row and never logged.
  const { token, tokenHash } = mintReportToken();

  const inserted = await input.repository.insertReport({
    userId: input.userId,
    kind: input.kind,
    scope: input.scope,
    summary: input.summary,
    tokenHash,
    requestedVia: input.requestedVia,
    requestInboundEmailId: input.inboundEmailId,
    requestNudgeId: input.nudgeId,
  });

  return { reportId: inserted.id, token, expiresAt: inserted.expiresAt };
}

// ---------------------------------------------------------------------------
// Shared token resolution
// ---------------------------------------------------------------------------

type ResolveReportResult =
  | { status: "live"; report: StoredReport }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * Constant-time token → report resolution shared by loadReportByToken and
 * applyReportRowAction so the verify logic is never duplicated.
 *
 * Security: expired AND unknown tokens collapse to friendly statuses and we never
 * reveal more than necessary. verifyReportToken does a timingSafeEqual compare plus
 * an expiry check; when it returns false we only distinguish "expired" (row exists
 * but is past expiry) from "not_found" (everything else) as a defensive last step.
 */
async function resolveReport(
  token: string,
  now: Date,
  repository: ReportsRepository,
): Promise<ResolveReportResult> {
  const hash = hashReportToken(token);
  const row = await repository.findReportByTokenHash(hash);

  if (!row) {
    return { status: "not_found" };
  }

  const valid = verifyReportToken(token, {
    storedHash: row.tokenHash,
    expiresAt: row.expiresAt,
    now,
  });

  if (!valid) {
    // Defensive: never reveal more than expired-vs-not-found. The page layer maps
    // BOTH to the same friendly dead-end (HTTP 200), so we never leak whether a
    // report existed.
    if (row.expiresAt <= now) {
      return { status: "expired" };
    }
    return { status: "not_found" };
  }

  return { status: "live", report: row };
}

// ---------------------------------------------------------------------------
// loadReportByToken
// ---------------------------------------------------------------------------

export type LoadReportResult =
  | { status: "live"; report: StoredReport; sections: ReportSections; summary: string }
  | { status: "not_found" }
  | { status: "expired" };

export async function loadReportByToken(input: {
  token: string;
  now: Date;
  repository: ReportsRepository;
}): Promise<LoadReportResult> {
  const resolved = await resolveReport(input.token, input.now, input.repository);

  if (resolved.status !== "live") {
    return resolved;
  }

  const { report } = resolved;

  // ── LIVE-QUERY (no-snapshot) decision ───────────────────────────────────────
  // generated_reports persists ONLY the user-intent scope + the model summary; it
  // NEVER freezes a loop list. On every load we resolve loops live from the loops
  // table (loadLoopsForScope) and re-run assembleReport. Rationale:
  //   1. Source-of-truth: loops are the single source of truth for loop state. A
  //      snapshot would desync the view from reality the instant a loop is marked
  //      done by an email reply — the report would show stale buckets.
  //   2. Row-action parity: web row actions mutate loop state directly; a snapshot
  //      would have to be re-written on every action or it would drift from what the
  //      user just did. Live-query makes the post-action refresh trivially correct.
  //   3. No double-storage: snapshotting would re-store loop data we already own,
  //      inviting divergence between two copies.
  // Only `summary` + `scope` are frozen because they capture the user's intent at
  // REQUEST time (what they asked to see, and the narrative authored then) — those
  // are not loop state and should not move under the user's feet.
  const { loops, loopActivity } = await input.repository.loadLoopsForScope(
    report.userId,
    report.scope,
  );
  const sections = assembleReport({
    kind: report.kind,
    scope: report.scope,
    now: input.now,
    loops,
    loopActivity,
  });

  return { status: "live", report, sections, summary: report.summary };
}

// ---------------------------------------------------------------------------
// applyReportRowAction
// ---------------------------------------------------------------------------

export type ReportRowAction = "done" | "dismiss" | "snooze" | "draft_nudge";

export type ApplyReportRowActionResult =
  | { status: "applied"; sections: ReportSections } // refreshed live sections for client re-render
  | { status: "drafted"; sections: ReportSections } // draft_nudge enqueued (no state mutation)
  | { status: "not_found" } // bad/expired token
  | { status: "expired" }
  | { status: "invalid"; error: string }; // unknown action / missing snoozeUntil

export async function applyReportRowAction(input: {
  token: string;
  now: Date;
  body: { loopId: string; action: ReportRowAction; snoozeUntil?: string | null };
  reportsRepository: ReportsRepository;
  loopRepository: LoopProcessingRepository;
  /** Enqueue a PENDING draft nudge for a loop (no outbound until approved). Wiring lands in C5;
   *  optional here so unit tests + pre-C5 callers don't have to provide it. */
  enqueueDraftNudge?: (input: { userId: string; loopId: string }) => Promise<void>;
}): Promise<ApplyReportRowActionResult> {
  const resolved = await resolveReport(input.token, input.now, input.reportsRepository);

  if (resolved.status !== "live") {
    return resolved;
  }

  const { report } = resolved;
  const { loopId, action } = input.body;

  // Refresh live sections after a successful mutation/draft so the client re-renders
  // with the loop moved to its new bucket (live-query, never a stale snapshot).
  const refreshSections = async (): Promise<ReportSections> => {
    const { loops, loopActivity } = await input.reportsRepository.loadLoopsForScope(
      report.userId,
      report.scope,
    );
    return assembleReport({
      kind: report.kind,
      scope: report.scope,
      now: input.now,
      loops,
      loopActivity,
    });
  };

  // ── draft_nudge: NEVER mutates loop state ───────────────────────────────────
  if (action === "draft_nudge") {
    if (!input.enqueueDraftNudge) {
      return { status: "invalid", error: "draft nudge not supported" };
    }
    // Scope by report.userId (NOT any id from the request body).
    await input.enqueueDraftNudge({ userId: report.userId, loopId });
    return { status: "drafted", sections: await refreshSections() };
  }

  // ── state-mutating actions ──────────────────────────────────────────────────
  let mutationAction: "mark_done" | "dismiss" | "snooze";
  let snoozeUntil: Date | null | undefined;

  if (action === "done") {
    mutationAction = "mark_done";
  } else if (action === "dismiss") {
    mutationAction = "dismiss";
  } else if (action === "snooze") {
    mutationAction = "snooze";
    if (!input.body.snoozeUntil) {
      return { status: "invalid", error: "snooze requires snoozeUntil" };
    }
    const parsed = new Date(input.body.snoozeUntil);
    if (Number.isNaN(parsed.getTime())) {
      return { status: "invalid", error: "snooze requires snoozeUntil" };
    }
    snoozeUntil = parsed;
  } else {
    return { status: "invalid", error: `unknown action: ${action as string}` };
  }

  // commandText for a row action = the action verb ("done"/"dismiss"/"snooze").
  // This is the row-action PROVENANCE string; the D2 parity test aligns commandText
  // across the email-command path and this report-row-action path.
  const commandText = action;

  try {
    // PARITY: web row actions mutate state through the SAME mutateLoopState funnel
    // email commands use, tagged source: "report_row_action". Scope by report.userId
    // (NOT the request body) — mutateLoopState scopes the DB write by (loopId, userId),
    // so a loop not owned by report.userId throws and is caught below.
    await mutateLoopState({
      userId: report.userId,
      loopId,
      action: mutationAction,
      snoozeUntil,
      commandText,
      source: "report_row_action",
      repository: input.loopRepository,
    });
  } catch {
    return { status: "invalid", error: "loop not found" };
  }

  return { status: "applied", sections: await refreshSections() };
}

// ---------------------------------------------------------------------------
// recordReportView
// ---------------------------------------------------------------------------

export async function recordReportView(input: {
  reportId: string;
  userId: string;
  now: Date;
  repository: ReportsRepository;
  emit?: (event: {
    name: "report.viewed";
    data: {
      userId: string;
      reportId: string;
      viewedAt: string;
      viewerKind: "anonymous_link" | "clerk_session";
    };
  }) => Promise<void>;
  viewerKind: "anonymous_link" | "clerk_session";
}): Promise<void> {
  // Debounce lives in the repo: touchReportViewed returns true only when it actually
  // bumped, so we emit report.viewed at most once per debounce window.
  const bumped = await input.repository.touchReportViewed(input.reportId, input.now);
  if (bumped && input.emit) {
    await input.emit({
      name: "report.viewed",
      data: {
        userId: input.userId,
        reportId: input.reportId,
        viewedAt: input.now.toISOString(),
        viewerKind: input.viewerKind,
      },
    });
  }
}
