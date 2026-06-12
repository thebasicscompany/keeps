# Phase 3: Nudges, Digests, And Approval Workflow

Status: planned
Depends on: 2.5, 2.6
Roadmap reference: `docs/roadmap.md` — "Phase 3: Nudges, Digests, And Approval Workflow"

## Goal

Keeps becomes useful between captures. A cron-driven sweep finds loops whose `next_check_at` has elapsed and sends private nudges, respecting per-loop cooldowns, snoozes, and a per-user daily cap. An hourly digest cron sends a per-user daily digest at the user's local 8 AM (configurable), categorized into "needs attention / waiting on others / due soon / stale / recently done", with reply commands (snooze/done/insights) that resolve through the Phase 2.5 intent router and nudge-metadata ordinal mapping (AR-3). An approval pipeline is in place end-to-end: a draft + `approval_request` row, an outbound approval email with signed expiring approve/edit/cancel links, a generic Inngest function that `step.waitForEvent('approval.received', { match, timeout: '7d' })` and on approval calls through the policy gate, on timeout marks the request expired and notifies the user. Reply-based approval ("approve" / "reject 1" / "edit") flows through the intent router's `approval` branch, which Phase 2.5 stubbed out and this phase implements. No connectors execute yet — Phase 3 ships a no-op `test_action` so Phase 4's Slack/Calendar plug in without rewrite.

## Why Now

Phase 2 (loop extraction) creates loops with a `next_check_at` and a `nudges` table, but nothing currently fires those nudges or surfaces loops over time, so the product only exists at capture time. Phase 2.5 lands the outbound email sender (`EmailSender` interface), the intent router (with `approval` stubbed), nudge ordinal metadata (AR-3), and the lifecycle-only status enum (AR-6). Phase 2.6 stands up Clerk (so we have stable user identity, can show approval pages behind login when needed, and can authoritatively know the user's verified email) and live Postmark transport. With both in place, Phase 3 is the first phase that exercises the cron sweep (AR-5), the approval `waitForEvent` shape (AR-5), and the policy `authorize()` evolution (AR-7), giving Phase 4 a real harness to plug Slack and Calendar connectors into. The "Keeps is useful over time" promise in the roadmap can't be tested without this phase.

## Preconditions

- Phase 2.5 is merged and verified:
  - AR-1 single processing path through Inngest, AR-2 intent router emits an `approval` branch (currently a stub), AR-3 nudge ordinal metadata persists in `nudges.metadata`, AR-4 `process-email` idempotency on `inboundEmailId`, AR-6 stored-status enum is `candidate | open | waiting_on_me | waiting_on_other | blocked | snoozed | done | dismissed` (no `due_soon` / `overdue`).
  - `EmailSender` interface exists in `src/email/outbound.ts` with `DevRecordingSender` (a dev transport that records to a table/in-memory store) and a Postmark adapter contract. Outbound emails set `Reply-To: agent+n_<nudgeId>@keeps.ai`, `In-Reply-To`, and `References` headers.
- Phase 2.6 is merged and verified:
  - Clerk replaces `src/auth/dev-session.ts`. `users.email` is the Clerk-verified primary email.
  - Live Postmark inbound + outbound transport is wired to `EmailSender`.
  - Vercel + Neon + Inngest cloud are deployed; cron functions registered with Inngest can actually run on the schedule.
- Local dev still works: Inngest dev server at `localhost:8288`, Postgres at `localhost:55433`, dev `EmailSender` records instead of sending.
- `pnpm typecheck`, `pnpm test`, `pnpm build` pass on `main`.

## Deliverables

1. **`last_nudged_at` and nudge bookkeeping columns on `loops`.**
   Acceptance: a Drizzle migration adds `last_nudged_at timestamptz null`, `nudge_count integer not null default 0`, and an index `loops_next_check_at_idx` on `(status, next_check_at)` filtered to active statuses (or non-partial — see Risks). `pnpm typecheck` passes after `src/db/schema.ts` is updated.

2. **User digest preferences and timezone.**
   Acceptance: a migration adds `users.timezone text not null default 'UTC'`, `users.digest_enabled boolean not null default true`, `users.digest_send_hour integer not null default 8` (0–23). A simple settings update path exists (server action or API route) and is unit-tested. Until Clerk provides a timezone, an onboarding setting captures it; default falls back to `UTC` if unset.

3. **`approval_requests` and `drafts` tables.**
   Acceptance: migrations create:
   - `drafts(id uuid pk, user_id uuid fk users, action_kind text not null, payload jsonb not null default '{}', source_loop_id uuid null fk loops, created_at timestamptz default now())`.
   - `approval_requests(id uuid pk, user_id uuid fk users, draft_id uuid not null fk drafts, action_kind text not null, status approval_status not null default 'pending', token_hash text not null, expires_at timestamptz not null, decided_at timestamptz null, decision_channel text null, decision_metadata jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now())`.
   - `approval_status` pg enum: `pending | approved | rejected | expired | cancelled`.
   - Index `approval_requests_user_status_idx` on `(user_id, status)`, unique index on `token_hash`.
   `Draft`, `ApprovalRequest` types exported.

4. **Audit and event additions.**
   Acceptance: `auditActionEnum` gains `nudge.sent`, `digest.sent`, `approval.requested`, `approval.decided`, `approval.expired`, `approval.executed`, `approval.execution_failed`. Inngest events are added to a typed registry (`src/workflows/events.ts`, created if missing): `loop.nudge_due`, `digest.daily_due`, `digest.daily_requested`, `approval.requested`, `approval.received`, `report.requested` (stub only). `loop.nudge_scheduled` is intentionally NOT added — see Risks #1 for justification.

5. **Nudge sweep cron (AR-5).**
   Acceptance: `src/workflows/functions/sweep-nudges.ts` registers `sweep-nudges` on `cron: */10 * * * *` (every 10 min). The function queries loops eligible for a nudge and emits one `loop.nudge_due` per loop in a batched `step.sendEvent`. A separate function `src/workflows/functions/send-nudge.ts` consumes `loop.nudge_due`, validates the loop is still eligible (re-check inside the function — guards against duplicate enqueues), composes the nudge body, sends via `EmailSender`, marks the `nudges` row `sent`, sets `loops.last_nudged_at = now()`, increments `loops.nudge_count`, advances `loops.next_check_at` by the loop's "next nudge window" (default 3 days unless overridden by status), and writes a `loop_events` row of a new `nudged` event type plus an `audit_log` row. Unit tests cover the eligibility query and the send handler.

6. **Anti-annoyance rules.**
   Acceptance:
   - Per-loop cooldown: a loop is ineligible if `last_nudged_at` is within the last 24 hours (configurable per-loop later; constant for now in `src/nudges/policy.ts`).
   - Snoozed loops are skipped (status filter excludes `snoozed`).
   - Done/dismissed/blocked are skipped.
   - Candidate aging: a `candidate` loop is eligible only if its `created_at` is older than 48h AND it has never been nudged AND `next_check_at <= now`. Goal: re-ask once if the user never answered the confirmation reply.
   - Per-user daily cap: max 5 nudges/user/day, computed from `nudges.sent_at >= start_of_user_local_day` (digest does NOT count toward this cap). If cap is hit, push remaining eligible loops' `next_check_at` to the next day.
   - All thresholds live as named constants in `src/nudges/policy.ts` for one-place tuning. Pure functions take `now` and a clock-free repository — fully unit-testable.

7. **Daily digest cron.**
   Acceptance: `src/workflows/functions/sweep-digests.ts` registers `sweep-digests` on `cron: 0 * * * *` (hourly, at minute 0). Each run computes "the current UTC hour" and selects users whose local-hour-of-day right now equals their `digest_send_hour` AND `digest_enabled = true` AND no digest has been sent to them in the last 23 hours. For each, emits `digest.daily_due { userId }`. A second function `src/workflows/functions/send-digest.ts` consumes `digest.daily_due`, builds the digest from `src/digests/build.ts` (pure function over loops), renders the email body, sends via `EmailSender`, persists a `nudges` row of `nudge_type = 'digest'` with ordinal-to-loopId mapping in `metadata` (AR-3), and writes `audit_log` `digest.sent`. Per-user idempotency: the `nudges` row insert is guarded with a unique partial index on `(user_id, nudge_type, date_trunc('day', sent_at at time zone <user_tz>))` OR (simpler) the eligibility query rechecks "no digest in last 23h" inside the function before sending. Pick the simpler in-function check; document the upgrade path.

8. **Digest categorization.**
   Acceptance: `src/digests/build.ts` exports `buildDigest({ user, loops, now }): DigestModel` that groups loops into derived buckets (derived per AR-6 from `status`, `due_at`, `next_check_at`, `last_nudged_at`):
   - `needsAttention`: status in (`open`, `waiting_on_me`) AND (`due_at` ≤ now+24h OR `next_check_at` ≤ now).
   - `waitingOnOthers`: status = `waiting_on_other`.
   - `dueSoon`: status in (`open`, `waiting_on_me`) AND `due_at` between now+24h and now+72h.
   - `stale`: status in (`open`, `waiting_on_me`, `waiting_on_other`) AND `updated_at < now - 7d`.
   - `recentlyDone`: status = `done` AND `updated_at >= now - 24h`.
   - Order, dedupe (`needsAttention` wins over `dueSoon`), cap at 5 per section.
   `renderDigestEmail(model)` produces a text body matching the roadmap UX sample, ending with reply commands: `snooze 1 until Monday`, `done 2`, `insights`. Each rendered loop maps to an ordinal; the renderer returns the ordinal→loopId map for `nudges.metadata` (AR-3).

9. **Direct email commands routed through the intent router.**
   Acceptance: in Phase 2.5 the intent router has a `question` branch. This phase wires that branch (when the question matches `/what are my open loops/i`, `/^insights\b/i`, `/^status\b/i`) to a handler in `src/workflows/functions/handlers/answer-question.ts` that calls `buildDigest` for the current moment and sends the same digest-style email as the reply (no generated link yet — Phase 5 adds that). For any other question, the router falls back to a polite "I cannot answer that yet" reply. The full generated-view version is Phase 5.

10. **Approval request lifecycle.**
    Acceptance:
    - `src/approvals/service.ts` exports `createApprovalRequest({ userId, draft, ttl = 7d, now }): { request, token }` which inserts a `drafts` row, an `approval_requests` row, returns a random 32-byte URL-safe token whose SHA-256 is stored in `token_hash`. The plaintext token is only returned to the caller (for the email link); never persisted.
    - `verifyApprovalToken(token, now): ApprovalRequest | null` looks up by hashed token, rejects expired/decided.
    - `decideApproval({ approvalId, decision, channel, metadata, now })` is a single state-transition function that updates row to `approved | rejected | cancelled`, sets `decided_at` + `decision_channel`, and emits `approval.received` via the workflow client.
    - Decisions are idempotent (no-op + return current state if already decided).

11. **Approval Inngest workflow with `waitForEvent` (AR-5).**
    Acceptance: `src/workflows/functions/handle-approval.ts` registers on `approval.requested` and:
    - sends the approval email via `EmailSender` (subject, body with approve/edit/cancel links containing the plaintext token + `approvalId`),
    - calls `step.waitForEvent('approval.received', { match: 'data.approvalId', timeout: '7d' })`,
    - on event: branches on `data.decision`. `approved` → call `executeApprovedDraft(approvalId)`; `rejected` / `cancelled` → write `audit_log`, send the user a one-line confirmation email; `expired` is not emitted here, it's a separate path.
    - on timeout: call `decideApproval` with `decision: 'expired'`, send a one-line "I expired this approval, no action taken" email, write `audit_log`.

12. **Signed expiring approval links and minimal app pages.**
    Acceptance:
    - `src/approvals/tokens.ts`: token is a random 32-byte base64url string (not an HMAC). Storage: SHA-256 hash in `approval_requests.token_hash`. Rationale: simpler to revoke (delete row), no signing key rotation, leakage of one token is contained. Expiry is row-level (`expires_at`). HMAC alternative noted in Risks.
    - Routes: `app/approvals/[id]/page.tsx` (server component) takes `?token=...` and `?action=approve|edit|cancel`. For non-sensitive approvals (default), the page accepts the token without a Clerk session and renders a small confirm screen with one button; on click POSTs to `app/approvals/[id]/decide/route.ts` which calls `decideApproval`. If `requiresLogin = true` on the draft (used for approvals that reveal source evidence per roadmap default), the page redirects unauthenticated users to Clerk sign-in first.
    - The decision route also emits the `approval.received` event so the Inngest workflow advances.

13. **Reply-based approval ("approve" / "reject" / "edit").**
    Acceptance:
    - `src/loops/commands.ts` is extended with a new parser path for approval commands. Add `LoopReplyCommand` variants `approve`, `reject`, `edit` OR (cleaner) introduce a separate `ApprovalReplyCommand` parser at `src/approvals/commands.ts` that the intent router selects when the inbound email's `MailboxHash` resolves to a nudge of `nudge_type = 'approval'`. Recommended: separate parser keeps the loop command surface focused.
    - Commands: `approve`, `approve all`, `reject`, `reject 1` (ordinal), `cancel`, `edit: <new payload as text>`. Time-dependent code accepts injected `now` (mirror `parseLoopReplyCommand`).
    - The intent router's `approval` branch (stubbed in Phase 2.5) is now implemented in `src/workflows/functions/handlers/handle-approval-reply.ts`: resolve `approvalId` from the referenced nudge metadata (AR-3, NEVER from a fresh listing), parse, call `decideApproval`, send a one-line confirmation.

14. **Policy gate hooks the approval pipeline (AR-7 prep).**
    Acceptance:
    - `src/policy/actions.ts` evolves: introduce `authorize(action: KeepsActionKind, context: AuthorizationContext): { result: 'allowed' | 'needs_approval' | 'denied', reason?: string }`. `assertApprovalAllowed` is retained for back-compat but delegates to `authorize`. Context shape: `AuthorizationContext = { userId: string, approval?: { id: string, status: 'pending'|'approved'|'rejected'|'expired'|'cancelled', expiresAt: Date }, standingGrant?: never /* reserved for future */ }`.
    - `executeApprovedDraft(approvalId)` in `src/approvals/execute.ts` is the single funnel through which approved actions run: looks up draft + approval, calls `authorize(draft.action_kind, { userId, approval: { id: approval.id, status: approval.status, expiresAt: approval.expires_at } })`, and dispatches to an action registry `src/approvals/actions/registry.ts`. The registry maps `action_kind` → handler. In Phase 3 the only registered action is `test_action` which is a no-op that writes `audit_log.approval.executed` and returns. Phase 4 will register `send_slack_message` and `create_calendar_event`.
    - Unknown `action_kind` writes `audit_log.approval.execution_failed` and surfaces an error email to the user.

15. **Reply-to-nudge resolution for digest commands.**
    Acceptance: when a user replies "snooze 1 until Monday" to a digest, the inbound email's `MailboxHash` (`agent+n_<nudgeId>`) resolves to the digest's `nudges` row. The intent router's `command` branch resolves ordinal 1 to the loopId stored in that nudge's metadata (AR-3). Snooze sets `loops.status = 'snoozed'` and `loops.next_check_at = <Monday at 9 AM user-local>`. No workflow cancellation is needed because there is no per-loop workflow — the next sweep simply skips snoozed rows (AR-5).

16. **Tests, fixtures, and operability.**
    Acceptance:
    - Unit tests for every pure function: `selectEligibleLoopsForNudge`, `enforceDailyCap`, `selectUsersForDigestHour`, `buildDigest`, `renderDigestEmail`, `parseApprovalCommand`, token mint/verify, `decideApproval` state machine.
    - Integration tests with the Inngest dev server: `email.received → ... → approval.requested → approval.received → executeApprovedDraft(test_action)` path; sweep cron → `loop.nudge_due` → send-nudge happy path; approval timeout path simulated by setting `expires_at` in the past and triggering a sweep (see Deliverable #17).
    - Dev `EmailSender` records outbound emails to an in-memory store the integration tests read.
    - All time-dependent code takes an injected clock — mirror `parseLoopReplyCommand`'s `now` parameter pattern across new modules (Risks #4).

17. **Approval expiry sweep.**
    Acceptance: `src/workflows/functions/sweep-approval-expiry.ts` runs `cron: */15 * * * *` and finds `approval_requests` with `status = 'pending' AND expires_at <= now()`. For each, calls `decideApproval(..., 'expired', 'cron')` and sends the user the expiry email. This is the failsafe complementing `waitForEvent`'s built-in timeout — the latter is per-run, and a workflow lost/replayed mid-flight should still expire correctly via the sweep.

## Data & Migrations

New migrations in `src/db/migrations/` (sequential numbers continuing the existing series):

1. **`0xxx_phase3_loop_nudge_bookkeeping.sql`** — `ALTER TABLE loops ADD COLUMN last_nudged_at timestamptz, ADD COLUMN nudge_count integer NOT NULL DEFAULT 0;` plus `CREATE INDEX loops_next_check_at_idx ON loops (status, next_check_at) WHERE status IN ('open','waiting_on_me','waiting_on_other','candidate');`.
2. **`0xxx_phase3_user_digest_prefs.sql`** — `ALTER TABLE users ADD COLUMN timezone text NOT NULL DEFAULT 'UTC', ADD COLUMN digest_enabled boolean NOT NULL DEFAULT true, ADD COLUMN digest_send_hour integer NOT NULL DEFAULT 8;` plus `CREATE INDEX users_digest_send_hour_idx ON users (digest_send_hour) WHERE digest_enabled;`.
3. **`0xxx_phase3_approval_tables.sql`** — `CREATE TYPE approval_status AS ENUM (...);` + `CREATE TABLE drafts (...);` + `CREATE TABLE approval_requests (...);` + indexes per Deliverable #3.
4. **`0xxx_phase3_audit_actions.sql`** — `ALTER TYPE audit_action ADD VALUE 'nudge.sent';` (repeated per value). Use one migration per `ADD VALUE` if running inside a transaction; Postgres restricts `ALTER TYPE ... ADD VALUE` inside transactions in older versions — use raw, non-transactional migrations as needed (Drizzle supports `--no-transaction`-style raw SQL).
5. **`0xxx_phase3_loop_event_types.sql`** — `ALTER TYPE loop_event_type ADD VALUE 'nudged';` (and `'digest_summarized'` if Deliverable #5/8 emit one — recommend yes for traceability).
6. **`0xxx_phase3_nudge_types.sql`** — none needed structurally; `nudges.nudge_type` is `text`. Document allowed values `private_reply | nudge | digest | approval | expiry` in `src/nudges/types.ts`.

Notes:
- AR-6 lifecycle-only status enum is assumed already migrated in Phase 2.5. This phase does not touch `loop_status`.
- Phase 2.5 is expected to ensure `nudges.metadata` carries ordinal→loopId mappings (AR-3). This phase uses the same shape for digests and approval emails.

## Events

All event shapes are declared in `src/workflows/events.ts` (typed map). Phase 3 adds:

- `loop.nudge_due` — `{ userId: string; loopId: string; reason: 'next_check_due' | 'candidate_re_ask' | 'stale_check'; scheduledFor: string }` (ISO timestamp). Emitted by sweep, consumed by `send-nudge`.
- `digest.daily_due` — `{ userId: string; localDateIso: string }`. Emitted by `sweep-digests`, consumed by `send-digest`.
- `digest.daily_requested` — `{ userId: string; inboundEmailId: string }`. Emitted when a user emails "what are my open loops?" / "insights" — consumed by `answer-question` handler (alternative: handler runs inline in `process-email` intent router; recommend emitting the event so the same downstream sender handles both cron and ad hoc requests).
- `approval.requested` — `{ approvalId: string; userId: string; draftId: string; actionKind: string; expiresAt: string }`. Emitted by `createApprovalRequest` callers, consumed by `handle-approval`.
- `approval.received` — `{ approvalId: string; userId: string; decision: 'approved' | 'rejected' | 'cancelled' | 'expired'; channel: 'email_reply' | 'web_link' | 'cron'; }`. Emitted by `decideApproval`. Matched by `step.waitForEvent` in `handle-approval` on `data.approvalId`.
- `report.requested` — `{ userId: string; kind: 'insights'; scope?: unknown; requestedVia: string; inboundEmailId?: string; nudgeId?: string }` (canonical shape owned by Phase 5). Stub only — recorded for Phase 5; this phase emits it from the question router with `kind: 'insights'` as the stub default and has no consumer beyond an audit log entry.

NOT added:
- `loop.nudge_scheduled` — under the cron sweep there is no individual schedule act; `loops.next_check_at` IS the schedule. Emitting a per-loop event on every loop-creation would inflate event volume without buying observability we don't already have via `loop.created` / `loop.updated`. The roadmap lists it; this plan deliberately omits it. Documented here so reviewers can challenge.

## Task Breakdown

Waves are independent and parallelizable. Tasks within a wave can be assigned to separate agents without coordination. Wave order matters: later waves depend on earlier-wave outputs.

### Wave A — Foundations (parallel)

**A1. Schema migrations and types.**
- Files: `src/db/schema.ts` (extend), `src/db/migrations/0xxx_phase3_*.sql` (six migration files per "Data & Migrations").
- Behavior: add columns/tables/enums. Export `Draft`, `ApprovalRequest`, `ApprovalStatus` types.
- Done when: `pnpm db:push` (or equivalent) succeeds locally, `pnpm typecheck` passes.

**A2. Typed event registry.**
- Files: `src/workflows/events.ts` (new), `src/workflows/client.ts` (extend with typed `inngest.send`).
- Behavior: declare the event-name→data-shape map listed in "Events" above. Provide `sendEvent<K extends keyof EventMap>(name, data)` helper.
- Done when: existing `process-email` send sites migrate to the typed helper (one mechanical refactor); typecheck passes.

**A3. Nudge policy constants and pure selectors.**
- Files: `src/nudges/policy.ts` (new), `src/nudges/selectors.ts` (new), `tests/nudges/selectors.test.ts` (new).
- Behavior: export `NUDGE_COOLDOWN_HOURS = 24`, `MAX_NUDGES_PER_USER_PER_DAY = 5`, `CANDIDATE_RE_ASK_AFTER_HOURS = 48`, `DEFAULT_NEXT_NUDGE_WINDOW_DAYS = 3`. Export pure functions `isEligibleForNudge(loop, { now, lastNudgedAt }): boolean`, `enforceDailyCap(loops, { sentTodayCount, cap }): { toNudge, toDefer }`, `advanceNextCheckAt(loop, now): Date`.
- Done when: unit tests cover all four functions across boundary cases.

**A4. Digest model and renderer.**
- Files: `src/digests/build.ts` (new), `src/digests/render.ts` (new), `tests/digests/build.test.ts` (new), `tests/digests/render.test.ts` (new).
- Behavior: `buildDigest({ user, loops, now })` → `DigestModel` per Deliverable #8. `renderDigestEmail(model, { ordinalStart = 1 })` → `{ subject, textBody, htmlBody, ordinalToLoopId: Record<number,string> }`.
- Done when: fixture-based snapshot tests pass for the roadmap UX sample and edge cases (no loops, only `recentlyDone`, all categories present).

**A5. Approval token mint/verify.**
- Files: `src/approvals/tokens.ts` (new), `tests/approvals/tokens.test.ts` (new).
- Behavior: `mintApprovalToken(): { token, hash }` (32-byte random base64url), `hashApprovalToken(token)`, `verifyApprovalToken(token, { storedHash, expiresAt, now })`.
- Done when: tests cover happy path, expired, mismatched hash.

**A6. Approval command parser.**
- Files: `src/approvals/commands.ts` (new), `tests/approvals/commands.test.ts` (new).
- Behavior: `parseApprovalReplyCommand(text, { now })` → `{ type: 'approve' | 'approve_all' | 'reject' | 'cancel' | 'edit' | 'unknown', loopOrdinal?, payloadText?, rawText }`.
- Done when: parsing tests pass for the canonical replies and known ambiguous cases.

**A7. Timezone helper.**
- Files: `src/users/timezone.ts` (new), `tests/users/timezone.test.ts` (new).
- Behavior: `localHourFor(userTimezone, now): number`, `startOfLocalDay(userTimezone, now): Date`, `usersDueAtHour(allUsers, now): User[]` (used by digest sweep). Use `Intl.DateTimeFormat` with the user's IANA tz (no extra deps) — verify on Node 20 / Vercel runtime.
- Done when: tests cover DST transitions for `America/Los_Angeles` and `Europe/London`, plus an unknown tz string falls back to `UTC`.

### Wave B — Service-layer wiring (depends on Wave A)

**B1. Approval service (createRequest, decide).**
- Files: `src/approvals/service.ts` (new), `src/approvals/repository.ts` (new), `tests/approvals/service.test.ts` (new).
- Behavior: per Deliverable #10. Emits `approval.requested` after insert. `decideApproval` is idempotent and emits `approval.received`.
- Done when: tests cover happy path, double-decide is a no-op, expired-on-mint rejection.

**B2. Execute-approved-draft + action registry.**
- Files: `src/approvals/execute.ts` (new), `src/approvals/actions/registry.ts` (new), `src/approvals/actions/test-action.ts` (new), `tests/approvals/execute.test.ts` (new).
- Behavior: per Deliverable #14. `test_action` is a no-op handler that returns `{ ok: true }`, used by tests and by Phase 4 as the plug-in shape reference.
- Done when: unknown `action_kind` writes the failure audit row and surfaces a user-visible error email; `test_action` succeeds.

**B3. Policy gate evolution.**
- Files: `src/policy/actions.ts` (edit), `tests/policy/actions.test.ts` (new or extend existing).
- Behavior: add `authorize(action, context)` returning `{ result, reason? }`. `assertApprovalAllowed` keeps current external interface for one phase, internally delegates to `authorize`.
- Done when: existing tests still pass; new tests cover `allowed` (private action), `needs_approval` (external, no `context.approval`), `allowed` (external, `context.approval.status === 'approved'`).

**B4. Nudge repository.**
- Files: `src/nudges/repository.ts` (new), `tests/nudges/repository.test.ts` (new, hits local Postgres).
- Behavior: `findEligibleLoopIdsForUser(userId, now)`, `countNudgesSentInLocalDay(userId, now, tz)`, `markLoopNudged(loopId, nextCheckAt, now)`, `createNudgeRow({ userId, loopId, body, subject, ordinalMap, type })`. Pure SQL via Drizzle; no business logic.
- Done when: DB tests verify the SQL against the new index.

**B5. Digest repository.**
- Files: `src/digests/repository.ts` (new), `tests/digests/repository.test.ts` (new).
- Behavior: `findUsersDueForDigest(now)` (joins `usersDueAtHour` semantics in SQL), `findLoopsForDigest(userId, now)`, `hasRecentDigest(userId, now)` (≤23h check).
- Done when: DB tests cover at-hour selection and the recency guard.

### Wave C — Inngest functions (depends on Waves A and B)

**C1. Nudge sweep cron.**
- File: `src/workflows/functions/sweep-nudges.ts` (new).
- Behavior: `*/10 * * * *`. Pulls eligible loop IDs grouped by user, applies daily cap, batches `step.sendEvent` of `loop.nudge_due`. Defers any loops over the cap by updating their `next_check_at` to tomorrow at the user's local 9 AM.
- Done when: function registers with Inngest dev server; integration test asserts events emitted for fixture loops.

**C2. Send nudge handler.**
- File: `src/workflows/functions/send-nudge.ts` (new).
- Behavior: per Deliverable #5. Re-validates eligibility inside the function (the eligibility check is the unit of correctness — sweep is a hint).
- Done when: integration test sends through the dev `EmailSender` and asserts the recorded outbound has the right `Reply-To`, the loop has `last_nudged_at` set, and `loop_events` has a `nudged` row.

**C3. Digest sweep cron.**
- File: `src/workflows/functions/sweep-digests.ts` (new).
- Behavior: `0 * * * *`. Emits `digest.daily_due` for users whose local hour matches.
- Done when: DB-driven integration test moves a fixture user's tz through 24 hours and asserts exactly one emission per day.

**C4. Send digest handler.**
- File: `src/workflows/functions/send-digest.ts` (new).
- Behavior: builds digest, sends, persists `nudges` row with ordinal map and `nudge_type='digest'`.
- Done when: integration test asserts ordinal-to-loopId mapping persisted and email body renders.

**C5. Approval workflow with waitForEvent.**
- File: `src/workflows/functions/handle-approval.ts` (new).
- Behavior: per Deliverable #11.
- Done when: integration test exercises approval → received path AND timeout path (use Inngest's test harness clock advancement OR simulate by emitting `approval.received` with `decision: 'expired'`).

**C6. Approval expiry sweep.**
- File: `src/workflows/functions/sweep-approval-expiry.ts` (new).
- Behavior: per Deliverable #17.
- Done when: integration test creates a pending request with `expires_at` in the past, runs the sweep, asserts row is `expired` and audit row is written.

**C7. Intent router branches for question + approval reply.**
- Files: `src/workflows/functions/process-email.ts` (extend), `src/workflows/functions/handlers/answer-question.ts` (new), `src/workflows/functions/handlers/handle-approval-reply.ts` (new).
- Behavior: per Deliverables #9 and #13. The router resolves the inbound's `MailboxHash` to the original nudge (per Phase 2.5 ground truth); if `nudge_type === 'approval'`, route to approval reply handler; if the body matches the question patterns, route to `answer-question`.
- Done when: integration tests cover both branches end-to-end against the dev sender.

### Wave D — App surface (depends on Wave B; can run alongside Wave C)

**D1. Approval decision pages and route.**
- Files: `app/approvals/[id]/page.tsx` (new), `app/approvals/[id]/decide/route.ts` (new), `src/approvals/links.ts` (new — URL builders).
- Behavior: per Deliverable #12. Non-sensitive approvals accept the token only; sensitive (`draft.requires_login = true`) requires Clerk session.
- Done when: manual click-through works locally; an automated test renders the page server-side and posts to the route.

**D2. User settings — digest preferences.**
- Files: `app/settings/page.tsx` (edit), `app/settings/digest/route.ts` (new) OR a server action.
- Behavior: form with `digest_enabled`, `digest_send_hour`, `timezone` (default-detected from browser via a hidden input set via `Intl.DateTimeFormat().resolvedOptions().timeZone`).
- Done when: changes persist and re-rendering the page reflects them.

### Wave E — Integration tests and operability (last)

**E1. End-to-end nudge cycle test.**
- File: `tests/integration/nudge-cycle.test.ts` (new).
- Behavior: seed a loop with `next_check_at` in the past, trigger `sweep-nudges`, assert outbound email and updated `last_nudged_at`.

**E2. End-to-end approval cycle test.**
- File: `tests/integration/approval-cycle.test.ts` (new).
- Behavior: create `test_action` draft + approval, trigger `handle-approval`, send `approval.received` with `approved`, assert `executeApprovedDraft` ran (audit row + handler return value).

**E3. End-to-end digest test.**
- File: `tests/integration/digest-cycle.test.ts` (new).
- Behavior: seed users in three timezones with various send hours, simulate "now" across 24 hours, assert exactly-one-per-day per user.

**E4. Operability runbook (no new file required).**
- Add to existing `docs/phases/README.md` or a fresh `docs/operability.md` (only if user later asks). For Phase 3 scope, ensure that:
  - Each cron function logs the count of rows processed.
  - Each send-* function tags audit log entries with `inngestRunId` for tracing.

## Testing

- **Pure-function unit tests** (Vitest, no DB) for `src/nudges/policy.ts`, `src/nudges/selectors.ts`, `src/digests/build.ts`, `src/digests/render.ts`, `src/approvals/tokens.ts`, `src/approvals/commands.ts`, `src/users/timezone.ts`, `src/policy/actions.ts`.
- **Clock injection.** Every time-dependent function takes a `now: Date` argument. Mirror the existing pattern in `src/loops/commands.ts` (`parseLoopReplyCommand(text, { now })`). Higher-level Inngest functions read `now` from a single `clock()` helper that production sets to `new Date()` and tests override.
- **Repository tests** against the local Postgres on `localhost:55433`. Fixtures: seed two users in `America/Los_Angeles` and `Europe/London`, several loops with varied statuses / due dates / `last_nudged_at`. Tests assert SQL correctness and index usage where relevant.
- **Inngest integration tests.** Run against the local Inngest dev server. Exercise:
  - sweep → emit → consume happy paths,
  - cooldown skip,
  - daily cap deferral,
  - approval `approved` and `rejected` reply paths,
  - approval expiry via cron (Deliverable #17),
  - approval expiry via `waitForEvent` timeout — for test speed, parameterize timeout in the function (`process.env.APPROVAL_TIMEOUT_OVERRIDE`) or use Inngest's test utilities to fast-forward time.
- **Snapshot tests** on rendered email bodies (digest, nudge, approval) — small fixtures, allow easy review when copy changes.
- **`pnpm typecheck && pnpm test && pnpm build` green on `main`** is the merge gate.

## Risks & Open Questions

1. **`loop.nudge_scheduled` event.** Roadmap lists it; this plan omits it under the cron sweep model. **Default:** omit. **Why:** `loops.next_check_at` IS the schedule; there is no per-loop scheduling act under AR-5. If observability needs a "scheduled" signal, we already emit `loop.created`/`loop.updated` with `next_check_at` in payload — extend those instead of adding a third event.
2. **Token shape: random vs HMAC.** **Default:** random base64url with SHA-256 stored hash. **Why:** simpler to revoke (delete row), no signing key rotation, leaked token blast radius is one approval. HMAC would let us avoid a row lookup, but the row lookup is cheap and we need row state anyway. Reversible at low cost in Phase 4 if connector volume demands it.
3. **Digest idempotency: unique partial index or in-function recency check?** **Default:** in-function recency check ("no digest sent in last 23h") for V0 simplicity. **Upgrade path:** if we ever see double-sends, add a partial unique index on `(user_id, nudge_type, date_trunc('day', sent_at at time zone <user_tz>))`. Document this as a follow-up in Phase 6 hardening if it bites.
4. **Cooldown values are guesses (24h, 5/day, 48h candidate re-ask, 3-day default window).** Roadmap says "keep stale-loop nudges conservative" but gives no numbers. **Default:** the constants in `src/nudges/policy.ts`. **Why these:** founder ICP is in-meeting all day; daily nudges feel noisy; 24h cooldown + 5/day cap means a heavy-state user gets at most a digest + 5 nudges = 6 outbound emails/day. Tune in Phase 6 against real fixtures.
5. **Approval timeout = 7d.** Roadmap doesn't say; matches the `step.waitForEvent` example in the prompt. Reasonable for V0; revisit if pilots complain.
6. **Sensitive-source-evidence gating.** Roadmap default says approval links for sensitive source require Clerk login. **Default:** introduce `drafts.requires_login boolean default false`; Phase 3's `test_action` sets it `false`; Phase 4 connectors that reveal source set it `true`. NOTE: this column needs to be in the `drafts` migration — adding to Deliverable #3 implicitly (`requires_login boolean not null default false`).
7. **Timezone capture timing.** Clerk doesn't expose timezone directly. **Default:** capture it in settings (Deliverable D2) via the browser, defaulting to `UTC` until set. Users who never visit settings stay on UTC — acceptable for alpha since pilots will be onboarded in-person.
8. **`questions` route in router.** Phase 2.5 has the router. This phase fills the `question` branch with a digest-style answer. If the router is not yet flexible enough, a small refactor lands in Wave C task C7.
9. **Conflict with roadmap Phase 3 build scope:** roadmap says "Schedule reminders with `step.sleepUntil`." AR-5 supersedes this. The plan follows AR-5 (README says "When a phase plan and the roadmap disagree on implementation detail, the phase plan wins"). Flagged here so reviewers see the explicit override.
10. **Conflict with roadmap status enum:** roadmap "Core status values" still lists `due_soon` and `overdue`. AR-6 removes them. Phase 2.5 owns the enum migration; this plan derives those views in digest categorization (Deliverable #8) and never references them as stored values.
11. **`generated_reports` table.** Roadmap lists it under Phase 3 data model. **Default:** defer to Phase 5. This phase only stubs `report.requested` to record demand. Documented in "Out of Scope".
12. **`step.sleepUntil` audit.** AR-5 forbids per-loop `step.sleepUntil`. Quick grep in execution: no current usage in the codebase (Phase 2 doesn't use it). Plan keeps it that way — sweeps + `waitForEvent` only.

## Out of Scope

- Slack and Calendar connector execution. `test_action` is the only registered action.
- Generated insight views (Phase 5). `report.requested` is emitted but has no consumer page.
- Eval suite and observability dashboards (Phase 6).
- Team sharing / workspace model (Phase 7).
- A persistent dashboard UI. Settings + approval pages are the only new app surface in Phase 3.
- Standing grants (Phase 4+). The `authorize()` shape allows them; nothing in Phase 3 issues or accepts them.
- Mobile-specific approval UI. The approval page is responsive but not native.
- Per-loop user-configurable nudge cadence. Single global constants in `src/nudges/policy.ts`.

## Exit Criteria

Phase 3 is done when ALL of the following are true:

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` pass on `main`.
- [ ] All six Phase 3 migrations have been applied locally and verified by inspecting the schema.
- [ ] `last_nudged_at`, `nudge_count` are on `loops`; `timezone`, `digest_enabled`, `digest_send_hour` are on `users`; `drafts` and `approval_requests` tables exist with the documented columns and indexes.
- [ ] `src/nudges/policy.ts` constants are the only knobs for nudge cadence/cap; changing one constant and re-running tests is enough to retune.
- [ ] A loop with `next_check_at` in the past triggers a private email through the dev `EmailSender` after one sweep run, sets `last_nudged_at`, increments `nudge_count`, advances `next_check_at`, writes a `loop_events` `nudged` row.
- [ ] Snoozing via reply ("snooze 1 until Monday") on a digest sets `loops.status = 'snoozed'` and `loops.next_check_at` to the correct user-local Monday 9 AM, AND the next sweep skips that loop.
- [ ] A user with `digest_enabled = true` and `digest_send_hour = 8` in `America/Los_Angeles` receives exactly one digest per day at their local 8 AM, with categories rendered per Deliverable #8 and ordinal→loopId metadata persisted on the digest `nudges` row.
- [ ] Replying "insights" or "what are my open loops?" sends back a digest-style email; this works on a fresh inbound (no prior nudge to map against — answer is generated from current state and stored as a new digest-style `nudges` row).
- [ ] Creating an approval request for `test_action` sends an approval email; clicking the approve link calls `executeApprovedDraft`, which records `audit_log.approval.executed`.
- [ ] Replying "approve" to that approval email reaches the intent router's `approval` branch and decides the approval correctly via the nudge metadata (AR-3); replying "reject" rejects; replying "edit: <text>" records the edit text without executing.
- [ ] The approval `waitForEvent` timeout path expires an approval after the configured TTL AND the standalone expiry sweep also expires any pending approval whose `expires_at` has passed.
- [ ] `src/policy/actions.ts` exports `authorize(action, context)` returning `allowed | needs_approval | denied`; `assertApprovalAllowed` still works for existing callers.
- [ ] No `step.sleepUntil` exists anywhere in `src/workflows/`.
- [ ] All cron functions register against the Inngest dev server and run on their schedules locally.
- [ ] Integration tests E1, E2, E3 pass.
- [ ] The plan's recommended defaults are recorded as constants/migrations (not loose magic numbers).
