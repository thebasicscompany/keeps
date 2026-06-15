/**
 * app/settings/data/page.tsx
 *
 * Auth-gated server component. Lists the user's inbound emails (newest first,
 * paginated 20 per page) with a per-email irreversible delete action and an
 * "Export my data" button that POSTs to /api/data/export.
 *
 * Auth pattern: identical to app/settings/page.tsx.
 * Design tokens: app/settings/_ui.ts + design system (square seafoam #C1F5DF,
 * ink #14140F, Bricolage Grotesque, mobile-first).
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userIdentities, inboundEmails } from "@/db/schema";
import {
  cardClass,
  mutedClass,
  sectionDividerClass,
  secondaryButtonClass,
} from "../_ui";
import { DeleteEmailButton } from "./delete-email-button";
import { ExportDataButton } from "./export-data-button";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Resolve current user's inbound emails
// ---------------------------------------------------------------------------

async function resolveUserEmails(
  clerkUserId: string,
  page: number,
): Promise<{
  userId: string;
  emails: {
    id: string;
    subject: string;
    senderEmail: string;
    senderName: string | null;
    providerReceivedAt: Date | null;
    createdAt: Date;
  }[];
  total: number;
}> {
  const db = getDb();

  const [row] = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(
      userIdentities,
      and(
        eq(userIdentities.userId, users.id),
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  if (!row) {
    return { userId: "", emails: [], total: 0 };
  }

  const offset = (page - 1) * PAGE_SIZE;

  const emailRows = await db
    .select({
      id: inboundEmails.id,
      subject: inboundEmails.subject,
      senderEmail: inboundEmails.senderEmail,
      senderName: inboundEmails.senderName,
      providerReceivedAt: inboundEmails.providerReceivedAt,
      createdAt: inboundEmails.createdAt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.userId, row.userId))
    .orderBy(desc(inboundEmails.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  // Count total for pagination info.
  const countRows = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(eq(inboundEmails.userId, row.userId));

  return { userId: row.userId, emails: emailRows, total: countRows.length };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date | null): string {
  if (!d) return "Unknown date";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DataPage({ searchParams }: PageProps) {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/data" as Route);
  }

  const params = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const rawPage = params.page;
  const pageStr = Array.isArray(rawPage) ? rawPage[0] : (rawPage ?? "1");
  const page = Math.max(1, Number.parseInt(pageStr, 10) || 1);

  const { userId, emails, total } = await resolveUserEmails(clerkUserId, page);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (!userId) {
    redirect("/sign-in?redirect_url=/settings/data" as Route);
  }

  return (
    <div className={cardClass}>
      {/* ------------------------------------------------------------------ */}
      {/* Card header                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-8">
        <div
          className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]"
          aria-hidden="true"
        >
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
              d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
            />
          </svg>
        </div>
        <h2 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
          Your data
        </h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          View, manage, and export your inbound emails and extracted loops.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Inbound email list                                                   */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-[#14140F]">
            Inbound emails
          </h3>
          {total > 0 && (
            <span className={`text-sm ${mutedClass}`}>
              {total} email{total !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <p className={`text-sm ${mutedClass}`}>
          Each email below was received by Keeps on your behalf. Deleting an
          email permanently removes its raw content, all extracted loops, loop
          events, and related nudges.{" "}
          <strong className="text-[#14140F]">This action is irreversible.</strong>
        </p>

        {emails.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-none border border-dashed border-[#DEDED8] text-sm text-[#6F6F66]">
            No emails received yet
          </div>
        ) : (
          <ul className="divide-y divide-[#DEDED8]" aria-label="Inbound emails">
            {emails.map((email) => (
              <li
                key={email.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-sm font-semibold text-[#14140F]">
                    {truncate(email.subject || "(no subject)", 80)}
                  </p>
                  <p className={`text-xs ${mutedClass}`}>
                    From:{" "}
                    {email.senderName
                      ? `${email.senderName} <${email.senderEmail}>`
                      : email.senderEmail}
                  </p>
                  <p className={`text-xs ${mutedClass}`}>
                    Received:{" "}
                    {formatDate(email.providerReceivedAt ?? email.createdAt)}
                  </p>
                </div>

                <div className="flex-shrink-0">
                  <DeleteEmailButton
                    inboundEmailId={email.id}
                    subject={truncate(email.subject || "(no subject)", 60)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <nav
            className="flex items-center justify-between pt-2"
            aria-label="Email list pagination"
          >
            <a
              href={`/settings/data?page=${Math.max(1, page - 1)}`}
              aria-disabled={page <= 1}
              className={`${secondaryButtonClass} px-4 py-2 text-sm ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
            >
              Previous
            </a>
            <span className={`text-sm ${mutedClass}`}>
              Page {page} of {totalPages}
            </span>
            <a
              href={`/settings/data?page=${Math.min(totalPages, page + 1)}`}
              aria-disabled={page >= totalPages}
              className={`${secondaryButtonClass} px-4 py-2 text-sm ${page >= totalPages ? "pointer-events-none opacity-40" : ""}`}
            >
              Next
            </a>
          </nav>
        )}
      </div>

      <div className={`my-8 ${sectionDividerClass}`} />

      {/* ------------------------------------------------------------------ */}
      {/* Export                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-[#14140F]">
            Export your data
          </h3>
          <p className={`mt-1 text-sm ${mutedClass}`}>
            Download a full archive of your loops, extracted quotes, and email
            metadata as a JSON file. Raw email bodies are included only if
            retention has not expired.
          </p>
        </div>
        <ExportDataButton />
      </div>
    </div>
  );
}
