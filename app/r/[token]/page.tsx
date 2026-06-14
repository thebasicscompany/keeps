/**
 * app/r/[token]/page.tsx (Phase 5 C3)
 *
 * The memo-style report page — the ONLY entry point is the tokenized /r/<token>
 * link minted in the report email. It is private, never indexed, and live-queried
 * on every load (never cached / never snapshotted; see reports/service).
 *
 * Three render outcomes:
 *   - not_found / expired → an IDENTICAL friendly dead-end (HTTP 200, never a 404,
 *     never a leak about whether a report existed).
 *   - live → the memo: ReportHeader + frozen model summary + pre-ordered sections,
 *     with the per-row sensitive-evidence gate opened only for the report owner
 *     (resolved via Clerk session → internal user id === report.userId).
 *
 * Server component. Only RowActions deep in the tree is a client component.
 */

import { and, eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";

import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { loadReportByToken, recordReportView } from "@/reports/service";
import { DrizzleReportsRepository } from "@/reports/repository";
import { ReportHeader } from "@/reports/components/ReportHeader";
import { ReportSection } from "@/reports/components/ReportSection";
import { EntityHeader } from "@/reports/components/EntityHeader";
import { sendEvent } from "@/workflows/events";

// Live-query: never cache. auth() also requires a dynamic render.
export const dynamic = "force-dynamic";

// Report links are private — never index, never follow.
export const metadata = {
  robots: { index: false, follow: false },
};

const DEAD_END_COPY =
  'This Keeps view is no longer available. Email "what are my insights?" for a fresh link.';

/**
 * Resolve the current Clerk session to the internal users.id, if any.
 * Returns null when there is no session or the identity is unmapped.
 * Pattern mirrors app/settings/page.tsx.
 */
async function resolveInternalUserId(): Promise<string | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return null;
  }

  const db = getDb();
  const [identity] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  return identity?.userId ?? null;
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const now = new Date();
  const repository = new DrizzleReportsRepository();

  const result = await loadReportByToken({ token, now, repository });

  // ── Dead-end: not_found AND expired collapse to the SAME page (HTTP 200) ─────
  // We never call notFound() (that returns 404 and would leak the not_found vs
  // expired distinction); we never log the token or which branch we took.
  if (result.status !== "live") {
    return (
      <main className="relative z-10 flex min-h-svh items-center justify-center bg-[#FAFAF8] px-5 text-[#14140F]">
        <p className="max-w-[420px] text-center text-[15px] font-medium leading-snug text-[#6F6F66]">
          {DEAD_END_COPY}
        </p>
      </main>
    );
  }

  // ── Evidence gate: only the report owner (via Clerk session) sees sensitive
  // evidence. No session, or a session that does not map to report.userId → false.
  const internalUserId = await resolveInternalUserId();
  const canViewSensitiveEvidence = internalUserId === result.report.userId;

  // ── Record the view — best-effort. Metrics must NEVER block the page render.
  try {
    await recordReportView({
      reportId: result.report.id,
      userId: result.report.userId,
      now,
      repository,
      viewerKind: canViewSensitiveEvidence ? "clerk_session" : "anonymous_link",
      emit: (event) => sendEvent(event.name, event.data),
    });
  } catch {
    /* view metrics are best-effort; never block the page */
  }

  const summary = result.summary.trim();

  return (
    <main className="relative z-10 min-h-svh bg-[#FAFAF8] text-[#14140F]">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-5 py-9 sm:px-6">
        <ReportHeader
          kind={result.sections.kind}
          scope={result.sections.scope}
          totalOpen={result.sections.totalOpen}
          now={result.sections.now}
        />

        {/* Entity-centric header block: shown when this is a graph-resolved entity report */}
        {result.sections.kind === "entity" && typeof result.sections.scope.entityId === "string" && (
          <EntityHeader
            scope={result.sections.scope}
            totalOpen={result.sections.totalOpen}
            totalClosed={typeof result.sections.scope.closedCount === "number" ? result.sections.scope.closedCount : 0}
            now={result.sections.now}
          />
        )}

        {summary && (
          <p className="-mt-2 text-[15px] font-medium leading-snug text-[#6F6F66]">
            {summary}
          </p>
        )}

        {result.sections.sections.map((section) => (
          <ReportSection
            key={section.key}
            section={section}
            token={token}
            canViewSensitiveEvidence={canViewSensitiveEvidence}
          />
        ))}
      </div>
    </main>
  );
}
