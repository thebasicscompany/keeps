/**
 * app/settings/_ui.ts
 *
 * Shared design tokens and class strings for the settings section.
 * Import from here in page.tsx, connectors/page.tsx, connect-button.tsx,
 * and any settings components.  All values match the design system spec.
 */

// ---------------------------------------------------------------------------
// Layout / background
// ---------------------------------------------------------------------------

export const paperBg = "bg-[#FAFAF8]";

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export const cardClass =
  "rounded-none border border-[#E2E2DD] bg-white p-5 shadow-[0_24px_70px_rgba(20,20,15,0.07)] sm:p-6";

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------

export const labelClass = "text-[15px] font-semibold text-[#14140F]";
export const mutedClass = "text-[#6F6F66]";

// ---------------------------------------------------------------------------
// Form elements
// ---------------------------------------------------------------------------

export const inputClass =
  "h-12 w-full rounded-none border border-[#E2E2DD] bg-white px-4 text-[15px] font-medium text-[#14140F] outline-none transition-shadow placeholder:text-[#6F6F66] focus:border-[#14140F] focus:shadow-[0_0_0_1px_#14140F]";

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * Full-width primary button used for the digest "Save settings" action.
 * h-14 matches the settings page scale (slightly smaller than the h-16
 * get-started stepper, bigger than the h-11 connector card buttons).
 */
export const primaryButtonClass =
  "h-14 rounded-none border border-[rgba(30,107,79,0.32)] bg-[#C1F5DF] px-6 text-base font-semibold text-[#14140F] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-2px_0_rgba(30,107,79,0.28),0_12px_24px_rgba(30,107,79,0.16)] transition-colors hover:bg-[#AFF0D3] focus-visible:ring-2 focus-visible:ring-[rgba(30,107,79,0.32)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Compact primary button (h-11) used inside connector card rows.
 */
export const compactPrimaryButtonClass =
  "h-11 rounded-none border border-[rgba(30,107,79,0.32)] bg-[#C1F5DF] px-5 text-sm font-semibold text-[#14140F] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-2px_0_rgba(30,107,79,0.28),0_12px_24px_rgba(30,107,79,0.16)] transition-colors hover:bg-[#AFF0D3] focus-visible:ring-2 focus-visible:ring-[rgba(30,107,79,0.32)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Compact secondary button (h-11) used for "Disconnect" connector actions.
 */
export const secondaryButtonClass =
  "h-11 rounded-none border border-[#E2E2DD] bg-white px-5 text-sm font-semibold text-[#6F6F66] transition-colors hover:border-[#14140F] hover:text-[#14140F] focus-visible:ring-2 focus-visible:ring-[#14140F]/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

// ---------------------------------------------------------------------------
// StatusBadge color variants (used in connectors/page.tsx)
// ---------------------------------------------------------------------------

export const statusBadgeVariants: Record<"none" | "active" | "error", string> =
  {
    none: "bg-[#F4F4F0] text-[#6F6F66]",
    active: "bg-[#E9FBF4] text-[#1E6B4F]",
    error: "bg-[#FEF3F2] text-[#B42318]",
  };

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export const sectionDividerClass = "border-t border-[#E2E2DD]";
