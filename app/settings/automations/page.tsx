/**
 * app/settings/automations/page.tsx
 *
 * Org-visibility automations surface (Wave 4). Shows the code-defined recipe catalog (what each
 * automation reads, what it can do automatically vs. only with your approval, its lifetime) plus
 * the signed-in user's standing grants. Read-only for now; grant create/pause/revoke controls land
 * with the executor wiring. Renders inside the settings shell (layout.tsx).
 */
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { automationRuns, standingGrants, userIdentities } from "@/db/schema";
import { automationRunRowViewModel, buildRecipeCatalog, grantRowViewModel } from "@/automation/automations-view";
import { cardClass, compactPrimaryButtonClass, labelClass, mutedClass, secondaryButtonClass, statusBadgeVariants } from "../_ui";
import { enableAutomation, revokeAutomation, runAutomationNowAction } from "./actions";

export const dynamic = "force-dynamic";

async function resolveInternalUserId(): Promise<string | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const [identity] = await getDb()
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(eq(userIdentities.provider, "clerk"), eq(userIdentities.providerAccountId, clerkUserId)),
    )
    .limit(1);
  return identity?.userId ?? null;
}

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const userId = await resolveInternalUserId();
  if (!userId) {
    redirect("/sign-in?redirect_url=/settings/automations" as Route);
  }

  const grantRows = await getDb()
    .select({
      id: standingGrants.id,
      recipeKey: standingGrants.recipeKey,
      status: standingGrants.status,
      expiresAt: standingGrants.expiresAt,
    })
    .from(standingGrants)
    .where(eq(standingGrants.userId, userId))
    .orderBy(desc(standingGrants.createdAt));

  const now = new Date();
  const grants = grantRows.map((g) => ({ ...grantRowViewModel(g, now), id: g.id }));
  const liveRecipeKeys = new Set(grants.filter((g) => g.live).map((g) => g.recipeKey));
  const catalog = buildRecipeCatalog();

  const runRows = await getDb()
    .select({
      id: automationRuns.id,
      recipeKey: automationRuns.recipeKey,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
      provenance: automationRuns.provenance,
    })
    .from(automationRuns)
    .where(eq(automationRuns.userId, userId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(20);
  const runs = runRows.map(automationRunRowViewModel);

  return (
    <div className={cardClass}>
      <div className="mb-8">
        <h2 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
          Automations
        </h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          Standing permissions for repeated, low-risk work — narrow, revocable, and never able to
          act on anything outside what you can see.
        </p>
      </div>

      {notice ? (
        <div
          className="mb-6 rounded-[4px] border border-[#DEDED8] bg-[#F4F4F0] px-4 py-3 text-[14px] text-[#14140F]"
          data-testid="run-notice"
        >
          {notice}
        </div>
      ) : null}

      {/* Active grants */}
      <section className="mb-8" data-testid="active-grants">
        <h3 className={`mb-3 ${labelClass}`}>Your automations</h3>
        {grants.length === 0 ? (
          <p className={`text-[15px] ${mutedClass}`} data-testid="no-grants">
            No automations enabled yet. Pick one below to grant it.
          </p>
        ) : (
          <ul className="space-y-2">
            {grants.map((g, i) => (
              <li
                key={`${g.recipeKey}-${i}`}
                className="flex items-center justify-between rounded-[4px] border border-[#DEDED8] px-4 py-3"
              >
                <span className="text-[15px] font-semibold text-[#14140F]">{g.recipeName}</span>
                <div className="flex items-center gap-3">
                  <span
                    className={`keeps-mono inline-flex h-7 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${
                      g.live ? statusBadgeVariants.active : statusBadgeVariants.none
                    }`}
                  >
                    {g.live ? "active" : g.status}
                  </span>
                  {g.live ? (
                    <form action={revokeAutomation.bind(null, g.id)}>
                      <button type="submit" className={`${secondaryButtonClass} !h-8 !px-3 !text-xs`}>
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent runs */}
      <section className="mb-8" data-testid="recent-runs">
        <h3 className={`mb-3 ${labelClass}`}>Recent runs</h3>
        {runs.length === 0 ? (
          <p className={`text-[15px] ${mutedClass}`} data-testid="no-runs">
            No automation runs yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/settings/automations/runs/${r.id}` as Route}
                  className="flex items-center justify-between gap-3 rounded-[4px] border border-[#DEDED8] px-4 py-3 transition-colors hover:border-[#14140F]"
                >
                  <div className="min-w-0">
                    <span className="text-[15px] font-semibold text-[#14140F]">{r.recipeName}</span>
                    {r.detail ? <p className={`truncate text-[13px] ${mutedClass}`}>{r.detail}</p> : null}
                  </div>
                  <span
                    className={`keeps-mono inline-flex h-7 shrink-0 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${
                      r.status === "completed"
                        ? statusBadgeVariants.active
                        : r.status === "failed"
                          ? statusBadgeVariants.error
                          : statusBadgeVariants.none
                    }`}
                  >
                    {r.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recipe catalog */}
      <section data-testid="recipe-catalog">
        <h3 className={`mb-3 ${labelClass}`}>Available automations</h3>
        <ul className="space-y-3">
          {catalog.map((r) => (
            <li
              key={r.key}
              className="rounded-[4px] border border-[#DEDED8] p-4"
              data-testid={`recipe-${r.key}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[16px] font-semibold text-[#14140F]">{r.displayName}</span>
                <span className={`keeps-mono text-[11px] uppercase ${mutedClass}`}>
                  {r.expiryDays}-day grant
                </span>
              </div>
              <p className={`mt-1 text-[14px] ${mutedClass}`}>{r.description}</p>
              <div className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
                <div>
                  <div className={`mb-1 font-semibold text-[#14140F]`}>Runs automatically</div>
                  <ul className={`list-disc pl-4 ${mutedClass}`}>
                    {r.autoActions.length > 0 ? (
                      r.autoActions.map((a) => <li key={a}>{a}</li>)
                    ) : (
                      <li>nothing without your approval</li>
                    )}
                  </ul>
                </div>
                <div>
                  <div className={`mb-1 font-semibold text-[#14140F]`}>Needs your approval</div>
                  <ul className={`list-disc pl-4 ${mutedClass}`}>
                    {r.approvalActions.length > 0 ? (
                      r.approvalActions.map((a) => <li key={a}>{a}</li>)
                    ) : (
                      <li>—</li>
                    )}
                  </ul>
                </div>
              </div>
              <div className={`mt-3 text-[12px] ${mutedClass}`}>
                <span className="font-semibold text-[#14140F]">Reads:</span> {r.reads.join("; ")}
              </div>
              <div className="mt-4 flex items-center gap-3">
                {liveRecipeKeys.has(r.key) ? (
                  <>
                    <span
                      className={`keeps-mono inline-flex h-9 items-center rounded-[4px] px-3 text-[11px] uppercase ${statusBadgeVariants.active}`}
                    >
                      Enabled
                    </span>
                    <form action={runAutomationNowAction.bind(null, r.key)}>
                      <button type="submit" className={compactPrimaryButtonClass} data-testid={`run-now-${r.key}`}>
                        Run now
                      </button>
                    </form>
                  </>
                ) : (
                  <form action={enableAutomation.bind(null, r.key)}>
                    <button type="submit" className={compactPrimaryButtonClass}>
                      Enable
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
