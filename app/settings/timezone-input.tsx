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
 *
 * Uses StyledSelect for a consistent appearance with the send-hour select.
 */

import { useEffect, useRef, useState } from "react";
import { StyledSelect } from "./components/styled-select";

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
    <StyledSelect
      id="timezone"
      name="timezone"
      value={timezone}
      onChange={(e) => setTimezone(e.target.value)}
      options={timezones.map((tz) => ({ value: tz, label: tz }))}
    />
  );
}
