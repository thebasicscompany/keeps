/**
 * app/settings/data/page.tsx
 *
 * STUB — placeholder for the inbound-email list and data export button.
 * Real handlers land in Wave B.
 *
 * Auth pattern: identical to app/settings/page.tsx.
 * Outer shell is provided by layout.tsx.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import {
  cardClass,
  secondaryButtonClass,
  mutedClass,
  sectionDividerClass,
} from "../_ui";

export default async function DataPage() {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/data" as Route);
  }

  return (
    <div className={cardClass}>
      {/* Card header */}
      <div className="mb-8">
        <div
          className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]"
          aria-hidden="true"
        >
          {/* Database / storage icon */}
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
          View and export your inbound emails and extracted loops.
        </p>
      </div>

      {/* Inbound email list — stub */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-[#14140F]">Inbound emails</h3>
        <p className={`text-sm ${mutedClass}`}>
          A paginated list of raw emails Keeps has received on your behalf will
          appear here. You will be able to view metadata and delete individual
          messages.
        </p>
        <div className="flex h-24 items-center justify-center rounded-none border border-dashed border-[#E2E2DD] text-sm text-[#6F6F66]">
          Inbound email list — coming in a future release
        </div>
      </div>

      <div className={`my-8 ${sectionDividerClass}`} />

      {/* Export — stub */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-[#14140F]">Export your data</h3>
          <p className={`mt-1 text-sm ${mutedClass}`}>
            Download a full archive of your loops, extracted quotes, and email
            metadata as a JSON file. Raw email bodies are included only if
            retention has not expired.
          </p>
        </div>
        <button
          type="button"
          disabled
          className={`${secondaryButtonClass} w-full opacity-40 cursor-not-allowed`}
          aria-disabled="true"
        >
          Export data — available in a future release
        </button>
      </div>
    </div>
  );
}
