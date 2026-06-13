/**
 * LIVE Composio e2e — runs against the REAL Composio API and a REAL connected
 * account. SKIPPED unless KEEPS_LIVE_COMPOSIO=1 (never runs in CI). Requires
 * COMPOSIO_API_KEY in the environment.
 *
 * Run:
 *   COMPOSIO_API_KEY=$(doppler secrets get COMPOSIO_API_KEY --project backend --config prd --plain) \
 *   KEEPS_LIVE_COMPOSIO=1 pnpm vitest run src/connectors/live-composio.e2e.test.ts
 *
 * What it proves: the ACTUAL execute path (executeConnectorPayload → buildComposioArguments
 * → executeComposioTool → Composio → Google Calendar) works end to end, and that
 * the response nesting our code reads (data.response_data.{id, htmlLink}) is correct
 * against the live API. It creates a throwaway event and DELETES it in the same test.
 */

import { describe, expect, it } from "vitest";
import { executeConnectorPayload } from "@/connectors/action-registry";
import { executeComposioTool } from "@/connectors/composio";
import type { CalendarEventPayload } from "@/agent/schemas";

const LIVE = process.env.KEEPS_LIVE_COMPOSIO === "1";

// The ACTIVE Google Calendar connection (verified via the live connected_accounts
// probe). The Composio userId/entity for this connection is the literal email.
const CONNECTED_ACCOUNT_ID = "ca_fsAQmruTO8i3";
const ENTITY_USER_ID = "aravb09@gmail.com";

describe.skipIf(!LIVE)("LIVE Composio — Google Calendar execute path", () => {
  it(
    "creates a real calendar event through executeConnectorPayload, then deletes it",
    async () => {
      const payload: CalendarEventPayload = {
        kind: "calendar_event",
        destination: { kind: "self", nameText: null, emailText: null },
        eventTitle: "[Keeps live e2e] delete me",
        whenAt: "2026-09-01T17:00:00.000Z",
        durationMinutes: 15,
        reminderMinutesBefore: null,
        description: "Automated Keeps live e2e test event — safe to delete.",
        attendees: null,
      };

      const result = await executeConnectorPayload({
        payload,
        keepsUserId: ENTITY_USER_ID,
        connectedAccountId: CONNECTED_ACCOUNT_ID,
        user: { timezone: "America/Los_Angeles" },
      });

      // Proves the response nesting (data.response_data.{id, htmlLink}) is correct.
      expect(result.kind).toBe("calendar_event");
      if (result.kind !== "calendar_event") return;
      expect(result.eventId).toBeTruthy();
      expect(result.htmlLink).toBeTruthy();
      // eslint-disable-next-line no-console
      console.log(`[live-e2e] created event ${result.eventId} → ${result.htmlLink}`);

      // Cleanup — delete the throwaway event so nothing lingers on the calendar.
      const del = await executeComposioTool("GOOGLECALENDAR_DELETE_EVENT", {
        userId: ENTITY_USER_ID,
        connectedAccountId: CONNECTED_ACCOUNT_ID,
        arguments: { calendar_id: "primary", event_id: result.eventId },
      });
      expect(del.successful).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[live-e2e] deleted event ${result.eventId}`);
    },
    30_000,
  );
});
