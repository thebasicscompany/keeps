/**
 * app/settings/audit/page.tsx
 *
 * STUB — placeholder for the audit log list.
 * Real data layer and pagination land in Wave B.
 *
 * Auth pattern: identical to app/settings/page.tsx.
 * Outer shell is provided by layout.tsx.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { cardClass, mutedClass } from "../_ui";

export default async function AuditPage() {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/audit" as Route);
  }

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

      {/* Audit list — stub */}
      <div className="space-y-3">
        <p className={`text-sm ${mutedClass}`}>
          The audit log will list account events such as connector connections
          and disconnections, digest preference changes, data export requests,
          and retention policy updates — including timestamps and acting user.
        </p>
        <div className="flex h-32 items-center justify-center rounded-none border border-dashed border-[#E2E2DD] text-sm text-[#6F6F66]">
          Audit log — coming in a future release
        </div>
      </div>
    </div>
  );
}
