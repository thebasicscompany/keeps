/**
 * src/settings/digest.ts
 *
 * Pure validation logic for digest preference updates.
 * Extracted into this module so it can be unit-tested without touching
 * the server action infrastructure (React Server Components, revalidatePath).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DigestPrefsInput = {
  digestEnabled: boolean;
  digestSendHour: number;
  timezone: string;
};

export type DigestPrefsValidation =
  | { valid: true; value: DigestPrefsInput }
  | { valid: false; errors: DigestPrefsError[] };

export type DigestPrefsError =
  | { field: "digestSendHour"; message: string }
  | { field: "timezone"; message: string };

// ---------------------------------------------------------------------------
// validateDigestPrefs
//
// Pure function — no side effects, fully unit-testable.
// ---------------------------------------------------------------------------

function buildValidTimezones(): Set<string> {
  const tzs: string[] =
    typeof Intl !== "undefined" && "supportedValuesOf" in Intl
      ? (Intl as { supportedValuesOf(type: string): string[] }).supportedValuesOf("timeZone")
      : [];

  const set = new Set(tzs);

  // "UTC" is not in the IANA database returned by Intl.supportedValuesOf on most
  // runtimes (the canonical form is "Etc/UTC"), but it is universally understood
  // and is the database default value for users.timezone. Accept it explicitly.
  set.add("UTC");
  set.add("Etc/UTC");
  set.add("Etc/GMT");

  return set;
}

const VALID_TIMEZONES: ReadonlySet<string> = buildValidTimezones();

export function validateDigestPrefs(raw: {
  digestEnabled: unknown;
  digestSendHour: unknown;
  timezone: unknown;
}): DigestPrefsValidation {
  const errors: DigestPrefsError[] = [];

  // digestSendHour must be an integer in [0, 23].
  const hourRaw = Number(raw.digestSendHour);
  if (!Number.isInteger(hourRaw) || hourRaw < 0 || hourRaw > 23) {
    errors.push({
      field: "digestSendHour",
      message: "Send hour must be an integer between 0 and 23.",
    });
  }

  // timezone must be a valid IANA timezone string.
  const tz = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
  if (!tz || !VALID_TIMEZONES.has(tz)) {
    errors.push({
      field: "timezone",
      message: `"${tz}" is not a recognized IANA timezone.`,
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      digestEnabled: raw.digestEnabled === true || raw.digestEnabled === "on",
      digestSendHour: hourRaw,
      timezone: tz,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatted send hour labels (used by the settings form)
// ---------------------------------------------------------------------------

export function formatSendHour(hour: number): string {
  const date = new Date(2000, 0, 1, hour, 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
