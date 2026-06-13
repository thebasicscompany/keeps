/**
 * E5 — Calendar confirmation window (DB-gated; reversible self-event auto-confirms).
 *
 * "@Calendar remind me before the renewal call" with a RESOLVED whenAt, self-only (no
 * attendees → reversible). The flow must:
 *   - send ONE confirmation-window email ("I'll add this in 15 minutes unless you cancel"),
 *     NOT a hard-approval email — proven via reversibility === 'reversible' and the body.
 *   - on the 15m timeout firing, auto-confirm (decideApproval approved, channel 'cron')
 *     and execute the calendar action EXACTLY ONCE (GOOGLECALENDAR_CREATE_EVENT).
 *
 * Plus the guard: a calendar_event with whenAt === null does NOT reach approval — it
 * sends a "when?" clarification and the executor is called ZERO times.
 *
 * The offline regex parser never resolves an absolute whenAt, so the confirmation case
 * injects a command with whenAt set (the model path would do this in prod). The needs-when
 * case uses the REAL parser, which leaves whenAt null.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * BUG FOUND (do NOT fix in source per task rules — flagged for the orchestrator):
 *
 *   The reversible confirmation-window TTL and the waitForEvent timeout are BOTH 15m
 *   (FIFTEEN_MIN_MS / CONFIRM_WINDOW_TIMEOUT in handle-connector-command.ts). So when
 *   the timeout fires, the approval row is ALREADY clock-expired (expiresAt == the
 *   timeout instant, and decideApproval guards with `expiresAt <= now`). The wrapper's
 *   `confirm-on-timeout` step calls decideApproval(decision:'approved', channel:'cron')
 *   with `now` at the timeout — which returns { status:'expired' } and DOES NOT approve
 *   the row. The wrapper then ignores that return, sets `decision = "approved"`, and
 *   calls executeConnectorAction anyway; the AR-7 gate loads the still-'pending' (now
 *   past-expiry) approval and DENIES it. Net effect: a reversible self-calendar event
 *   the user simply ignored is NEVER created — contradicting the "I'll add it in 15
 *   minutes unless you cancel" promise.
 *
 *   Suggested fix (source): give the confirmation-window approval a TTL strictly LONGER
 *   than the waitForEvent timeout (e.g. expiresAt = now + 15m + slack, or mint the
 *   approval with a far-future TTL and rely on the timeout alone to gate it), OR have
 *   confirm-on-timeout decide 'approved' on a clock strictly before expiresAt. The
 *   happy-path test below confirms a hair before expiry to prove the auto-confirm path
 *   works when the grant is valid; the "BUG WITNESS" test pins the current broken
 *   boundary so the fix is observable.
 * ───────────────────────────────────────────────────────────────────────────────
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectorExecutor } from "@/connectors/action-registry";
import type { ConnectorCommandDraft } from "@/agent/schemas";
import {
  runUpToApproval,
  executeAndConfirm,
  autoConfirmOnTimeout,
  type CapturedEmail,
  type RunConnectorCommandDeps,
} from "@/connectors/__tests__/e2e-harness";
import {
  setupE2eDb,
  getConnectorAction,
  TEST_DATABASE_URL,
  type E2eDb,
} from "@/connectors/__tests__/e2e-db";
import { routeConnectorEmail } from "@/connectors/__tests__/e2e-router";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const APP_URL = "https://app.keeps.test";

describe.skipIf(!TEST_DATABASE_URL)("E5 — calendar confirmation window", () => {
  let h: E2eDb;

  beforeAll(async () => {
    h = await setupE2eDb({ provider: "google_calendar", timezone: "America/New_York" });
  });
  afterAll(async () => {
    await h.teardown();
  });

  it("reversible self-event → confirmation window → timeout auto-confirms → executor EXACTLY ONCE", async () => {
    // Inject a command with a RESOLVED whenAt (what the model path produces).
    const resolved: ConnectorCommandDraft = {
      provider: "google_calendar",
      kind: "calendar_event",
      destination: { kind: "self", nameText: null, emailText: null },
      message: null,
      eventTitle: "Renewal call prep",
      whenText: "tomorrow 9am",
      whenAt: "2026-06-14T13:00:00.000Z",
      durationMinutes: 30,
      reminderMinutesBefore: 15,
      linkedLoopId: null,
      ambiguity: [],
    };

    const routed = await routeConnectorEmail({
      body: "@Calendar remind me before the renewal call",
      userId: h.userId,
      inboundEmailId: h.inboundEmailId,
      now: NOW,
      command: resolved,
    });
    expect(routed.kind).toBe("calendar_event");

    const calls: { slug: string; arguments: Record<string, unknown> }[] = [];
    const connectorExecutor: ConnectorExecutor = async (slug, params) => {
      calls.push({ slug, arguments: params.arguments });
      return {
        successful: true,
        data: { response_data: { id: "evt_123", htmlLink: "https://cal/evt_123" } },
        error: null,
      };
    };

    const emails: CapturedEmail[] = [];
    const deps: RunConnectorCommandDeps = {
      command: routed.command,
      userId: h.userId,
      inboundEmailId: routed.inboundEmailId,
      account: h.account,
      ownerEmail: "owner@keeps.test",
      appUrl: APP_URL,
      db: h.db,
      connectorExecutor,
      emails,
      now: NOW,
    };

    const outcome = await runUpToApproval(deps);
    if (outcome.branch !== "awaiting_decision") throw new Error("expected awaiting_decision");

    // Self-only event → REVERSIBLE → confirmation window, not a hard approval.
    expect(outcome.reversibility).toBe("reversible");

    // ONE confirmation-window email — not a hard-approval email.
    expect(emails).toHaveLength(1);
    expect(emails[0].template).toBe("connector_approval");
    expect(emails[0].subject).toBe("Confirm: calendar event — Renewal call prep");
    expect(emails[0].textBody).toContain("I'll add this to your calendar in 15 minutes unless you cancel");
    // It is a confirmation-window body (cancel/edit reply footer), not the slack approve footer.
    expect(emails[0].textBody).not.toContain("reply  approve");
    // Not executed yet.
    expect(calls).toHaveLength(0);

    // ── The confirmation-window timeout fires → auto-confirm via channel 'cron' → execute once.
    //
    // NOTE ON THE CLOCK (see the BUG note at the bottom of this file): the reversible
    // confirmation window's approval TTL (15m) EQUALS the waitForEvent timeout (15m), so
    // when the timeout fires at expiresAt the approval is ALREADY clock-expired and
    // decideApproval refuses to confirm it. The intended invariant — "letting the window
    // lapse auto-confirms and executes the self-event once" — only holds while the grant
    // is still valid. We confirm a hair BEFORE expiry (the grant valid) to prove the
    // auto-confirm → execute-once path itself works; the boundary defect is asserted
    // separately below.
    const beforeExpiry = new Date(NOW.getTime() + 15 * 60 * 1000 - 1000);
    await autoConfirmOnTimeout(h.db, outcome.approvalId, beforeExpiry);
    const executed = await executeAndConfirm(
      { ...deps, now: beforeExpiry },
      outcome.connectorActionId,
    );

    expect(executed.status).toBe("completed");
    // EXACTLY ONE calendar call.
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe("GOOGLECALENDAR_CREATE_EVENT");
    expect(calls[0].arguments.summary).toBe("Renewal call prep");
    expect(calls[0].arguments.calendar_id).toBe("primary");

    const row = await getConnectorAction(h.db, outcome.connectorActionId);
    expect(row.status).toBe("completed");
  });

  it("BUG WITNESS: auto-confirm AT/AFTER the window's expiry is rejected — the self-event never runs", async () => {
    // This documents a real defect (see the BUG note below). In the live wrapper the
    // reversible approval TTL (15m) == the waitForEvent timeout (15m), so the timeout
    // fires when the approval has ALREADY expired by the clock. decideApproval's expiry
    // guard then refuses to flip it to 'approved' (returns { status: 'expired' }), the row
    // stays 'pending', and executeConnectorAction's AR-7 gate denies it. Net effect: a
    // reversible self-calendar event that the user simply ignored would NEVER be created,
    // even though the product intent is "add it unless you cancel".
    const resolved: ConnectorCommandDraft = {
      provider: "google_calendar",
      kind: "calendar_event",
      destination: { kind: "self", nameText: null, emailText: null },
      message: null,
      eventTitle: "Lapsed window event",
      whenText: "tomorrow 9am",
      whenAt: "2026-06-14T13:00:00.000Z",
      durationMinutes: 30,
      reminderMinutesBefore: 15,
      linkedLoopId: null,
      ambiguity: [],
    };
    const routed = await routeConnectorEmail({
      body: "@Calendar remind me before the renewal call",
      userId: h.userId,
      inboundEmailId: h.inboundEmailId,
      now: NOW,
      command: resolved,
    });

    const calls: { slug: string }[] = [];
    const connectorExecutor: ConnectorExecutor = async (slug) => {
      calls.push({ slug });
      return { successful: true, data: { response_data: { id: "x", htmlLink: "y" } }, error: null };
    };
    const emails: CapturedEmail[] = [];
    const deps: RunConnectorCommandDeps = {
      command: routed.command,
      userId: h.userId,
      inboundEmailId: routed.inboundEmailId,
      account: h.account,
      ownerEmail: "owner@keeps.test",
      appUrl: APP_URL,
      db: h.db,
      connectorExecutor,
      emails,
      now: NOW,
    };
    const outcome = await runUpToApproval(deps);
    if (outcome.branch !== "awaiting_decision") throw new Error("expected awaiting_decision");

    // Timeout fires 1s PAST expiry — exactly what the live wrapper does.
    const afterExpiry = new Date(NOW.getTime() + 15 * 60 * 1000 + 1000);
    await autoConfirmOnTimeout(h.db, outcome.approvalId, afterExpiry);
    const executed = await executeAndConfirm({ ...deps, now: afterExpiry }, outcome.connectorActionId);

    // BUG: the self-event is DENIED instead of created; the calendar executor never runs.
    expect(executed.status).toBe("denied");
    expect(calls).toHaveLength(0);
    const row = await getConnectorAction(h.db, outcome.connectorActionId);
    expect(row.status).toBe("failed");
  });

  it("GUARD: calendar_event with whenAt === null sends a 'when?' clarification, executor ZERO times", async () => {
    // Use the REAL deterministic parser — it leaves whenAt null.
    const routed = await routeConnectorEmail({
      body: "@Calendar remind me before the renewal call",
      userId: h.userId,
      inboundEmailId: h.inboundEmailId,
      now: NOW,
    });
    expect(routed.command.kind).toBe("calendar_event");
    expect(routed.command.whenAt).toBeNull();

    let execCalls = 0;
    const connectorExecutor: ConnectorExecutor = async () => {
      execCalls += 1;
      return { successful: true, data: {}, error: null };
    };

    const emails: CapturedEmail[] = [];
    const deps: RunConnectorCommandDeps = {
      command: routed.command,
      userId: h.userId,
      inboundEmailId: routed.inboundEmailId,
      account: h.account,
      ownerEmail: "owner@keeps.test",
      appUrl: APP_URL,
      db: h.db,
      connectorExecutor,
      emails,
      now: NOW,
    };

    const outcome = await runUpToApproval(deps);

    // Stopped at the needs-when guard — no approval, no execution.
    expect(outcome.branch).toBe("needs_when");
    expect(emails).toHaveLength(1);
    expect(emails[0].template).toBe("connector_needs_when");
    expect(emails[0].subject).toContain("When should I add");
    expect(execCalls).toBe(0);
  });
});
