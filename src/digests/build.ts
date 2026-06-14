/**
 * Digest categorization — pure function, no DB or side-effects.
 *
 * Bucket derivation (per Deliverable #8, AR-6):
 *   needsAttention : status in (open, waiting_on_me)
 *                    AND (dueAt <= now+24h OR nextCheckAt <= now)
 *   waitingOnOthers: status = waiting_on_other
 *   dueSoon        : status in (open, waiting_on_me)
 *                    AND dueAt between now+24h (exclusive) and now+72h (inclusive)
 *   stale          : status in (open, waiting_on_me, waiting_on_other)
 *                    AND updatedAt < now - 7d
 *   recentlyDone   : status = done AND updatedAt >= now - 24h
 *
 * Deduplication judgment calls (documented):
 *   1. needsAttention wins over dueSoon: a loop eligible for both appears only in
 *      needsAttention.  dueSoon is explicitly defined as *between* 24h and 72h, so
 *      the boundary case (dueAt == now+24h) belongs to needsAttention by the <=
 *      operator.  The dedupe step is therefore mathematically necessary given the
 *      ranges, but is made explicit to guard against future range changes.
 *   2. stale may co-exist with a status bucket (waitingOnOthers, needsAttention,
 *      dueSoon).  The spec says "a loop may appear in stale plus its status bucket
 *      only if the plan implies it".  We allow stale overlap only with
 *      waitingOnOthers; needsAttention/dueSoon loops that are also stale appear
 *      only in needsAttention/dueSoon (the more actionable bucket wins).
 *      Rationale: if something is urgent enough to need attention, surfacing it
 *      twice in the same digest would be redundant noise.
 *
 * Coverage counts:
 *   ACTIVE statuses for totalActive count:
 *     open, waiting_on_me, waiting_on_other
 *   Rationale: candidate/blocked/snoozed loops are not yet confirmed or are
 *   intentionally deferred; including them in the "tracking N loops" coverage
 *   statement would overstate product scope.  Done/dismissed are excluded because
 *   they represent closed work.  This matches AR-9's framing: coverage is what
 *   Keeps is currently watching, not everything it ever touched.
 *
 * Cap: 5 per section.
 *
 * Ordering (most urgent first within each bucket):
 *   needsAttention : dueAt ASC (nulls last), then nextCheckAt ASC (nulls last)
 *   waitingOnOthers: updatedAt ASC (longest-waiting first)
 *   dueSoon        : dueAt ASC (nulls last)
 *   stale          : updatedAt ASC (most stale first)
 *   recentlyDone   : updatedAt DESC (most recently done first)
 */

import type { LoopStatus } from "@/agent/schemas";

/** Minimum shape required from a loop input record. */
export interface DigestLoopInput {
  id: string;
  emailThreadId: string;
  // Full persisted status set incl. Phase 7 'suppressed' (which matches no digest bucket,
  // so suppressed loops are naturally excluded from every section).
  status: LoopStatus;
  summary: string;
  dueAt: Date | null;
  nextCheckAt: Date | null;
  updatedAt: Date;
  lastNudgedAt: Date | null;
}

/** Minimum shape required from a user input record. */
export interface DigestUserInput {
  id: string;
  email: string;
  displayName?: string | null;
}

/** A loop entry in a digest section, with resolved urgency metadata. */
export interface DigestEntry {
  loopId: string;
  summary: string;
  dueAt: Date | null;
  nextCheckAt: Date | null;
  updatedAt: Date;
  emailThreadId: string;
}

/** The fully-built digest model returned by buildDigest. */
export interface DigestModel {
  /** User the digest is for. */
  user: DigestUserInput;
  /** The `now` instant this digest was built at. */
  builtAt: Date;
  /** Loops requiring the user's immediate action. */
  needsAttention: DigestEntry[];
  /** Loops waiting on someone else. */
  waitingOnOthers: DigestEntry[];
  /** Loops due between 24 h and 72 h from now. */
  dueSoon: DigestEntry[];
  /** Loops that haven't moved in 7 days. */
  stale: DigestEntry[];
  /** Loops completed in the last 24 h. */
  recentlyDone: DigestEntry[];
  /**
   * Count of loops in ACTIVE statuses (open, waiting_on_me, waiting_on_other)
   * across the full input set (not capped).
   */
  totalActiveLoops: number;
  /**
   * Count of DISTINCT emailThreadId values among the active loops.
   */
  distinctActiveThreads: number;
  /**
   * Phase 7 AR-9: counts of loops auto-reconciled since the last digest.
   * Optional — omit when no reconciliation has occurred (absent ⇒ no line
   * rendered in the digest email).
   *
   * TODO(Phase 7 wiring): source this count from loop_events at the digest
   * cron call site (e.g. query reconciled events since the user's last digest
   * sent_at and pass the tallies here). See src/admin/reconciliations.ts for
   * the listRecentReconciliations helper. Do NOT modify src/loops/* to wire
   * this — do it in the digest cron/service layer.
   */
  autoReconciled?: {
    /** Loops auto-advanced (action='update') by an incoming reply. */
    advanced: number;
    /** Loops auto-closed (action='close') by an incoming reply. */
    closed: number;
  };
}

const SECTION_CAP = 5;

const ACTIVE_STATUSES = new Set<DigestLoopInput["status"]>([
  "open",
  "waiting_on_me",
  "waiting_on_other",
]);

/** ms helper constants */
const MS_1H = 60 * 60 * 1000;
const MS_24H = 24 * MS_1H;
const MS_72H = 72 * MS_1H;
const MS_7D = 7 * 24 * MS_1H;

function toEntry(loop: DigestLoopInput): DigestEntry {
  return {
    loopId: loop.id,
    summary: loop.summary,
    dueAt: loop.dueAt,
    nextCheckAt: loop.nextCheckAt,
    updatedAt: loop.updatedAt,
    emailThreadId: loop.emailThreadId,
  };
}

/**
 * Compare two nullable Dates ascending; nulls sort last.
 */
function cmpNullableDateAsc(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

export interface BuildDigestInput {
  user: DigestUserInput;
  loops: DigestLoopInput[];
  now: Date;
  /**
   * Phase 7 AR-9: optional auto-reconciliation counts to surface in the digest.
   * Absent ⇒ no reconciliation line rendered.
   */
  autoReconciled?: { advanced: number; closed: number };
}

/**
 * Build a DigestModel by categorizing loops into derived buckets.
 * All inputs are required; `now` must be injected (no implicit new Date()).
 */
export function buildDigest({ user, loops, now, autoReconciled }: BuildDigestInput): DigestModel {
  const nowMs = now.getTime();

  // ---- Coverage counts (before any filtering/capping) ----
  const activeLoops = loops.filter((l) => ACTIVE_STATUSES.has(l.status));
  const totalActiveLoops = activeLoops.length;
  const distinctActiveThreads = new Set(activeLoops.map((l) => l.emailThreadId)).size;

  // ---- Bucket classification ----

  // needsAttention: (open | waiting_on_me) AND (dueAt <= now+24h OR nextCheckAt <= now)
  const needsAttentionRaw = loops.filter((l) => {
    if (l.status !== "open" && l.status !== "waiting_on_me") return false;
    const dueUrgent = l.dueAt !== null && l.dueAt.getTime() <= nowMs + MS_24H;
    const checkDue = l.nextCheckAt !== null && l.nextCheckAt.getTime() <= nowMs;
    return dueUrgent || checkDue;
  });

  // dueSoon: (open | waiting_on_me) AND dueAt between now+24h (exclusive) and now+72h (inclusive)
  // needsAttention wins — remove dueSoon candidates already in needsAttention
  const needsAttentionIds = new Set(needsAttentionRaw.map((l) => l.id));
  const dueSoonRaw = loops.filter((l) => {
    if (needsAttentionIds.has(l.id)) return false;
    if (l.status !== "open" && l.status !== "waiting_on_me") return false;
    if (l.dueAt === null) return false;
    const dueMs = l.dueAt.getTime();
    return dueMs > nowMs + MS_24H && dueMs <= nowMs + MS_72H;
  });

  // waitingOnOthers: status = waiting_on_other
  const waitingOnOthersRaw = loops.filter((l) => l.status === "waiting_on_other");

  // stale: (open | waiting_on_me | waiting_on_other) AND updatedAt < now - 7d
  // Overlap rule: stale may co-exist with waitingOnOthers, but NOT with needsAttention/dueSoon.
  const staleRaw = loops.filter((l) => {
    if (l.status !== "open" && l.status !== "waiting_on_me" && l.status !== "waiting_on_other") {
      return false;
    }
    if (l.updatedAt.getTime() >= nowMs - MS_7D) return false;
    // Exclude loops already bucketed into needsAttention or dueSoon
    if (needsAttentionIds.has(l.id)) return false;
    const isDueSoon = dueSoonRaw.some((d) => d.id === l.id);
    if (isDueSoon) return false;
    return true;
  });

  // recentlyDone: status = done AND updatedAt >= now - 24h
  const recentlyDoneRaw = loops.filter(
    (l) => l.status === "done" && l.updatedAt.getTime() >= nowMs - MS_24H,
  );

  // ---- Ordering ----

  const sortedNeedsAttention = [...needsAttentionRaw].sort((a, b) => {
    const byDue = cmpNullableDateAsc(a.dueAt, b.dueAt);
    if (byDue !== 0) return byDue;
    return cmpNullableDateAsc(a.nextCheckAt, b.nextCheckAt);
  });

  const sortedWaitingOnOthers = [...waitingOnOthersRaw].sort(
    (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
  );

  const sortedDueSoon = [...dueSoonRaw].sort((a, b) => cmpNullableDateAsc(a.dueAt, b.dueAt));

  const sortedStale = [...staleRaw].sort(
    (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
  );

  const sortedRecentlyDone = [...recentlyDoneRaw].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );

  return {
    user,
    builtAt: now,
    needsAttention: sortedNeedsAttention.slice(0, SECTION_CAP).map(toEntry),
    waitingOnOthers: sortedWaitingOnOthers.slice(0, SECTION_CAP).map(toEntry),
    dueSoon: sortedDueSoon.slice(0, SECTION_CAP).map(toEntry),
    stale: sortedStale.slice(0, SECTION_CAP).map(toEntry),
    recentlyDone: sortedRecentlyDone.slice(0, SECTION_CAP).map(toEntry),
    totalActiveLoops,
    distinctActiveThreads,
    ...(autoReconciled !== undefined ? { autoReconciled } : {}),
  };
}
