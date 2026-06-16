/**
 * app/settings/team/page.tsx
 *
 * Team / members view (Wave 6 — multi-member orgs). Shows the user's SHARED organization (mirrored
 * from Clerk) and everyone in it, so a team can see who shares the graph. A user in only their
 * personal org sees the "not in a team yet" state (invites are managed in Clerk / Billing).
 * Read-only; membership is driven by Clerk org-sync, not edited here.
 */
import { auth } from "@clerk/nextjs/server";
import { and, asc, eq } from "drizzle-orm";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { orgMemberships, organizations, userIdentities, users } from "@/db/schema";
import { cardClass, labelClass, mutedClass, statusBadgeVariants } from "../_ui";

export const dynamic = "force-dynamic";

async function resolveInternalUserId(): Promise<string | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const [identity] = await getDb()
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, "clerk"), eq(userIdentities.providerAccountId, clerkUserId)))
    .limit(1);
  return identity?.userId ?? null;
}

export default async function TeamPage() {
  const userId = await resolveInternalUserId();
  if (!userId) redirect("/sign-in?redirect_url=/settings/team" as Route);

  const db = getDb();
  // The user's SHARED (non-personal) org, if any.
  const [shared] = await db
    .select({ orgId: organizations.id, name: organizations.name, role: orgMemberships.role })
    .from(orgMemberships)
    .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
    .where(and(eq(orgMemberships.userId, userId), eq(organizations.isPersonal, false)))
    .limit(1);

  if (!shared) {
    return (
      <div className={cardClass}>
        <div className="mb-6">
          <h2 className="text-[28px] leading-tight font-bold text-[#14140F]">Team</h2>
          <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
            You’re not part of a shared workspace yet.
          </p>
        </div>
        <p className={`text-[15px] ${mutedClass}`}>
          When you create or join an organization (from{" "}
          <Link href={"/settings/billing" as Route} className="underline">
            Billing → Manage organization
          </Link>
          ), your team shares one graph: everyone sees each other’s loops and contacts, and nothing
          ever crosses to another organization.
        </p>
      </div>
    );
  }

  const members = await db
    .select({ userId: orgMemberships.userId, role: orgMemberships.role, email: users.email, displayName: users.displayName })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, shared.orgId))
    .orderBy(asc(users.email));

  return (
    <div className={cardClass}>
      <div className="mb-8">
        <h2 className="text-[28px] leading-tight font-bold text-[#14140F]">{shared.name || "Your team"}</h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          {members.length} member{members.length === 1 ? "" : "s"} share this workspace’s graph — everyone
          sees the team’s loops and contacts. Nothing is visible across organizations.
        </p>
      </div>

      <section>
        <h3 className={`mb-3 ${labelClass}`}>Members</h3>
        <ul className="space-y-2">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between rounded-[4px] border border-[#DEDED8] px-4 py-3"
            >
              <div className="min-w-0">
                <span className="text-[15px] font-semibold text-[#14140F]">{m.displayName || m.email}</span>
                {m.displayName ? <p className={`truncate text-[13px] ${mutedClass}`}>{m.email}</p> : null}
              </div>
              <span
                className={`keeps-mono inline-flex h-7 shrink-0 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${
                  m.role === "owner" || m.role === "admin" ? statusBadgeVariants.active : statusBadgeVariants.none
                }`}
              >
                {m.role}
              </span>
            </li>
          ))}
        </ul>
        <p className={`mt-4 text-[12px] ${mutedClass}`}>
          Members are managed in Clerk (Billing → Manage organization). Changes sync here automatically.
        </p>
      </section>
    </div>
  );
}
