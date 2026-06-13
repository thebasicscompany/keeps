import { reportConfig, type ReportConfig } from "./config";

// ── Input types ──────────────────────────────────────────────────────────────

export type ReportLoopParticipant = { name?: string | null; email?: string | null };

export type ReportLoop = {
  id: string;
  status:
    | "candidate"
    | "open"
    | "waiting_on_me"
    | "waiting_on_other"
    | "blocked"
    | "snoozed"
    | "done"
    | "dismissed";
  summary: string;
  ownerText: string | null;
  requesterText: string | null;
  dueAt: Date | null;
  confidence: number;
  participants: ReportLoopParticipant[];
  sourceQuote: string;
  sourceEvidenceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ReportLoopActivity = {
  loopId: string;
  lastActivityAt: Date | null; // null => no activity since creation
};

export type ReportKind = "insights" | "waiting_on" | "stale" | "weekly" | "entity";

export type ReportScope = { entity?: string; daysStale?: number } & Record<string, unknown>;

// ── Output types ─────────────────────────────────────────────────────────────

export type SectionKey =
  | "needs_you"
  | "due_soon"
  | "overdue"
  | "waiting_on_others"
  | "stale"
  | "recently_done";

export type ReportRow = { loop: ReportLoop; dueRelativeMs: number | null; importance: number };

export type ReportSection = { key: SectionKey; title: string; rows: ReportRow[] };

export type ReportSections = {
  kind: ReportKind;
  scope: ReportScope;
  now: Date;
  totalOpen: number;
  sections: ReportSection[];
};

// ── Section metadata (fixed order) ───────────────────────────────────────────

const SECTION_ORDER: Array<{ key: SectionKey; title: string }> = [
  { key: "needs_you", title: "Needs you" },
  { key: "due_soon", title: "Due soon" },
  { key: "overdue", title: "Overdue" },
  { key: "waiting_on_others", title: "Waiting on others" },
  { key: "stale", title: "Stale" },
  { key: "recently_done", title: "Recently done" },
];

// ── Entity matching ──────────────────────────────────────────────────────────

function matchesEntity(loop: ReportLoop, entity: string): boolean {
  const needle = entity.toLowerCase();
  const hasAt = needle.includes("@");

  // Check participants
  for (const p of loop.participants) {
    if (p.name && p.name.toLowerCase().includes(needle)) return true;
    if (p.email) {
      const emailLower = p.email.toLowerCase();
      if (emailLower.includes(needle)) return true;
      // Domain match: if needle has no '@', match against email domain
      if (!hasAt) {
        const atIdx = emailLower.indexOf("@");
        if (atIdx !== -1) {
          const domain = emailLower.slice(atIdx + 1);
          if (domain.includes(needle)) return true;
        }
      }
    }
  }

  // Check ownerText
  if (loop.ownerText && loop.ownerText.toLowerCase().includes(needle)) return true;

  // Check requesterText
  if (loop.requesterText && loop.requesterText.toLowerCase().includes(needle)) return true;

  // Check sourceQuote
  if (loop.sourceQuote && loop.sourceQuote.toLowerCase().includes(needle)) return true;

  return false;
}

// ── Importance scoring ───────────────────────────────────────────────────────

function computeImportance(
  loop: ReportLoop,
  now: Date,
  lastActivityAt: Date | null,
): number {
  const nowMs = now.getTime();
  const dueMs = loop.dueAt ? loop.dueAt.getTime() : null;

  // Primary: due proximity
  let primary = 0;
  if (dueMs !== null) {
    if (dueMs < nowMs) {
      primary = 3; // overdue
    } else if (dueMs <= nowMs + 24 * 60 * 60 * 1000) {
      primary = 2; // due within 24h
    } else if (dueMs <= nowMs + 7 * 24 * 60 * 60 * 1000) {
      primary = 1; // due within 7d
    }
  }

  // Secondary: waiting duration (log-scaled days since last activity or createdAt)
  const activityTs = lastActivityAt ?? loop.createdAt;
  const daysSinceActivity = (nowMs - activityTs.getTime()) / (1000 * 60 * 60 * 24);
  const secondary = Math.log1p(daysSinceActivity);

  // Tertiary: confidence (higher first)
  const tertiary = loop.confidence;

  return primary * 1000 + secondary * 10 + tertiary;
}

// ── Main assembleReport function ──────────────────────────────────────────────

export function assembleReport(input: {
  kind: ReportKind;
  scope: ReportScope;
  now: Date;
  loops: ReportLoop[];
  loopActivity: ReportLoopActivity[];
  config?: ReportConfig;
}): ReportSections {
  const { kind, scope, now, loops, loopActivity, config = reportConfig } = input;
  const nowMs = now.getTime();

  // Build activity lookup map
  const activityMap = new Map<string, Date | null>();
  for (const a of loopActivity) {
    activityMap.set(a.loopId, a.lastActivityAt);
  }

  // Derived thresholds
  const needsYouCutoffMs = nowMs + config.needsYouHours * 60 * 60 * 1000;
  const dueSoonCutoffMs = nowMs + config.dueSoonDays * 24 * 60 * 60 * 1000;
  const staleCutoffMs = nowMs - config.staleDays * 24 * 60 * 60 * 1000;
  const recentlyDoneCutoffMs = nowMs - config.recentlyDoneDays * 24 * 60 * 60 * 1000;

  // Filter loops
  let workingLoops = loops;

  // Entity scoping: only filter when kind === 'entity' and entity is non-empty
  if (kind === "entity" && scope.entity && scope.entity.length > 0) {
    workingLoops = workingLoops.filter((l) => matchesEntity(l, scope.entity!));
  }

  // Exclude candidate, blocked, dismissed from all sections
  // (they won't match any predicate anyway, but be explicit)
  workingLoops = workingLoops.filter(
    (l) => l.status !== "candidate" && l.status !== "blocked" && l.status !== "dismissed",
  );

  // Count totalOpen before bucketing (open|waiting_on_me|waiting_on_other after scope filter)
  const totalOpen = workingLoops.filter(
    (l) =>
      l.status === "open" ||
      l.status === "waiting_on_me" ||
      l.status === "waiting_on_other",
  ).length;

  // Section buckets
  const buckets = new Map<SectionKey, ReportLoop[]>();
  for (const s of SECTION_ORDER) {
    buckets.set(s.key, []);
  }

  // Assign each loop to the first matching section (first-match-wins)
  for (const loop of workingLoops) {
    const dueMs = loop.dueAt ? loop.dueAt.getTime() : null;
    const lastActivityAt = activityMap.has(loop.id) ? activityMap.get(loop.id)! : null;
    // Effective activity timestamp: use lastActivityAt if present, else createdAt
    const effectiveActivityMs = (lastActivityAt ?? loop.createdAt).getTime();

    let assigned = false;

    // 1. needs_you: status === waiting_on_me, OR (status === open AND dueAt <= now + 48h)
    if (
      loop.status === "waiting_on_me" ||
      (loop.status === "open" && dueMs !== null && dueMs <= needsYouCutoffMs)
    ) {
      buckets.get("needs_you")!.push(loop);
      assigned = true;
    }

    // 2. due_soon: dueAt in (now, now+7d] and NOT already assigned
    if (!assigned && dueMs !== null && dueMs > nowMs && dueMs <= dueSoonCutoffMs) {
      buckets.get("due_soon")!.push(loop);
      assigned = true;
    }

    // 3. overdue: dueAt < now and status NOT in (done, dismissed, snoozed)
    if (
      !assigned &&
      dueMs !== null &&
      dueMs < nowMs &&
      loop.status !== "done" &&
      loop.status !== "dismissed" &&
      loop.status !== "snoozed"
    ) {
      buckets.get("overdue")!.push(loop);
      assigned = true;
    }

    // 4. waiting_on_others: status === waiting_on_other
    if (!assigned && loop.status === "waiting_on_other") {
      buckets.get("waiting_on_others")!.push(loop);
      assigned = true;
    }

    // 5. stale: status in (open, waiting_on_me, waiting_on_other) AND effectiveActivity <= now - staleDays
    if (
      !assigned &&
      (loop.status === "open" ||
        loop.status === "waiting_on_me" ||
        loop.status === "waiting_on_other") &&
      effectiveActivityMs <= staleCutoffMs
    ) {
      buckets.get("stale")!.push(loop);
      assigned = true;
    }

    // 6. recently_done: status === done AND updatedAt >= now - recentlyDoneDays
    if (!assigned && loop.status === "done" && loop.updatedAt.getTime() >= recentlyDoneCutoffMs) {
      buckets.get("recently_done")!.push(loop);
      assigned = true;
    }

    void assigned; // suppress unused warning — intentional fallthrough for unmatched loops
  }

  // Build sections in fixed order with importance-sorted rows
  const sections: ReportSection[] = SECTION_ORDER.map(({ key, title }) => {
    const sectionLoops = buckets.get(key)!;

    const rows: ReportRow[] = sectionLoops.map((loop) => {
      const lastActivityAt = activityMap.has(loop.id) ? activityMap.get(loop.id)! : null;
      const dueRelativeMs = loop.dueAt ? loop.dueAt.getTime() - nowMs : null;
      const importance = computeImportance(loop, now, lastActivityAt);
      return { loop, dueRelativeMs, importance };
    });

    // Sort by importance DESC, stable (JS sort is stable since ES2019)
    rows.sort((a, b) => b.importance - a.importance);

    return { key, title, rows };
  });

  return {
    kind,
    scope,
    now,
    totalOpen,
    sections,
  };
}
