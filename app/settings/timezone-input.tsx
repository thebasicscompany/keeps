"use client";

/**
 * app/settings/timezone-input.tsx
 *
 * Tiny client component: reads Intl.DateTimeFormat().resolvedOptions().timeZone
 * from the browser and pre-fills a hidden input on the form.
 *
 * The server-rendered default is "UTC" (from the users row); on mount the
 * browser replaces it with the detected timezone. The user can also choose
 * from the full IANA list via the <select>.
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  /** Server-side default (from users.timezone). */
  defaultTimezone: string;
};

export function TimezoneInput({ defaultTimezone }: Props) {
  const [timezone, setTimezone] = useState(defaultTimezone);
  const detected = useRef(false);

  // Detect timezone from the browser on first mount.
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;

    try {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTz) {
        setTimezone(browserTz);
      }
    } catch {
      // Fall back to the server-side default silently.
    }
  }, []);

  // Build the IANA timezone list — use supportedValuesOf if available.
  const timezones: string[] =
    typeof Intl !== "undefined" && "supportedValuesOf" in Intl
      ? (Intl as { supportedValuesOf(type: string): string[] }).supportedValuesOf("timeZone")
      : ["UTC"];

  return (
    <select
      id="timezone"
      name="timezone"
      value={timezone}
      onChange={(e) => setTimezone(e.target.value)}
      className="h-12 w-full rounded-none border border-[#E2E2DD] bg-white px-4 text-[15px] font-medium text-[#14140F] outline-none transition-shadow placeholder:text-[#6F6F66] focus:border-[#14140F] focus:shadow-[0_0_0_1px_#14140F]"
    >
      {timezones.map((tz) => (
        <option key={tz} value={tz}>
          {tz}
        </option>
      ))}
    </select>
  );
}
