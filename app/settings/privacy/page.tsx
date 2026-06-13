/**
 * app/settings/privacy/page.tsx
 *
 * Clerk-protected server component for the Privacy settings page.
 *
 * Renders:
 *   1. Raw email retention select (30 / 90 / 365 days / until I delete).
 *      Persists via updateRetentionPrefs server action → users.rawEmailRetentionDays.
 *   2. Stubbed "Delete all data" section — visible but disabled; real handler
 *      lands in Wave B.
 *
 * Auth pattern: identical to app/settings/page.tsx — auth() from
 * @clerk/nextjs/server → user_identities(provider='clerk') → users.id.
 *
 * Outer shell (background, container, header) is provided by layout.tsx.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Route } from "next";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userIdentities } from "@/db/schema";
import {
  cardClass,
  primaryButtonClass,
  mutedClass,
  sectionDividerClass,
  inputClass,
} from "../_ui";
import {
  RETENTION_OPTIONS,
  selectValueToDays,
  daysToSelectValue,
} from "./retention";
import { DeleteDataForm } from "./delete-data-form";

// ---------------------------------------------------------------------------
// Server action — update raw email retention preference
// ---------------------------------------------------------------------------

async function updateRetentionPrefs(formData: FormData): Promise<void> {
  "use server";

  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    redirect("/sign-in" as Route);
  }

  const db = getDb();
  const [identity] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  if (!identity) {
    redirect("/sign-in" as Route);
  }

  const raw = formData.get("raw_email_retention") as string | null;
  const days = selectValueToDays(raw ?? "30");

  await db
    .update(users)
    .set({
      rawEmailRetentionDays: days,
      updatedAt: new Date(),
    })
    .where(eq(users.id, identity.userId));

  revalidatePath("/settings/privacy");
}

// ---------------------------------------------------------------------------
// Resolve current retention preference
// ---------------------------------------------------------------------------

async function resolvePrivacyContext(
  clerkUserId: string,
): Promise<{ retentionDays: number | null; email: string | null }> {
  const db = getDb();

  const [row] = await db
    .select({
      rawEmailRetentionDays: users.rawEmailRetentionDays,
      email: users.email,
    })
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

  // Column default is 30; null means "until I delete".
  return {
    retentionDays: row?.rawEmailRetentionDays ?? 30,
    email: row?.email ?? null,
  };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function PrivacyPage() {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/privacy" as Route);
  }

  const { retentionDays, email: accountEmail } =
    await resolvePrivacyContext(clerkUserId);
  const currentSelectValue = daysToSelectValue(retentionDays);

  return (
    <div className={cardClass}>
      {/* Card header */}
      <div className="mb-8">
        <div
          className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]"
          aria-hidden="true"
        >
          {/* Shield icon */}
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
              d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
            />
          </svg>
        </div>
        <h2 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
          Privacy
        </h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          Control how long Keeps retains your raw emails.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Raw email retention                                      */}
      {/* ------------------------------------------------------------------ */}
      <form action={updateRetentionPrefs} className="space-y-6">
        <div className="space-y-2">
          <label
            htmlFor="raw_email_retention"
            className="block text-base font-semibold text-[#14140F]"
          >
            Raw email retention
          </label>
          <p className={`text-sm ${mutedClass}`}>
            Raw emails are removed after N days. The loops we extracted, and
            the short quotes they cite, remain until you delete them.
          </p>

          {/* Native select styled to match the design system */}
          <div className="relative w-full">
            <select
              id="raw_email_retention"
              name="raw_email_retention"
              defaultValue={currentSelectValue}
              className={[inputClass, "appearance-none pr-10"].join(" ")}
            >
              {RETENTION_OPTIONS.map(({ selectValue, label }) => (
                <option key={selectValue} value={selectValue}>
                  {label}
                </option>
              ))}
            </select>
            {/* Custom chevron */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[#6F6F66]"
            >
              <svg
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </div>
        </div>

        <div className="pt-2">
          <button type="submit" className={`${primaryButtonClass} w-full`}>
            Save privacy settings
          </button>
        </div>
      </form>

      {/* ------------------------------------------------------------------ */}
      {/* Divider                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className={`my-8 ${sectionDividerClass}`} />

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Delete all data (live — deliverable 7)                  */}
      {/* ------------------------------------------------------------------ */}
      {accountEmail ? (
        <DeleteDataForm accountEmail={accountEmail} />
      ) : (
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-[#14140F]">
            Delete all data
          </h3>
          <p className={`text-sm ${mutedClass}`}>
            We could not resolve your account email. Please refresh and try
            again.
          </p>
        </div>
      )}
    </div>
  );
}
