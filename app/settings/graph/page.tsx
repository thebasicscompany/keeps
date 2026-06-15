/**
 * app/settings/graph/page.tsx
 *
 * The user's knowledge graph: every person + company Keeps has resolved from
 * the emails they've forwarded, with their open loops, and people grouped under
 * their company. Read-only; renders inside the settings shell.
 */

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { getUserGraph, type GraphEntity, type GraphLoop } from "@/entities/listing";
import { cardClass, mutedClass } from "../_ui";

// User-scoped + always reflects the latest captures.
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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function KindBadge({ kind }: { kind: GraphEntity["kind"] }) {
  const label = kind === "company" ? "Company" : kind === "person" ? "Person" : "Mailbox";
  return (
    <span className="keeps-mono inline-block rounded-[3px] border border-[#C1F5DF] bg-[#C1F5DF] px-2 py-0.5 text-[10px] uppercase text-[#14140F]">
      {label}
    </span>
  );
}

function LoopList({ loops }: { loops: GraphLoop[] }) {
  if (loops.length === 0) {
    return <p className={`mt-3 text-sm ${mutedClass}`}>No open loops.</p>;
  }
  return (
    <ul className="mt-3 space-y-2.5">
      {loops.map((loop) => (
        <li key={loop.id} className="flex items-start gap-2.5">
          <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-[#1E6B4F]" />
          <div>
            <div className="text-sm font-semibold leading-snug text-[#14140F]">{loop.summary}</div>
            <div className={`mt-0.5 text-xs ${mutedClass}`}>
              {loop.roles.join(" · ")}
              {loop.dueAtIso ? ` · due ${fmtDate(loop.dueAtIso)}` : ""}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PersonChip({ person }: { person: GraphEntity }) {
  const initial = person.displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="inline-flex items-center gap-2 rounded-[4px] border border-[#DEDED8] bg-[#F5F5F1] px-2.5 py-1 text-xs text-[#14140F]">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-[#1E6B4F] text-[10px] font-bold text-white">
        {initial}
      </span>
      <span className="font-medium">{person.displayName}</span>
      {person.openCount > 0 ? <span className={mutedClass}>· {person.openCount} open</span> : null}
    </span>
  );
}

function Counts({ open, closed }: { open: number; closed: number }) {
  return (
    <div className={`mt-1 text-sm font-medium ${mutedClass}`}>
      {open} open · {closed} closed
    </div>
  );
}

export default async function GraphPage() {
  const userId = await resolveInternalUserId();
  if (!userId) {
    redirect("/sign-in?redirect_url=/settings/graph" as Route);
  }

  const { companies, people, totals } = await getUserGraph(userId);
  const isEmpty = totals.entities === 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[18px] font-bold leading-tight text-[#14140F]">Knowledge graph</h2>
        <p className={`mt-1 text-sm leading-relaxed ${mutedClass}`}>
          The people and companies Keeps has learned — built only from the emails you've forwarded.
          Nothing here came from scanning your inbox.
        </p>
        {!isEmpty ? (
          <p className="keeps-mono mt-2.5 text-xs uppercase text-[#1E6B4F]">
            {totals.companies} {totals.companies === 1 ? "company" : "companies"} ·{" "}
            {totals.people} {totals.people === 1 ? "person" : "people"} ·{" "}
            {totals.openLoops} open {totals.openLoops === 1 ? "loop" : "loops"}
          </p>
        ) : null}
      </div>

      {isEmpty ? (
        <div className={cardClass}>
          <div className="text-[15px] font-semibold text-[#14140F]">Nothing captured yet.</div>
          <p className={`mt-1.5 text-sm leading-relaxed ${mutedClass}`}>
            Forward or CC an email to{" "}
            <span className="font-semibold text-[#14140F]">agent@keeps.email</span>. The people and
            companies in it will appear here, each with the open loops Keeps found — and links to ask
            about them.
          </p>
        </div>
      ) : (
        <>
          {companies.length > 0 ? (
            <section className="space-y-3">
              {companies.map((company) => (
                <div key={company.id} className={cardClass}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[17px] font-bold text-[#14140F]">{company.displayName}</span>
                      <KindBadge kind="company" />
                    </div>
                    <span className={`flex-none whitespace-nowrap text-xs ${mutedClass}`}>
                      last active {fmtDate(company.lastSeenAtIso)}
                    </span>
                  </div>
                  <Counts open={company.openCount} closed={company.closedCount} />
                  <LoopList loops={company.openLoops} />
                  {company.people.length > 0 ? (
                    <div className="mt-4 border-t border-[#DEDED8] pt-3">
                      <div className="keeps-mono text-[11px] uppercase text-[#6F6F66]">
                        People at {company.displayName}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {company.people.map((person) => (
                          <PersonChip key={person.id} person={person} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {people.length > 0 ? (
            <section className="space-y-3">
              <div className="keeps-mono px-1 pt-1 text-[11px] uppercase text-[#6F6F66]">
                Other people
              </div>
              {people.map((person) => (
                <div key={person.id} className={cardClass}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[16px] font-bold text-[#14140F]">{person.displayName}</span>
                      <KindBadge kind={person.kind} />
                    </div>
                    <span className={`flex-none whitespace-nowrap text-xs ${mutedClass}`}>
                      last active {fmtDate(person.lastSeenAtIso)}
                    </span>
                  </div>
                  {person.canonicalEmail ? (
                    <div className={`mt-0.5 text-xs ${mutedClass}`}>{person.canonicalEmail}</div>
                  ) : null}
                  <Counts open={person.openCount} closed={person.closedCount} />
                  <LoopList loops={person.openLoops} />
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
