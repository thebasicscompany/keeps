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
import type { Route } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { standingGrants, userIdentities } from "@/db/schema";
import { buildRecipeCatalog, grantRowViewModel } from "@/automation/automations-view";
import { cardClass, labelClass, mutedClass, statusBadgeVariants } from "../_ui";

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

export default async function AutomationsPage() {
  const userId = await resolveInternalUserId();
  if (!userId) {
    redirect("/sign-in?redirect_url=/settings/automations" as Route);
  }

  const grantRows = await getDb()
    .select({
      recipeKey: standingGrants.recipeKey,
      status: standingGrants.status,
      expiresAt: standingGrants.expiresAt,
    })
    .from(standingGrants)
    .where(eq(standingGrants.userId, userId))
    .orderBy(desc(standingGrants.createdAt));

  const now = new Date();
  const grants = grantRows.map((g) => grantRowViewModel(g, now));
  const catalog = buildRecipeCatalog();

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
                <span
                  className={`keeps-mono inline-flex h-7 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${
                    g.live ? statusBadgeVariants.active : statusBadgeVariants.none
                  }`}
                >
                  {g.live ? "active" : g.status}
                </span>
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
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
