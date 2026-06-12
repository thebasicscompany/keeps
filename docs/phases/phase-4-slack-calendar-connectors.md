# Phase 4: Slack And Calendar Connectors

Status: planned
Depends on: 3
Roadmap reference: `docs/roadmap.md` "Phase 4: Slack And Calendar Commands", "Architecture Decision Record > Connectors", "Safety Boundary"

## Goal

A verified user can connect Slack and Google Calendar through the Keeps settings page (OAuth brokered by Nango). The user can then email Keeps connector commands such as `@Slack tell Maya I'll send the deck Friday` or `@Calendar remind me before the renewal call`; the Phase 2.5 intent router classifies these as `connector_command`, the agent produces a typed draft, the Phase 3 approval machinery (drafts + `approval_requests` + `step.waitForEvent`) gates Slack sends (and confirms Calendar inserts), and a single execution-once tool layer hits Slack/Google Calendar through Nango. The policy gate is refactored from `requiresApproval(action)` to `authorize(action, context)` returning `allowed | needs_approval | denied` (AR-7), with room to carry standing grants later without a rewrite. Missing connectors reply with a Nango Connect link; ambiguous recipients (two Mayas) generate a clarification reply and block approval until resolved.

## Why Now

Phase 3 just delivered the nudge cron, daily digest, drafts, `approval_requests`, signed expiring approval links, and the reply parser for approve/reject/edit. Phase 4 is the first phase where the agent's "draft → approval → execute" loop reaches outside the user's private mailbox. Doing connectors before generated insight views (Phase 5) keeps the executable demo arc — "I sent the email; Keeps drafted the Slack; I approved; Slack delivered" — sharp. Delaying the `authorize()` refactor past Phase 4 means writing two connector tools against the wrong policy shape and then rewriting them; doing it inside Phase 4 keeps blast radius to one commit. The connector-specific `connector_accounts` and `connector_actions` tables were carved out of the data model overview in Phase 0 specifically so they land here.

## Preconditions

- Phase 3 is done: `drafts`, `approval_requests`, signed approval links, reply parser for approve/reject/edit, `step.waitForEvent` approval gate, daily digest cron, nudge cron sweep.
- Phase 2.5 intent router (AR-2) is live and routing `capture | command | approval | question | correction`.
- Phase 2.6 deployment exists: Vercel + Neon, Clerk auth, live Postmark outbound. Nango must be able to reach a public callback URL.
- `users.timezone` (IANA TZ string) column exists. The Phase 3 daily digest required local-time send so this is assumed to land in Phase 3. If it has not, Phase 4 must add the migration as Task A0 before connector work begins.
- A Nango workspace exists (free tier is sufficient for V0), and Slack + Google Calendar integrations are configured in the Nango dashboard with the scopes named in Risks below.
- `NANGO_SECRET_KEY`, `NANGO_PUBLIC_KEY`, `NANGO_WEBHOOK_SECRET`, `SLACK_NANGO_INTEGRATION_ID` (e.g. `slack`), `GOOGLE_CALENDAR_NANGO_INTEGRATION_ID` (e.g. `google-calendar`) are populated in `.env.local` and Vercel.

## Deliverables

1. **Nango connector layer.** `src/connectors/nango.ts` exposes `createConnectSession(userId, integrationId)`, `getConnection(integrationId, connectionId)` (returns credentials), and a webhook handler at `app/api/connectors/nango/webhook/route.ts` that verifies the webhook secret, then upserts `connector_accounts` rows on `auth` operations (`success: true` / `success: false`) and `refresh_error` operations. Acceptance: a successful Slack connect from the settings UI persists a `connector_accounts` row with `status='active'`; revoking the Slack app in Slack's UI triggers a Nango webhook that flips the row to `status='revoked'` and emits a `connector.revoked` event.
2. **Settings UI connect/disconnect.** `app/settings/connectors/page.tsx` lists Slack + Google Calendar with status (Not connected / Connected as `<email>` / Needs reconnect / Error) and Connect / Disconnect / Reconnect buttons. Connect calls a server action that returns a Nango Connect session token; the page mounts `@nangohq/frontend`'s `Nango` client and calls `openConnectUI({ sessionToken })`. Acceptance: from a fresh local user, two clicks (Connect Slack, authorize in Slack) land in `connector_accounts` and the page reflects status without a manual refresh.
3. **Reconnect-on-revoke email.** When the Nango webhook reports `auth_error` / `refresh_error`, an email goes to the user with a signed reconnect link that routes to the same settings page in "reconnect mode" (uses `createReconnectSession`). Acceptance: a fixture webhook delivering `refresh_error` for an active connection produces one outbound email containing a reconnect URL.
4. **Connector command intent.** Phase 2.5's intent router gains a `connector_command` branch. The deterministic pre-classifier matches `^\s*@(Slack|Calendar)\b` (case-insensitive) on the cleaned email body's first non-empty line and short-circuits to `command` with `subtype: 'connector_command'`. If the line is `@Slack` or `@Calendar` but does not pattern-match cleanly, the model is called for parsing. Acceptance: fixture `@Slack tell Maya I'll send the deck Friday` classifies as `command/connector_command` without a model call; fixture `Hey, can you @slack ping Maya about Friday?` classifies via the model.
5. **Typed connector-command schema + parser.** `src/agent/schemas.ts` gains `connectorCommandDraftSchema` (Zod): `{ provider: 'slack' | 'google_calendar', kind: 'slack_dm' | 'calendar_event', destination: { kind: 'person', nameText: string, emailText: string | null } | { kind: 'self' }, message: string | null, eventTitle: string | null, whenText: string | null, whenAt: string (ISO) | null, durationMinutes: number | null, reminderMinutesBefore: number | null, linkedLoopId: string | null, ambiguity: string[] }`. `src/agent/parse-connector-command.ts` calls `generateObject` (Vercel AI SDK, AR-8) against this schema with a deterministic regex fallback used by tests. Acceptance: schema is exported, parser has a `useModel: false` mode that handles the README fixtures, and a parsed draft for "tell Maya I'll send the deck Friday" returns `kind: 'slack_dm', destination.nameText: 'Maya', message: "I'll send the deck Friday"`.
6. **Connector tools behind transport interfaces.** `src/connectors/slack.ts` and `src/connectors/calendar.ts` each expose `resolveRecipient`, `executeAction(input, { idempotencyKey, approvalId })`, and accept a `transport` argument. The default transports call Nango proxy / direct Slack and Google APIs; a `fakeTransport` used by tests records calls. Acceptance: passing `fakeTransport` to `executeSlackAction` records a `chat.postMessage` call without network access; the same applies to Calendar `events.insert`.
7. **Policy gate refactor (AR-7).** `src/policy/actions.ts` keeps `ExternalActionKind` (already includes `send_slack_message`, `create_calendar_event`) and adds `authorize(action: KeepsActionKind, context: AuthorizationContext): { result: 'allowed' | 'needs_approval' | 'denied', reason?: string }`. `AuthorizationContext = { userId: string, approval?: { id: string, status: 'pending'|'approved'|'rejected'|'expired'|'cancelled', expiresAt: Date }, standingGrant?: never /* reserved for future */ }` — `standingGrant` is reserved-but-unused so the type carries forward without rewrite. Mapping rules: `approval.status === 'approved'` → `allowed`; `pending` → `needs_approval`; `rejected` / `expired` / `cancelled` → `denied`. Old `requiresApproval` / `assertApprovalAllowed` become thin shims delegating to `authorize`. Acceptance: `authorize('send_slack_message', { userId, approval: { status: 'approved', ... } })` → `allowed`; same action with no approval → `needs_approval`; `authorize('send_slack_message', { userId, approval: { status: 'expired', ... } })` → `denied`; same with `status: 'cancelled'` → `denied`.
8. **`connector_actions` table + execute-once invariant.** New Drizzle table per Data section below with `unique(idempotency_key)`. The execution path is: load row → `SELECT FOR UPDATE` → if `status='completed'`, return cached `result`; if `status='executing'`, return cached `result` (must be set by the executing step before commit); else set `status='executing'`, call transport, write `result` + `status='completed'` + `executed_at`, COMMIT. Acceptance: same approval event delivered twice into the Inngest function produces exactly one Slack `chat.postMessage` call recorded by the fake transport.
9. **Connector-command handler (Inngest function).** `src/workflows/functions/handle-connector-command.ts` is triggered by `connector.action_requested`. Steps: (a) load command + connector account; if missing, send the connect-link reply, audit-log, and stop. (b) Resolve recipient (Slack lookup); if ambiguous, send clarification reply and stop. (c) Create `draft` + `approval_request` rows (reusing Phase 3 machinery). For Slack, send the approval email and `step.waitForEvent('approval.received', { match: 'data.approvalId' })`. For Calendar after direct explicit command, send the confirmation email and `step.waitForEvent` with a short timeout (default 5 min) — if the timeout fires without a reject, treat as confirmed (locked default; see Risks). (d) Call `authorize`; if `allowed`, create `connector_actions` row with idempotency key and execute through the relevant tool module. (e) Emit `connector.action_completed` or `connector.action_failed`. Acceptance: end-to-end fixture flow `@Slack ...` → approval email → simulated `approval.received` → Slack fake transport receives `chat.postMessage` exactly once.
10. **Audit + events emitted.** Every connector lifecycle transition writes an `audit_log` row and emits the matching Inngest event from Events section. Acceptance: a connect → command → approve → send happy path produces `connector.connected`, `connector.action_requested`, `approval.requested`, `approval.received`, `connector.action_completed` in order.

11. **Calendar-triggered capture suggestions (AR-9; added 2026-06-12).** Once Google Calendar is connected, calendar *metadata* (event title, attendees, start/end — never message content) becomes the consented low-sensitivity aperture for targeted capture prompts. Two suggestion shapes, both delivered over email and both passing the AR-9 provenance test ("because your calendar says you met / are meeting"):
    - **Post-meeting capture prompt.** A cron sweep (piggybacks the AR-5 sweep cadence) finds calendar events that ended within the last sweep window where the user was an attendee, and sends at most one consolidated prompt per day-part: `You met with <names> — any commitments to capture? Reply and I'll track them.` Free-text replies route through the intent router's `capture` branch. Suppressed when the user already captured something referencing an attendee within 4h of the meeting (absence signal, derived from captured data only).
    - **Pre-meeting brief.** When a calendar event starts within the next hour and an attendee's email matches a participant on the user's open loops, send: `Meeting <name> at <time> — you have N open loops with them:` followed by the digest-style listing with ordinals (AR-3 metadata, reply commands work). At most one brief per event; respects Phase 3 anti-annoyance caps.
    Acceptance: fixture calendar payloads drive both prompts deterministically; a meeting with an attendee matching no loops and no recent capture produces a post-meeting prompt; a meeting with an attendee matching 2 open loops produces a pre-meeting brief listing both with working ordinals; neither prompt ever includes content from any source other than captured loops + calendar metadata. Both prompt types count toward the Phase 3 daily outbound caps.

## Data & Migrations

New enums (Drizzle, in `src/db/schema.ts`):

- `connector_provider` enum: `slack`, `google_calendar`.
- `connector_account_status` enum: `active`, `revoked`, `auth_error`, `disabled`.
- `connector_action_kind` enum: `slack_dm`, `calendar_event`.
- `connector_action_status` enum: `pending`, `executing`, `completed`, `failed`, `cancelled`.

Extend `audit_action` enum with: `connector.account_connected`, `connector.account_revoked`, `connector.account_auth_error`, `connector.action_requested`, `connector.action_executed`, `connector.action_failed`, `connector.recipient_ambiguous`, `policy.authorize_denied`.

New tables:

```ts
connector_accounts {
  id uuid pk
  user_id uuid fk users on delete cascade
  provider connector_provider not null
  nango_connection_id text not null
  nango_integration_id text not null   // e.g. "slack" or "google-calendar"
  external_account_email text          // resolved from Nango (Slack workspace user / Google account)
  external_account_label text          // human-friendly label for settings UI
  scopes jsonb not null default []
  status connector_account_status not null default 'active'
  status_reason text
  metadata jsonb not null default {}    // workspace_id for Slack, primary_calendar_id for Google
  connected_at timestamptz not null default now()
  last_used_at timestamptz
  disconnected_at timestamptz
  created_at, updated_at timestamptz

  unique(user_id, provider)               // one Slack + one Calendar per user in V0
  unique(nango_connection_id, nango_integration_id)
  index(user_id)
  index(provider, status)
}

connector_actions {
  id uuid pk
  user_id uuid fk users on delete cascade
  connector_account_id uuid fk connector_accounts on delete restrict
  inbound_email_id uuid fk inbound_emails on delete set null     // source command email
  loop_id uuid fk loops on delete set null                        // linked loop if referenced
  draft_id uuid fk drafts on delete set null
  approval_request_id uuid fk approval_requests on delete set null
  kind connector_action_kind not null
  payload jsonb not null               // typed per kind (see schemas.ts)
  idempotency_key text not null
  status connector_action_status not null default 'pending'
  result jsonb                          // { provider_id, channel, ts } for Slack; { eventId, htmlLink } for Calendar
  error jsonb
  requested_at timestamptz not null default now()
  executed_at timestamptz
  failed_at timestamptz
  updated_at timestamptz not null default now()

  unique(idempotency_key)
  index(user_id, status)
  index(connector_account_id)
  index(approval_request_id)
}
```

Existing schema additions:

- `users.timezone text` (IANA string, default `'UTC'`) — dependency from Phase 3 noted in Preconditions. If not landed in Phase 3, Task A0 must add the migration.
- `drafts.action_kind` (defined in Phase 3) gets two new values: `slack_dm`, `calendar_event`. If Phase 3 left this freeform, no migration is required.

Idempotency key shape: `connector:<provider>:<approvalRequestId>` for approval-gated executions; `connector:<provider>:<inboundEmailId>:<commandIndex>` when no approval is required (not used in V0 — every Slack send has an approval; Calendar gets a confirmation-window approval).

## Events

Inngest event payloads (use existing taxonomy from roadmap; only the new ones are spelled here).

- `connector.action_requested` — `{ userId, inboundEmailId, draftId | null, connectorActionId, provider: 'slack' | 'google_calendar', kind: 'slack_dm' | 'calendar_event' }`. Emitted by the intent router after parsing succeeds.
- `connector.connected` — `{ userId, provider, connectorAccountId, externalAccountEmail }`. Emitted by the Nango webhook handler on first `auth.success`.
- `connector.revoked` — new event (extend roadmap taxonomy). `{ userId, provider, connectorAccountId, reason }`. Emitted on `auth_error` / `refresh_error` / user-disconnect.
- `approval.requested` — reused; payload extended with `{ context: 'connector_action', connectorActionId }`.
- `approval.received` — reused; the connector workflow `waitForEvent`s on this with `match: 'data.approvalId'`.
- `connector.action_completed` — `{ userId, connectorActionId, provider, kind, result }`.
- `connector.action_failed` — `{ userId, connectorActionId, provider, kind, error: { code, message, retryable } }`.

`process-email` (Phase 2.5 router) emits `connector.action_requested` from the new `connector_command` branch instead of routing into the capture branch.

## Task Breakdown

Tasks are grouped into waves; tasks inside a wave are independent and may be claimed by separate agents in parallel. Every task names files, functions, and the expected behavior change.

### Wave A — foundations (parallelizable, no inter-dependencies)

**A0. `users.timezone` migration safety net.** Files: `src/db/schema.ts`, `src/db/migrations/<n>_users_timezone.sql`. Add column iff Phase 3 has not. No-op if present. Update `User` Zod read schema if one exists.

**A1. Schema + migration for connector tables and enums.** Files: `src/db/schema.ts`, `src/db/migrations/<n>_connector_accounts_and_actions.sql`. Add the enums and two tables from Data section above. Export `ConnectorAccount`, `NewConnectorAccount`, `ConnectorAction`, `NewConnectorAction` types. Extend `auditActionEnum` with the new actions.

**A2. Policy gate refactor (AR-7).** Files: `src/policy/actions.ts`, `src/policy/__tests__/actions.test.ts`. Add `AuthorizeContext`, `AuthorizeDecision` types, `authorize(action, context)` function, and the `standingGrant` reserved field. Keep `requiresApproval` / `assertApprovalAllowed` as shims that call `authorize`. Add unit tests covering the truth table from Deliverable 7.

**A3. Connector command Zod schema + types.** Files: `src/agent/schemas.ts`. Add `connectorCommandDraftSchema`, `connectorActionPayloadSchema` (discriminated union by `kind`), and exported TS types. No model call yet — schema only.

**A4. Nango env validation + client construction.** Files: `src/connectors/nango.ts`, `src/env.ts` (or wherever env validation lives). Add the four env vars and zod-validate at boot. Construct a singleton `Nango` from `@nangohq/node`. Export `createConnectSession`, `createReconnectSession`, `getConnection`, `verifyNangoWebhookSignature`.

### Wave B — connector tools and intent router (depends on Wave A)

**B1. Slack tool module.** Files: `src/connectors/slack.ts`, `src/connectors/__tests__/slack.test.ts`. Exports: `resolveSlackUser({ email, name }, transport)` (calls `users.lookupByEmail`; if 404 or no email, fall back to `users.list` paginated search by `real_name`/`display_name` — capped at first page in V0; returns `{ status: 'resolved', userId, name, email } | { status: 'ambiguous', candidates: [...] } | { status: 'not_found' }`), `openDirectMessage(userId, transport)` (`conversations.open`), `postMessage({ channel, text, threadIdempotencyKey }, transport)` (`chat.postMessage`), and the orchestrating `executeSlackDm(payload, transport)`. Define `SlackTransport` interface and `createFakeSlackTransport()` for tests. Bot token is fetched via Nango at call time, not stored. Implementation note: all calls go through Nango proxy (`nango.proxy({ method, endpoint, providerConfigKey: 'slack', connectionId })`) so token refresh is delegated.

**B2. Google Calendar tool module.** Files: `src/connectors/calendar.ts`, `src/connectors/__tests__/calendar.test.ts`. Exports: `resolveTimezone(user)` (reads `users.timezone`, defaults to `'UTC'`), `createEvent({ summary, description, startISO, endISO, timeZone, reminderMinutesBefore, sourceLoopId }, transport)` (POST `events.insert` to `primary` calendar with `reminders: { useDefault: false, overrides: [{ method: 'popup', minutes }] }`), and the orchestrating `executeCalendarEvent(payload, user, transport)`. Define `CalendarTransport` interface and `createFakeCalendarTransport()`. Description embeds a back-link to the source loop (`https://keeps.ai/loops/<loopId>` or signed expiring URL once Phase 5 lands; placeholder URL is acceptable in Phase 4). Uses Nango proxy with `providerConfigKey: 'google-calendar'`.

**B3. Connector command parser.** Files: `src/agent/parse-connector-command.ts`, `src/agent/__tests__/parse-connector-command.test.ts`. `parseConnectorCommand({ emailBody, intentClassification, user }, { useModel })` returns a `ConnectorCommandDraft`. Deterministic regex fallback handles `@(Slack|Calendar)\s+(.+)` for the README fixtures so tests do not need credentials. Model path uses `generateObject` against `connectorCommandDraftSchema` (AR-8).

**B4. Intent router extension.** Files: `src/loops/intent-router.ts` (Phase 2.5 file — assumed present), `src/loops/__tests__/intent-router.test.ts`. Add the deterministic `@Slack`/`@Calendar` rule to short-circuit to `command` with `subtype: 'connector_command'`. When subtype is `connector_command`, the router calls `parseConnectorCommand` and emits `connector.action_requested` (does not branch into capture).

**B5. Outbound email templates for connector flows.** Files: `src/email/templates/connector-missing.ts`, `connector-ambiguous.ts`, `connector-approval.ts`, `connector-reconnect.ts`. Use the Phase 2.5 outbound sender interface. Each template takes a typed input and returns `{ subject, text, html }`. Approval template includes signed approve/reject/edit links (reuses Phase 3 token helpers). Reconnect template includes signed reconnect URL.

### Wave C — Nango integration plumbing (depends on Wave A)

**C1. Nango Connect session server actions.** Files: `app/settings/connectors/actions.ts`. Server actions `startSlackConnect()` and `startCalendarConnect()` call `createConnectSession` with appropriate `allowed_integrations` and return `{ sessionToken }`. `startReconnect(provider)` calls `createReconnectSession`. Auth-gated by Clerk session; ties session to current user id via Nango `endUserId`.

**C2. Nango webhook handler.** Files: `app/api/connectors/nango/webhook/route.ts`, `src/connectors/__tests__/nango-webhook.test.ts`. POST endpoint: verify signature via `verifyNangoWebhookSignature` (HMAC of body with `NANGO_WEBHOOK_SECRET`), parse Nango's `auth` / `sync` / `forward` payload shapes (only `auth` is handled in V0), upsert `connector_accounts` by `(nango_connection_id, nango_integration_id)`, emit `connector.connected` or `connector.revoked`, audit-log. Return 200 within 5s; defer Nango proxy calls (e.g. fetching account email/label) to an Inngest step.

**C3. Connector account hydration step.** Files: `src/workflows/functions/hydrate-connector-account.ts`. Triggered by `connector.connected`. Calls `nango.getConnection` to read the OAuth response (Slack returns `authed_user`/`team`; Google returns `id_token`/`profile`), then updates `connector_accounts.external_account_email`, `external_account_label`, `scopes`, `metadata.workspace_id` / `metadata.primary_calendar_id`. Idempotent on `connector_account_id`.

### Wave D — workflow and UI (depends on Waves B and C)

**D1. `handle-connector-command` Inngest function.** Files: `src/workflows/functions/handle-connector-command.ts`. Triggered by `connector.action_requested`. Implementation follows Deliverable 9 steps (a–e). Uses Inngest `idempotency: 'event.data.connectorActionId'` to make replays safe. `step.waitForEvent('approval.received', { match: 'data.approvalId', timeout: '7d' })` for Slack; same shape with `timeout: '15m'` for Calendar confirmation-window. After timeout: Slack defaults to cancel; Calendar defaults to execute (locked roadmap default — see Risks).

**D2. Execute-once transaction.** Files: `src/connectors/execute.ts`. `executeConnectorAction({ connectorActionId, transports })`. Wraps the `connector_actions` row in `SELECT ... FOR UPDATE`, branches on `status`, calls `authorize`, dispatches to `executeSlackDm` or `executeCalendarEvent`. Writes result + status in the same transaction. Unit test: invoke twice concurrently against the fake transports and assert exactly one transport call.

**D3. Settings UI for connectors.** Files: `app/settings/connectors/page.tsx`, `app/settings/connectors/connect-button.tsx` (client component). The page fetches `connector_accounts` for the current user; the client component receives a server-action callback for `startSlackConnect`/`startCalendarConnect`, mounts the `@nangohq/frontend` `Nango` client, calls `openConnectUI({ sessionToken })`, and after success calls `router.refresh()`. Disconnect calls a server action that flips the row to `disabled` and tells Nango via `nango.deleteConnection`.

**D4. Settings UI tests.** Files: `app/settings/connectors/__tests__/page.test.tsx`. Render with three states: no connections, active Slack only, revoked Calendar. Assert correct copy and button targets. Do not test live OAuth here.

**D5. Audit-log + observability glue.** Files: `src/connectors/audit.ts`. Helpers that write `audit_log` entries for every lifecycle transition. Unit-tested against an in-memory writer.

### Wave E — end-to-end fixtures (depends on Waves B, C, D)

**E1. Fixture: `@Slack tell Maya...` happy path.** Files: `src/connectors/__tests__/e2e-slack-happy.test.ts`. Drives `email.received` → intent router → `connector.action_requested` → `handle-connector-command` → simulated `approval.received` → execute → assert fake Slack transport received one `chat.postMessage` and `connector_actions.status = 'completed'`.

**E2. Fixture: idempotent re-delivery.** Files: `src/connectors/__tests__/e2e-idempotent.test.ts`. Same setup as E1, but `approval.received` is delivered twice. Assert one transport call, one `connector_actions` row.

**E3. Fixture: missing connector.** Files: `src/connectors/__tests__/e2e-missing-connector.test.ts`. No `connector_accounts` row for Slack. Assert the outbound queue has one connect-link email, no transport calls.

**E4. Fixture: ambiguous recipient.** Files: `src/connectors/__tests__/e2e-ambiguous-recipient.test.ts`. Slack fake returns two Mayas. Assert outbound queue has one clarification email, no draft is approved, no transport call.

**E5. Fixture: `@Calendar` direct command.** Files: `src/connectors/__tests__/e2e-calendar-direct.test.ts`. Assert: a `draft` + `approval_request` are created, the confirmation email goes out, simulating `approval.received` (or letting the 15 min timeout fire in fake time) results in exactly one `events.insert` call.

**E6. Fixture: `authorize` denial paths.** Files: `src/connectors/__tests__/e2e-authorize-denial.test.ts`. Expired approval → `authorize` returns `denied` → row goes to `failed` with `error.code='approval_expired'`, no transport call.

## Testing

Unit:

- `src/connectors/__tests__/slack.test.ts` — `resolveSlackUser` cases (email hit, email miss + name search hit, name search ambiguous, no results), `postMessage` payload shape, error mapping (Slack `not_in_channel`, `user_not_found`).
- `src/connectors/__tests__/calendar.test.ts` — timezone handling, reminder overrides, description embedding source loop link.
- `src/connectors/__tests__/nango-webhook.test.ts` — signature verification (HMAC), `auth/success` → `connector.connected`, `auth/refresh_error` → `connector.revoked`, replay-safety.
- `src/policy/__tests__/actions.test.ts` — full `authorize` truth table.
- `src/agent/__tests__/parse-connector-command.test.ts` — deterministic regex fallback covers the README fixtures; the model-on path is exercised by a stub `generateObject`.

Integration (Inngest test runner, fake transports):

- `handle-connector-command` happy path, idempotent re-delivery, missing connector, ambiguous recipient, denial via expired approval. Listed as E1–E6 above.

Out-of-CI (live sandbox; runnable via `pnpm test:live` and gated by a `KEEPS_LIVE_SLACK=1` env flag):

- Real Slack workspace: a manual fixture that connects a sandbox workspace, sends a `@Slack tell <self>` from a test email, approves, asserts a real Slack message lands.
- Real Google Calendar: same shape, asserts a real event lands on the test account's primary calendar.

Live sandboxes stay out of CI because they require human OAuth and externally provisioned accounts. They are documented in `docs/phases/phase-4-slack-calendar-connectors.md` (this doc) under Risks and runnable as part of phase exit verification.

Fixtures needed:

- `tests/fixtures/connector/slack-direct-command.json` — Postmark-shaped inbound payload with `@Slack tell Maya I'll send the deck Friday`.
- `tests/fixtures/connector/calendar-direct-command.json` — `@Calendar remind me before the renewal call`.
- `tests/fixtures/connector/slack-ambiguous-name.json` — `@Slack ping Alex` where the fake Slack transport returns two Alexes.
- `tests/fixtures/connector/nango-webhook-auth-success.json`, `nango-webhook-refresh-error.json`.

## Risks & Open Questions

- **Calendar default (V0): execute after direct explicit command with confirmation window.** Roadmap recommends loosening calendar approval-gating after direct explicit commands; `product-contract.md` (Phase 0 wording) still has calendar as approval-gated. This phase implements the loosened rule: a direct `@Calendar` command sends a confirmation email with a "cancel within 15 minutes" link and executes after the timer fires unless cancelled. We update `product-contract.md` in Wave A with one sentence pointing to this phase. Default: 15 minute confirmation window; user can disable in settings (future phase).
- **Slack scopes (V0).** Required bot scopes on the Slack app configured in Nango: `users:read`, `users:read.email` (for `users.lookupByEmail`), `im:write` (for `conversations.open`), `chat:write` (for `chat.postMessage` posting as the bot). Verified against Slack Developer Docs (`users.lookupByEmail` requires `users:read.email`; `chat.postMessage` requires `chat:write`; `conversations.open` is allowed under `im:write`). Posting as the user (vs the Keeps bot) would require a user token with `chat:write` and is out of scope — V0 posts as the Keeps bot. Open question: should Keeps DM appear as the user in V0? Recommended default: no, Slack messages come from the Keeps bot with the user's name in the message body ("Arav says: ...") so identity is preserved without user-token complexity.
- **Slack name-search fallback.** `users.list` is paginated and expensive. V0 caps at the first page (~200 users) and returns `ambiguous` if more than one match. For workspaces > 200 users, the user gets an ambiguity reply asking for the email. This is acceptable for V0; revisit in Phase 6.
- **Google Calendar scope.** Required scope on the Google OAuth client configured in Nango: `https://www.googleapis.com/auth/calendar` (verified at Google Workspace Calendar API events docs). `calendar.events` would be tighter but does not cover all `events.insert` cases on shared calendars — V0 uses `primary` only, so we could downscope to `https://www.googleapis.com/auth/calendar.events`. Recommended default: use `calendar.events` (least privilege) and revisit if a future deliverable needs full calendar read.
- **Reminder semantics for `@Calendar remind me ...`** — implement as a Google Calendar event with `reminders.overrides = [{ method: 'popup', minutes: <derived> }]`. Rejected alternative: Google Tasks API (`https://www.googleapis.com/auth/tasks`) — adds another OAuth scope and another product surface for the user, and the user already sees a Calendar prompt; Tasks does not appear in mobile calendar widgets the same way. Calendar event is the simpler "remind me at time X" affordance for V0.
- **Idempotency key derivation when no approval exists.** V0 always has an approval (Slack: explicit approval; Calendar: confirmation-window approval). If a future phase introduces no-approval execution (standing grant), the idempotency key falls back to `connector:<provider>:<inboundEmailId>:<commandIndex>`. The `connector_actions.idempotency_key` column is already `unique` so this works without schema change.
- **Nango webhook delivery shape may evolve.** Verified at https://nango.dev/docs that current shape uses `createConnectSession` server-side, `@nangohq/frontend` `openConnectUI({ sessionToken })` client-side, `nango.getConnection(integrationId, connectionId)` server-side for credentials, and webhook events with `connectionId`, `operation`, and `success`. If Nango ships a breaking change before this phase ships, update `src/connectors/nango.ts` and the webhook handler — the rest of the codebase only sees our wrapper.
- **Standing grants (AR-7 future).** `authorize` accepts a reserved `standingGrant` field today (`never` type in V0) so a future phase can populate it without touching every call site. The connector tools never destructure `context.approval` directly — they call `authorize` and trust its decision.
- **Recipient not in Slack.** When the email mentions a person who is not in Slack (`status: 'not_found'`), the reply offers to send an email instead — but external email sending is V0-disallowed (product contract). For V0, the reply just states "I could not find <name> in Slack" and stops. Future phase may suggest a Calendar invite.

## Out of Scope

- Linear, Jira, GitHub, or any connector beyond Slack and Google Calendar.
- Slack DMs to the user (the user-facing channel stays email-first; nudges via Slack are a future phase).
- Reading Slack workspace history, channel history, or any inbound Slack events. Nango is configured for outbound API calls only.
- User-defined automations / standing grants. The `authorize` shape accepts standing grants but the V0 enum only ever evaluates approval context.
- Recurring calendar events. V0 creates one event per command.
- Cross-calendar selection. V0 always writes to the user's `primary` Google Calendar.
- Email to third parties. Roadmap Safety Boundary forbids it; tools enforce.
- Slack channels (vs DMs). V0 only sends DMs (`conversations.open` → `chat.postMessage`). Public-channel posting is a future phase.
- Live model parsing in CI. Tests use the deterministic regex fallback (AR-8).

## Exit Criteria

- [ ] Migrations for `connector_accounts`, `connector_actions`, the four new enums, and the extended `audit_action` enum are applied locally and on Neon.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- [ ] `src/policy/actions.ts` exports `authorize(action, context)` with the truth table from Deliverable 7; legacy callers go through the shims.
- [ ] Settings page lets a local user connect Slack via Nango Connect UI; `connector_accounts` row appears with `status='active'` and `external_account_email` populated.
- [ ] Settings page lets a local user connect Google Calendar; status reflected correctly.
- [ ] Revoking the Slack integration in Slack flips the `connector_accounts` row to `revoked` via the Nango webhook and emits a reconnect email.
- [ ] Fixture E1 (Slack happy path) passes against fake transports: one outbound approval email, one `chat.postMessage` call, one `connector_actions.completed` row.
- [ ] Fixture E2 (idempotent re-delivery) passes: same approval delivered twice yields one transport call.
- [ ] Fixture E3 (missing connector) passes: outbound queue has one connect-link email, zero transport calls.
- [ ] Fixture E4 (ambiguous recipient) passes: outbound queue has one clarification email, zero transport calls, no draft approved.
- [ ] Fixture E5 (Calendar direct command) passes: one confirmation email, one `events.insert` call after the timer fires (or after explicit confirm).
- [ ] Fixture E6 (authorize denial) passes: expired approval → `failed` status, zero transport calls.
- [ ] Live sandbox runs (Slack + Calendar) executed once by hand against real workspaces; results logged in the phase commit message. Not gated in CI.
- [ ] `product-contract.md` updated with one sentence noting Phase 4 loosens calendar approval gating to a confirmation window.
- [ ] All Inngest events from the Events section are emitted by the workflow at the documented lifecycle points; audit log has matching entries.
