/**
 * app/settings/audit/page.tsx
 *
 * Audit log view — replaces the Wave A stub.
 * Server component. Auth-gated via Clerk → user_identities → users.id.
 * Outer shell (background, container, header) is provided by layout.tsx.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import type { Route } from "next";
import { getDb } from "@/db/client";
import { users, userIdentities } from "@/db/schema";
import { listAuditForUser } from "@/audit/list-for-user";
import { labelForAction, summarizeMetadata } from "@/audit/summarize-row";
import type { AuditLogEntry } from "@/db/schema";
import { cardClass, mutedClass } from "../_ui";

// ---------------------------------------------------------------------------
// Presentational component — factored for testability with renderToStaticMarkup
// ---------------------------------------------------------------------------

export interface AuditTableProps {
  rows: AuditLogEntry[];
}

export function AuditTable({ rows }: AuditTableProps) {
  if (rows.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-none border border-dashed border-[#DEDED8] text-sm text-[#6F6F66]">
        No audit events yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[#DEDED8]">
            <th
              scope="col"
              className="keeps-mono py-2 pr-4 text-left text-[11px] uppercase text-[#6F6F66]"
              style={{ minWidth: "9rem" }}
            >
              When
            </th>
            <th
              scope="col"
              className="keeps-mono py-2 pr-4 text-left text-[11px] uppercase text-[#6F6F66]"
              style={{ minWidth: "12rem" }}
            >
              Event
            </th>
            <th
              scope="col"
              className="keeps-mono py-2 text-left text-[11px] uppercase text-[#6F6F66]"
            >
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const summary = summarizeMetadata(row);
            return (
              <tr
                key={row.id}
                className="border-b border-[#DEDED8] last:border-0 hover:bg-[#FAFAF8]"
              >
                {/* Timestamp */}
                <td className="py-2.5 pr-4 align-top font-mono text-xs text-[#6F6F66] whitespace-nowrap">
                  <time dateTime={row.createdAt.toISOString()}>
                    {formatTimestamp(row.createdAt)}
                  </time>
                </td>

                {/* Action label */}
                <td className="py-2.5 pr-4 align-top font-medium text-[#14140F]">
                  {labelForAction(row.action)}
                </td>

                {/* Human summary of metadata (body-safe) */}
                <td className="py-2.5 align-top text-[#6F6F66]">
                  {summary || <span className="italic text-[#A8A89E]">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  // ISO-like: 2026-06-13 14:32 UTC — compact and unambiguous.
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/:\d{2}\.\d{3}Z$/, " UTC");
}

// ---------------------------------------------------------------------------
// Resolve Clerk user id → internal users.id
// ---------------------------------------------------------------------------

async function resolveUserId(clerkUserId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function AuditPage() {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/audit" as Route);
  }

  const userId = await resolveUserId(clerkUserId);

  if (!userId) {
    // Clerk user exists but no local identity row yet (race during first sign-in).
    redirect("/sign-in?redirect_url=/settings/audit" as Route);
  }

  const rows = await listAuditForUser({ userId, limit: 200 });

  return (
    <div className={cardClass}>
      {/* Card header */}
      <div className="mb-8">
        <div
          className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]"
          aria-hidden="true"
        >
          {/* Clipboard / list icon */}
          <svg
            className="size-7"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
            />
          </svg>
        </div>
        <h2 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
          Audit log
        </h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          A chronological record of actions taken in your Keeps account.
        </p>
      </div>

      {/* Download link — wired to /api/data/export (built by B3 agent; 404 until merged) */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <p className={`text-sm ${mutedClass}`}>
          Showing up to 200 most recent events.
        </p>
        <a
          href="/api/data/export"
          className="keeps-mono inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-[#DEDED8] bg-[#FAFAF8] px-4 text-[12px] uppercase text-[#6F6F66] transition-colors hover:border-[#14140F] hover:text-[#14140F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14140F]/20"
          aria-label="Download all data as JSON"
        >
          {/* Download icon */}
          <svg
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
            />
          </svg>
          Download all
        </a>
      </div>

      {/* Audit table */}
      <AuditTable rows={rows} />
    </div>
  );
}
