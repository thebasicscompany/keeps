"use client";

/**
 * app/settings/billing/billing-client.tsx
 *
 * Client island for the Billing settings page. Renders Clerk's prebuilt
 * Organization controls:
 *   - <OrganizationSwitcher> — create/select the org that owns the
 *     subscription, and "Manage organization" (invite members, assign
 *     admin/member roles, remove members).
 *   - <PricingTable for="organization"> — subscribe / change the per-seat plan.
 *
 * Plans + per-seat pricing live in the Clerk dashboard, not here.
 */

import { OrganizationSwitcher, PricingTable } from "@clerk/nextjs";

export function BillingClient() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-[#14140F]">Your organization</h3>
        <p className="text-sm text-[#6F6F66]">
          Create or select the organization that owns the subscription. Open
          &ldquo;Manage organization&rdquo; to invite teammates and assign roles —
          seats bill per member.
        </p>
        <OrganizationSwitcher
          hidePersonal
          afterCreateOrganizationUrl="/settings/billing"
          afterSelectOrganizationUrl="/settings/billing"
        />
      </div>

      <div className="border-t border-[#DEDED8] pt-6">
        <PricingTable for="organization" />
      </div>
    </div>
  );
}
