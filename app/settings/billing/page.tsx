/**
 * app/settings/billing/page.tsx
 *
 * Clerk-protected billing page. Lets a signed-in user create/select their
 * organization and subscribe it to the per-seat plan via Clerk Billing.
 *
 * Outer shell (background, container, "Home" header + nav) is provided by
 * the settings layout.tsx. Subscription state is read live from Clerk —
 * there is no local subscriptions table.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { cardClass, mutedClass, statusBadgeVariants } from "../_ui";
import { BillingClient } from "./billing-client";

export default async function BillingPage() {
  const { userId: clerkUserId, has } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/billing" as Route);
  }

  // `has({ plan })` checks the ACTIVE organization's Clerk Billing plan.
  // The slug must match the plan created in the Clerk dashboard
  // (Subscription plans -> Plans for Organizations). Update if you rename it.
  const hasTeamPlan = has({ plan: "team" });

  return (
    <div className={cardClass}>
      {/* Card header */}
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
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3M3.75 19.5h16.5A2.25 2.25 0 0 0 22.5 17.25V6.75A2.25 2.25 0 0 0 20.25 4.5H3.75A2.25 2.25 0 0 0 1.5 6.75v10.5A2.25 2.25 0 0 0 3.75 19.5Z"
            />
          </svg>
        </div>
        <h2 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
          Billing
        </h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          Subscribe your team per seat and manage your plan.
        </p>
      </div>

      {/* Current plan status */}
      <div className="mb-6">
        <span
          className={`keeps-mono inline-flex h-7 items-center rounded-[4px] px-2.5 text-[11px] uppercase ${
            hasTeamPlan ? statusBadgeVariants.active : statusBadgeVariants.none
          }`}
        >
          {hasTeamPlan ? "Team plan active" : "No active plan"}
        </span>
      </div>

      <BillingClient />
    </div>
  );
}
