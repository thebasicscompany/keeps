/**
 * app/settings/page.tsx
 *
 * Clerk-protected settings page.
 * Renders digest preferences and persists them via a server action.
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
import { validateDigestPrefs, formatSendHour } from "@/settings/digest";
import { TimezoneInput } from "./timezone-input";
import { Toggle } from "./components/toggle";
import { StyledSelect } from "./components/styled-select";
import { cardClass, primaryButtonClass, mutedClass } from "./_ui";

// ---------------------------------------------------------------------------
// Server action — update digest preferences
// ---------------------------------------------------------------------------

async function updateDigestPrefs(formData: FormData): Promise<void> {
  "use server";

  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    redirect("/sign-in" as Route);
  }

  // Resolve Clerk user id → users row.
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
    // Should not happen for a verified Clerk user; bail out gracefully.
    redirect("/sign-in" as Route);
  }

  const raw = {
    digestEnabled: formData.get("digest_enabled"),
    digestSendHour: formData.get("digest_send_hour"),
    timezone: formData.get("timezone"),
  };

  const validation = validateDigestPrefs(raw);

  if (!validation.valid) {
    // In a production app we'd return validation errors to the UI.
    // For Phase 3 the form validates client-side (select range + IANA list);
    // we throw here to surface server-side failures clearly.
    throw new Error(
      `Invalid settings: ${validation.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const { digestEnabled, digestSendHour, timezone } = validation.value;

  await db
    .update(users)
    .set({
      digestEnabled,
      digestSendHour,
      timezone,
      updatedAt: new Date(),
    })
    .where(eq(users.id, identity.userId));

  // Revalidate so the page re-renders with the persisted values.
  revalidatePath("/settings");
}

// ---------------------------------------------------------------------------
// Resolve current user's digest prefs
// ---------------------------------------------------------------------------

async function resolveUserPrefs(clerkUserId: string) {
  const db = getDb();

  const [row] = await db
    .select({
      timezone: users.timezone,
      digestEnabled: users.digestEnabled,
      digestSendHour: users.digestSendHour,
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

  return row ?? { timezone: "UTC", digestEnabled: true, digestSendHour: 8 };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function SettingsPage() {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings" as Route);
  }

  const prefs = await resolveUserPrefs(clerkUserId);

  // Build send hour options.
  const hourOptions = Array.from({ length: 24 }, (_, i) => ({
    value: i,
    label: formatSendHour(i),
  }));

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
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
            />
          </svg>
        </div>
        <h2 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
          Digest preferences
        </h2>
        <p className={`mt-1 text-[17px] leading-tight font-medium ${mutedClass}`}>
          Digest and notification preferences.
        </p>
      </div>

      {/* Settings form */}
      <form action={updateDigestPrefs} className="space-y-6">
        {/* Digest enabled toggle */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <label
              htmlFor="digest_enabled"
              className="text-base font-semibold text-[#14140F]"
            >
              Daily digest
            </label>
            <p className={`mt-0.5 text-sm ${mutedClass}`}>
              Receive a daily summary of your loops.
            </p>
          </div>
          <Toggle
            id="digest_enabled"
            name="digest_enabled"
            defaultChecked={prefs.digestEnabled}
          />
        </div>

        {/* Send hour */}
        <div className="space-y-2">
          <label
            htmlFor="digest_send_hour"
            className="block text-base font-semibold text-[#14140F]"
          >
            Send time
          </label>
          <p className={`text-sm ${mutedClass}`}>
            What time of day would you like to receive your digest?
          </p>
          <StyledSelect
            id="digest_send_hour"
            name="digest_send_hour"
            defaultValue={prefs.digestSendHour}
            options={hourOptions.map(({ value, label }) => ({
              value,
              label,
            }))}
          />
        </div>

        {/* Timezone — client component reads browser TZ */}
        <div className="space-y-2">
          <label htmlFor="timezone" className="block text-base font-semibold text-[#14140F]">
            Timezone
          </label>
          <p className={`text-sm ${mutedClass}`}>
            Your local timezone for digest scheduling.
          </p>
          <TimezoneInput defaultTimezone={prefs.timezone} />
        </div>

        {/* Submit */}
        <div className="pt-2">
          <button type="submit" className={`${primaryButtonClass} w-full`}>
            Save settings
          </button>
        </div>
      </form>
    </div>
  );
}
