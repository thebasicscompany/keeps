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
 * BUG FOUND BY THIS FIXTURE, NOW FIXED:
 *
 *   Originally the reversible confirmation-window approval TTL and the waitForEvent
 *   timeout were BOTH 15m, so when the timeout fired the approval was already
 *   clock-expired, decideApproval(approved) was refused, and AR-7 denied the execute —
 *   the self-calendar event the user simply ignored was NEVER created, contradicting
 *   "I'll add it in 15 minutes unless you cancel."
 *
 *   FIX (handle-connector-command.ts, mirrored in e2e-harness.ts): the reversible
 *   approval TTL is now CONFIRM_WINDOW_TTL_MS (1h), STRICTLY LONGER than the 15m
 *   waitForEvent timeout. When the timeout fires at 15m the grant is still valid, so
 *   auto-confirm succeeds and AR-7 allows the execute. The happy-path test below now
 *   confirms at the REAL 15m timeout and asserts the event IS created; the fail-closed
 *   test asserts AR-7 still denies a genuinely-expired grant (past the 1h TTL).
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

    // ── The confirmation-window timeout fires at the REAL 15m boundary → auto-confirm
    // via channel 'cron' → execute once. The approval TTL is now 1h (> the 15m window),
    // so the grant is still valid when the timeout auto-confirms it — the event the user
    // ignored IS created, as promised. (This is the regression guard for the bug.)
    const atTimeout = new Date(NOW.getTime() + 15 * 60 * 1000);
    await autoConfirmOnTimeout(h.db, outcome.approvalId, atTimeout);
    const executed = await executeAndConfirm(
      { ...deps, now: atTimeout },
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

  it("FAIL-CLOSED: a genuinely-expired grant (confirm past the 1h TTL) is still denied — AR-7 backstop", async () => {
    // After the fix, the 15m timeout auto-confirms well within the 1h TTL, so the normal
    // path executes. This test pins the AR-7 fail-closed backstop: if a confirm somehow
    // lands AFTER the approval's real expiry (past the 1h TTL — e.g. the sweep already
    // expired it), decideApproval refuses to flip it and AR-7 DENIES the execute. We must
    // never execute against an expired grant, even on the auto-confirm path.
    const resolved: ConnectorCommandDraft = {
      provider: "google_calendar",
      kind: "calendar_event",
      destination: { kind: "self", nameText: null, emailText: null },
      message: null,
      eventTitle: "Expired grant event",
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

    // Confirm PAST the real approval expiry (1h TTL + 1s) — the grant is genuinely dead.
    const afterRealExpiry = new Date(NOW.getTime() + 60 * 60 * 1000 + 1000);
    await autoConfirmOnTimeout(h.db, outcome.approvalId, afterRealExpiry);
    const executed = await executeAndConfirm({ ...deps, now: afterRealExpiry }, outcome.connectorActionId);

    // Fail-closed: an expired grant is DENIED, the calendar executor never runs.
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
