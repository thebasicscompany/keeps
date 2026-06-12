# Phase 6: Reliability, Evaluation, And Trust Hardening

Status: planned
Depends on: 3 (5 ideally; some deliverables can start after 2.5/2.6)
Roadmap reference: `docs/roadmap.md` → "Phase 6: Reliability, Evaluation, And Trust Hardening"

## Goal

When Phase 6 is done, Keeps is dependable enough to invite the first 5–10 pilot users onto real work email without manual babysitting. Extraction quality is measurable on a versioned fixture suite that runs in CI on every PR (deterministic fallback) and on demand with a live model. Application errors, model calls, Inngest workflow failures, and Postmark deliverability problems surface in a single observability surface within minutes. Users can see the data Keeps holds about them, export it as JSON, delete individual source emails (and everything derived from them), delete their account entirely, and trust that raw email bodies older than the retention window (default 30 days in alpha) have actually been scrubbed from the database while their derived loops and source quotes remain intact. Inbound webhook replays, Inngest function retries, nudge sends, and connector actions are all idempotent, and the small number of inbound emails that fail processing land in a visible review queue that can be replayed manually.

## Why Now

Phases 2.5 through 5 turn Keeps into a real product. Phase 6 is what makes it a product real people can trust. We deliberately schedule it after Phase 3 (so we have nudges, drafts, and approvals to instrument and govern) and ideally after Phase 5 (so generated views are part of the deletion/export contract). It still precedes Phase 7 (team) and Phase 8 (pilot packaging) because we will not invite pilots before:

- precision can be tracked across releases,
- a user can delete an email they regret sending Keeps,
- a Postmark outage or bad model response does not produce a silent dropped loop.

Several deliverables also unblock earlier phases. The eval suite and the retention purge cron need only Phase 2.5 (a single Inngest path with idempotency) — Wave A below can start in parallel with Phase 3. Postmark deliverability webhook handling needs Phase 2.6 (live Postmark) but does not need Phase 3, Phase 4, or Phase 5.

## Preconditions

- Phase 2.5 is shipped: single Inngest processing path (AR-1), workflow idempotency on `inboundEmailId` (AR-4), lifecycle-only loop status enum (AR-6).
- Phase 2.6 is shipped: Clerk auth is the source of truth for users; live Postmark inbound and outbound are configured; the app is deployed on Vercel with Neon Postgres and Inngest Cloud.
- Phase 3 is shipped: nudges are sent through the outbound sender interface with a stable `nudgeId`; daily digest cron exists; approval requests use `step.waitForEvent`.
- Phase 4 is shipped (ideally; see Wave D notes): connector actions persist with an `idempotency_key` and emit `connector.action_failed` on failure.
- Phase 5 is shipped (ideally): `generated_reports` exists so deletion/export covers report records.
- `.env` has `OPENAI_API_KEY` available for the manual live-model eval mode. CI does NOT receive `OPENAI_API_KEY` per AR-8.
- A Sentry project has been created (or whatever equivalent error tracker we land on); DSN is available as a Vercel env var.

## Deliverables

Each deliverable is numbered. The Task Breakdown later maps tasks to these numbers.

### 1. File-based fixture eval suite with CI runner and live-model runner

Acceptance criteria:

- `src/agent/eval/cases/` contains at least 25 versioned `.case.ts` (or `.case.json`) fixtures: at least 10 synthetic (covering each `loopKind`, each `basis`, missing/relative/absolute due dates, the empty-body case, the low-confidence keep-from-slipping case, a `command` reply, an `approval` reply, a `correction` reply, a `question`) and at least 15 anonymized real examples seeded from Arav's own pilot inbox (PII scrubbed by a documented procedure in `src/agent/eval/README.md`).
- Each case carries: a `NormalizedEmail` payload (the same shape `launchThreadFixture` uses), a `label` object with expected `intent`, an array of expected loops where each expected loop has `summary` (string), `kind`, `ownerText`, `requesterText`, `dueDateText` (or `null`), `confidenceBand` (`low | medium | high`), and an `expectsClarifyingQuestion` boolean.
- `pnpm eval` runs a CLI (`src/agent/eval/cli.ts`) that loads every case, runs `extractLoops` in `deterministic` mode (default) or `model` mode (with `--model`), scores per case, and prints a report.
- The default `deterministic` mode runs in CI on every PR (`.github/workflows/eval.yml`) and fails the build if precision or recall on the deterministic-stable subset drops below a committed baseline (initial baseline: 0.7 precision, 0.6 recall on the synthetic subset; real-case subset is reported but not gating in v1).
- The `--model` mode is gated by `OPENAI_API_KEY` and is invoked manually (or by a separate scheduled job) — never in PR CI.
- A run history table (`eval_runs`) stores a row per CLI invocation with `id`, `mode`, `gitSha`, `modelId`, `caseCount`, `precision`, `recall`, `lowConfidenceHandlingRate`, `falsePositiveRate`, `summary` (jsonb of per-case results), `createdAt`. There is also `eval_cases_pending_label` (small, optional) for the human-review backlog of real emails awaiting labeling — see Risks.
- The runner self-test (`src/agent/eval/cli.test.ts`) runs at least one case end-to-end and asserts the scorer returns the expected precision/recall for a hand-crafted (matching loop set, label set) pair.

Justification — file-based fixtures + DB run history (not full DB-stored cases): Cases live in `src/agent/eval/cases/` because the extractor is the artifact under test, fixtures must be reviewable in PRs, and a developer must be able to add a regression case in the same commit as the fix. Storing cases in Postgres would couple the eval to a running database, fight version control (git is the right reviewer for prompt/label drift), and complicate CI (CI would need a DB seed). However, run *history* is volume-bearing data that we want to query over time without bloating the repo (model latency, token usage per run, precision over a month) — so `eval_runs` is a DB table. `eval_cases` as a Postgres table is reserved for the small set of pilot-submitted candidate cases awaiting human labeling.

### 2. Loop matcher for fuzzy scoring

Acceptance criteria:

- `src/agent/eval/matcher.ts` exports `matchLoops(predicted: LoopCandidate[], expected: ExpectedLoop[]): MatchResult` that returns per-expected-loop best match, per-predicted-loop spurious flag, precision, recall, and F1.
- The matcher v1 is a normalized-token-overlap matcher: lowercase, strip punctuation, drop stop words from a small list, compute Jaccard similarity on the resulting token set. A predicted loop matches an expected loop when (a) Jaccard ≥ 0.5 on summaries, and (b) `kind` matches OR is one of an allowed substitute set (`ask`↔`commitment` for ownership flips). Confidence band is checked separately (predicted `confidence` mapped to `low<0.5`, `medium<0.7`, `high≥0.7`).
- The model-graded option is *designed but deferred*. The matcher exports a `gradedMatchLoops` stub that throws "not implemented in v1" and a `// TODO Phase 6.1: model-graded matcher with rubric` comment with the rubric draft. Recommended v1 choice: normalized token overlap — deterministic, runs in CI without credentials, fast enough for the whole suite to finish in under 5 seconds, and good enough for catching regressions while we are still pre-pilot.
- The matcher is unit-tested with at least the cases: identical summary (match), reordered tokens (match), synonymous-but-different tokens (no match — acknowledged limitation), summary plus extra context (match), wrong owner (no match), correct loop but missing kind override (no match).

### 3. Eval metrics beyond extraction

Acceptance criteria:

- `low_confidence_handling_rate` = of cases where every predicted loop is `confidence < 0.7`, what fraction had a non-null `clarifyingQuestion`. Computed by the CLI and stored in `eval_runs.summary`.
- `false_positive_nudge_rate` is instrumented from *production* nudges (not fixtures): a daily Inngest cron (`scoreNudgeFeedback`) queries nudges sent in the last 7 days, joins to `loop_events` of type `dismissed`, and computes the ratio for nudges where the user dismissed the loop within 24 hours of the nudge being sent. Stored in a tiny `quality_metrics_daily` table (date, metric, value, denominator). Surfaced on an internal `/admin/quality` page (Clerk-protected, admin-only flag).
- `draft_approval_edit_rate` is instrumented from Phase 3/4 data: a similar cron computes `approved / (approved + rejected + edited)` and `edited / (approved + edited)` from `approval_requests` and `drafts`. Stored in `quality_metrics_daily`.
- `extraction_precision` and `extraction_recall` come from the eval suite and are stored both per-run in `eval_runs` and, for the latest CI run on `main`, mirrored into `quality_metrics_daily` so the dashboard plots one consistent series.

### 4. Error monitoring (Sentry) for app and Inngest functions

Acceptance criteria:

- Sentry initialized in `instrumentation.ts` (Next.js 16 server hook) and `instrumentation-client.ts` for the small client surface.
- Inngest functions wrap their handler with a `withInngestSentry()` helper in `src/observability/inngest-sentry.ts` so step failures and uncaught errors are captured with the function id, step id, and `event.id` as tags.
- Webhook routes (`/api/email/inbound`, `/api/postmark/webhook`, `/api/clerk/webhook` if present) tag the Sentry scope with `provider` and `webhook` so errors are filterable.
- A Sentry alert is configured (in code review, with a screenshot in the PR) for `level:error AND tags.function:process-email` over a 15-minute window.
- PII scrubbing rule is documented: `beforeSend` strips `event.extra.email.textBody`, `event.extra.email.htmlBody`, `event.extra.email.rawPayload`, and any field path matching `*.email` keeps domain but redacts local-part if `KEEPS_SENTRY_REDACT_EMAILS=1`.

### 5. Model call logs with redaction defaults

Acceptance criteria:

- New table `model_calls` (see Data & Migrations): one row per `generateObject` call, recording `id`, `userId` (nullable), `inboundEmailId` (nullable), `purpose` (`extract_loops | classify_intent | draft_nudge | draft_slack | draft_calendar | summarize_report`), `modelId`, `latencyMs`, `inputTokens`, `outputTokens`, `structuredOutput` (jsonb), `promptPreview` (text — first 200 chars only, default null), `errorMessage`, `createdAt`.
- The model wrapper (`src/agent/model.ts` extension or new `src/agent/instrumented-generate-object.ts`) is the only caller of `generateObject`; it records to `model_calls` after every call.
- Default: `promptPreview` is `null`. A locked config (`KEEPS_MODEL_LOG_PROMPT_PREVIEW=1`, off by default, requires manual flip in production env) enables the 200-char preview for debugging. The full prompt is never persisted.
- `structuredOutput` is always persisted (it is already shown in the product as a loop). It is what users would see anyway.
- A `/admin/model-calls` Clerk-admin-only page lists recent model calls with filter by purpose and userId, for debugging. The page deliberately does not show `userId` of *other* users when accessed by a non-admin (admin flag required).

### 6. Email deliverability — Postmark webhooks for bounces and spam complaints

Acceptance criteria:

- `/api/postmark/webhook` accepts Bounce, SpamComplaint, and Delivery webhook payloads (Postmark's standard format), verified by the shared-secret header pattern already used for the inbound webhook (extend `KEEPS_INBOUND_WEBHOOK_SECRET` or add `KEEPS_POSTMARK_WEBHOOK_SECRET`).
- `users` gets a new column `outbound_email_state` enum (`active | bounced | complained | suppressed`) defaulting to `active`. A hard bounce or spam complaint sets the column to `bounced` or `complained` and inserts an `audit_log` row with action `email.outbound.suppressed`.
- The outbound sender (Phase 2.5 interface) consults `outbound_email_state` before sending and refuses to send (skips, logs to `nudges.status='skipped'` with `metadata.reason='user_suppressed'`) for non-`active` users.
- A Sentry breadcrumb (info-level) is left for every bounce/complaint event. A daily summary is emitted to `quality_metrics_daily` (`bounces_24h`, `complaints_24h`).
- An internal `/admin/deliverability` page lists currently suppressed users with a "manually reactivate" action that resets `outbound_email_state` to `active` and writes an audit row.

### 7. Trust controls — delete all data

Acceptance criteria:

- `/settings/privacy` page (Clerk-authenticated) has a "Delete all data" button. Clicking it opens a confirmation dialog that requires typing the user's verified email. On submit, the page POSTs to `/api/data/delete` which inserts a `data_deletion_requests` row (status `pending`) and emits `data.delete_requested`.
- A new Inngest function `process-data-deletion` consumes `data.delete_requested`. It is idempotent on `dataDeletionRequestId`. It performs the deletion inside a transaction:
  1. Delete the Clerk user via the Clerk Backend SDK (so the user cannot sign back in to a half-deleted account). On Clerk API failure, the row stays `pending` and the function retries with backoff.
  2. Delete the `users` row. The schema cascade in `src/db/schema.ts` already handles: `user_identities` (cascade), `email_threads` (cascade) → `inbound_emails` (cascade via thread) → `email_messages`, `source_evidence`, `loops`, `loop_events`, `nudges` (all cascade from `users` directly or transitively from `inbound_emails`). `pending_inbound_emails` does NOT reference a user — these rows for the user's email are explicitly purged by a query on `sender_email`.
  3. `audit_log.userId` is `onDelete: 'set null'` per current schema (verified). The function explicitly *deletes* the user's audit rows rather than orphaning them (this is a deliberate trust call — the user said "delete all data", and an orphaned audit trail keyed by a now-nonexistent user id has no operational value and would surprise a privacy-conscious user). Adjust the migration if we decide otherwise (see Risks).
  4. Delete `model_calls` rows for the user (column added below); `quality_metrics_daily` is aggregate-only and is not deleted.
  5. Insert one final audit row keyed by `userId = null` with action `user.deleted` and metadata `{ email_hash: sha256(email), dataDeletionRequestId }` — the hash retains the ability to answer "did this address ever delete?" without retaining the email.
  6. Update `data_deletion_requests.status = 'completed'`, set `completed_at`.
  7. Emit `data.delete_completed`.
- The page displays "Deletion in progress" until `data_deletion_requests.status = 'completed'`, then the Clerk session is force-invalidated and the user is redirected to the marketing page.

### 8. Trust controls — per-email deletion

Acceptance criteria:

- The settings page gets a new `/settings/data` route listing the user's inbound emails (paginated, newest first) with subject, sender, received-at, and a "Delete this email and everything derived from it" action.
- The action POSTs to `/api/data/delete-email` with `inboundEmailId`. The handler:
  1. Verifies ownership (the Clerk user id matches `inbound_emails.userId`).
  2. Deletes the `inbound_emails` row inside a transaction. The schema cascade already handles `email_messages` (cascade from `inbound_emails`), `source_evidence` (cascade), `loops` (cascade — verified `inboundEmailId` is `onDelete: 'cascade'`), `loop_events` (cascade from loop), `nudges` (nullable `loopId` and `inboundEmailId` both `set null` — these rows survive; the handler additionally hard-deletes any `nudge` whose only references were the deleted email so we do not leave orphan unsent reminders, by `DELETE FROM nudges WHERE inbound_email_id IS NULL AND loop_id IS NULL AND user_id = $1 AND created_at >= $2`).
  3. Writes an `audit_log` row with action `email.deleted_by_user` and metadata containing the provider message id and the count of cascade-deleted loops, source-evidence rows, and nudges.
- The action is irreversible. The UI says so. There is no soft-delete in v1 — the trust pitch is that "delete" means delete.

### 9. Trust controls — JSON data export

Acceptance criteria:

- `/settings/data/export` button POSTs to `/api/data/export`, which emits `data.export_requested`. An Inngest function `generate-data-export` produces a JSON file containing the user's `users` row (filtered to non-sensitive columns), `email_threads`, `inbound_emails` (raw payload included unless retention-scrubbed), `email_messages`, `source_evidence`, `loops`, `loop_events`, `nudges`, `approval_requests` (Phase 3), `drafts` (Phase 3/4), `connector_actions` (Phase 4 — *without* connector tokens), `generated_reports` (Phase 5).
- The file is written to a signed expiring S3-or-equivalent URL (or returned inline if small) and emailed to the user via the outbound sender with a one-time download link valid for 24 hours.
- The export schema is documented in `docs/data-export-schema.md` (created in this phase) so users know what they get.

### 10. Trust controls — raw email retention with scheduled scrub

Acceptance criteria:

- `users` gets a new column `raw_email_retention_days` integer, defaulting to 30. Settings UI has a "Raw email retention" select (`30`, `90`, `365`, `until I delete`) — internal representation: `30`, `90`, `365`, `null` for "until I delete". The "until I delete" option is a deliberate user choice that bypasses automatic scrub.
- A new Inngest cron `raw-email-retention-purge` runs daily at 03:00 UTC. For each user where `raw_email_retention_days IS NOT NULL`, it finds `inbound_emails` whose `created_at < now() - interval '<days> day'` AND whose `raw_payload` is not already null, and *scrubs* them by setting the following columns to empty/null:
  - `raw_payload = '{}'::jsonb`
  - `html_body = NULL`
  - `text_body = ''` — but only after copying the existing `source_evidence.quote` and `source_evidence.normalized_body` (already populated at extraction time, verified) so derived loops keep their citation.
  - `stripped_text_reply = NULL`
  - `attachment_metadata = '[]'::jsonb`
  - `headers = '{}'::jsonb`
  - `normalized_payload = jsonb_build_object('scrubbed', true, 'scrubbed_at', now())`
- A new column `inbound_emails.scrubbed_at timestamptz null` records when scrubbing happened.
- Critically, the cron does NOT delete the `inbound_emails` row itself — that would cascade-delete derived loops and source_evidence. The row stays so `loops.inbound_email_id` and `source_evidence.inbound_email_id` foreign keys remain valid. The user's loops still reference a (now contentless) source email with the source quote intact in `source_evidence`.
- `email_messages` rows for scrubbed inbound emails also have their bodies scrubbed via the same query (same retention horizon).
- A unit test (`src/workflows/functions/raw-email-retention-purge.test.ts`) uses an injectable clock (`now: () => Date`) and a small fixture set to assert: (a) emails younger than retention are untouched, (b) emails older than retention are scrubbed but loops/source_evidence rows remain, (c) repeated cron runs are idempotent (`scrubbed_at` is set, second pass skips rows with `scrubbed_at IS NOT NULL`), (d) "until I delete" users (`raw_email_retention_days IS NULL`) are never scrubbed.
- The settings UI shows a one-sentence explainer: "Raw emails are removed after N days. The loops we extracted, and the short quotes they cite, remain until you delete them."

### 11. Trust controls — audit log view in settings

Acceptance criteria:

- `/settings/audit` (Clerk-authenticated) lists the current user's audit rows (most recent 200), filtered by `audit_log.user_id = currentUser.id`, with columns: `createdAt`, `action`, summary of `metadata`.
- Sensitive actions (e.g. `email.inbound.received`) display subject and sender; they intentionally do not display body.
- A "Download all" link emits an export of all audit rows for the user as JSON (reuses the export pipeline).

### 12. Reliability — idempotency audit and gaps

Acceptance criteria:

- Inbound email idempotency: already enforced by `inbound_emails.providerMessageIdx` unique on (`provider`, `providerMessageId`) — verified in `src/db/schema.ts` line 188. State this explicitly in `docs/observability/idempotency.md` (new file) and add a regression test in `src/email/inbound.test.ts` that POSTs the same payload twice and asserts one row and one event.
- Workflow idempotency: Inngest `idempotency` keyed on `event.data.inboundEmailId` per AR-4 — verified done in Phase 2.5. State explicitly.
- Outbound nudge idempotency: each nudge has a stable `nudgeId` (uuid primary key). The outbound sender attaches `X-Keeps-Idempotency-Key: nudge-<nudgeId>` to the Postmark `Headers` and refuses to re-send if `nudges.status = 'sent'`. The "send nudge" Inngest function wraps the send in `step.run('send-nudge', ...)` so Inngest deduplicates the step on retry, and the sender code also defensively re-reads `nudges.status` inside the step.
- Connector action idempotency: Phase 4 introduces `connector_actions.idempotency_key`. State the contract here: every connector tool computes a deterministic key (e.g. `slack:dm:<userId>:<draftId>` or `calendar:event:<draftId>`) and the action handler refuses to re-execute if a row with the same key and `status='completed'` already exists. Add a regression test.
- Postmark inbound webhook replay tolerance: Postmark may retry the inbound webhook on non-2xx response. The unique index on `(provider, providerMessageId)` handles this — verified. State explicitly and assert with a test.

### 13. Reliability — retry policies per Inngest function

Acceptance criteria:

- `src/workflows/functions/process-email.ts`: `retries: 3`, exponential backoff (Inngest default). On final failure, emit `email.processing_failed` (see Events) and write to `failed_processing` queue.
- `src/workflows/functions/send-nudge.ts` (Phase 3): `retries: 5`, exponential backoff. On final failure, mark `nudges.status='failed'` (new enum value, see Data & Migrations) and emit `nudge.failed` (added to event taxonomy as well — see Events).
- `src/workflows/functions/execute-connector-action.ts` (Phase 4): `retries: 3`, exponential backoff. Emit `connector.action_failed` on final failure (already in roadmap).
- `src/workflows/functions/generate-data-export.ts` (this phase): `retries: 2`.
- `src/workflows/functions/process-data-deletion.ts` (this phase): `retries: 5` because Clerk API hiccups must not block deletion forever — but with each retry, the deletion row keeps `status='pending'` so the user sees progress.
- `src/workflows/functions/raw-email-retention-purge.ts`: cron, `retries: 1` (idempotent — re-running is safe).

### 14. Reliability — dead-letter / failed processing queue

Acceptance criteria:

- New table `failed_processing` (see Data & Migrations) records: `id`, `inboundEmailId` (nullable — failure may pre-date persistence), `eventName`, `eventPayload` (jsonb), `errorMessage`, `errorStack`, `failedAt`, `replayedAt` (nullable), `resolvedAt` (nullable), `notes`.
- `process-email` failure handler inserts a row into `failed_processing` AND emits `email.processing_failed`. The same pattern is available for any other workflow (a shared helper `dead-letter.ts`).
- An internal `/admin/failed-processing` page (Clerk admin only) lists open rows (`resolvedAt IS NULL`) and offers two buttons per row:
  - "Replay" — re-emits the original event with the same `inboundEmailId`; Inngest idempotency (AR-4) ensures no double-create.
  - "Resolve" — sets `resolvedAt = now()` with a notes field.
- A CLI fallback (`pnpm replay-failed-processing --id <id>`) does the same for headless ops.

### 15. Connector action failure alerting

Acceptance criteria:

- An Inngest function `notify-connector-failure` listens for `connector.action_failed` (emitted by Phase 4) and:
  - Records a Sentry breadcrumb at error level (so the same Sentry dashboard surfaces it),
  - Increments `quality_metrics_daily.connector_failures_24h`,
  - If a user accumulates 3 connector failures in 1 hour, sends them a private email "Your Slack/Calendar connection seems to be having trouble — try reconnecting at /settings/connectors". Subject this through the outbound sender so the suppressed-user check from deliverable 6 applies.

## Data & Migrations

New tables:

- `eval_runs` — `id uuid pk`, `mode text not null` (`deterministic | model`), `git_sha text`, `model_id text`, `case_count int not null`, `precision real`, `recall real`, `low_confidence_handling_rate real`, `false_positive_rate real`, `summary jsonb not null`, `created_at timestamptz not null default now()`. Indexes: `(created_at desc)`, `(mode, created_at desc)`.
- `eval_cases` — small DB-backed table for *pilot-submitted candidate cases awaiting human labeling* (not the primary store of cases). `id`, `userId` (nullable — admin-created cases have null), `submittedAt`, `normalizedPayload jsonb`, `status text` (`pending_label | labeled | rejected`), `notes`. The actual labeled cases live in `src/agent/eval/cases/` as code.
- `model_calls` — see deliverable 5 for columns.
- `quality_metrics_daily` — `date date not null`, `metric text not null`, `value real not null`, `denominator real`, `metadata jsonb default '{}'`. PK `(date, metric)`.
- `data_deletion_requests` — `id uuid pk`, `userId uuid` (no FK so the row can outlive the user during the deletion window; or use `set null`), `email text not null` (stored before delete for audit), `status text not null` (`pending | in_progress | completed | failed`), `requestedAt`, `completedAt`, `failureMessage`. Index `(status, requestedAt)`.
- `failed_processing` — see deliverable 14 for columns.

Column additions:

- `users.outbound_email_state` enum (`active | bounced | complained | suppressed`) default `active`. New enum `outbound_email_state`.
- `users.raw_email_retention_days` integer null default 30.
- `inbound_emails.scrubbed_at` timestamptz null. Index `(scrubbed_at, created_at)` to support the daily cron's "find rows past retention not yet scrubbed" query.
- `email_messages.scrubbed_at` timestamptz null (same pattern).

Enum changes:

- Add to `nudge_status`: `failed`.
- Add to `audit_action`: `email.outbound.suppressed`, `email.deleted_by_user`, `data.export_requested`, `data.export_completed`, `data.delete_requested`, `data.delete_completed`, `user.deleted`, `failed_processing.replayed`.

Cascade behavior verified against `src/db/schema.ts`:

- `users` deletion cascades into: `user_identities`, `email_threads`, `inbound_emails`, `email_messages`, `source_evidence`, `loops`, `loop_events`, `nudges` (via `userId`). `audit_log.userId` is `set null` — handled explicitly during deletion (deliverable 7 step 3).
- `inbound_emails` deletion cascades into: `email_messages` (cascade), `source_evidence` (cascade), `loops` (cascade — `inboundEmailId` is `onDelete: 'cascade'`, verified line 305), `loop_events` (cascade from loop). `nudges.inboundEmailId` is `set null` — handled explicitly (deliverable 8 step 2).
- `pending_inbound_emails` has no user FK — held emails for a given sender email must be purged by `sender_email` query during account deletion.

## Events

New Inngest events:

- `eval.run_requested` — `{ mode: "deterministic" | "model", requestedByUserId?: string, caseSubset?: string[] }`. Triggers the eval runner as a background job (mostly useful for `--model` runs that take longer than a CLI session can hold). The CLI can be invoked directly without this event.
- `email.processing_failed` — `{ inboundEmailId?: string, eventName: string, eventPayload: object, errorMessage: string, errorStack?: string, failedAt: string }`. Emitted by `process-email` (and any other workflow via the dead-letter helper) on final retry failure. Subscribed by `record-failed-processing` (writes the `failed_processing` row).
- `connector.action_failed` — already in roadmap; Phase 4 emits, Phase 6 adds `notify-connector-failure` as an additional subscriber.
- `nudge.failed` — `{ nudgeId: string, userId: string, error: string }`. Emitted when `send-nudge` exhausts retries. Subscribed by Sentry breadcrumb logger and `quality_metrics_daily` aggregator.
- `data.delete_requested` — `{ dataDeletionRequestId: string, userId: string, email: string }`. Subscribed by `process-data-deletion`.
- `data.delete_completed` — `{ dataDeletionRequestId: string, userId: string, email: string }`. Subscribed by Sentry breadcrumb logger only.
- `data.export_requested` — `{ userId: string, requestedAt: string }`. Subscribed by `generate-data-export`.
- `data.export_completed` — `{ userId: string, downloadUrl: string, expiresAt: string }`. Subscribed by `send-export-email` (uses outbound sender).

## Task Breakdown

Tasks are grouped into waves. Tasks within a wave have no dependency on other tasks in the same wave and can be assigned to separate agents in parallel. A wave does not start until the previous wave is done.

### Wave A — can start as soon as Phase 2.5 is done (parallel to Phase 3 work)

These do not depend on Phase 3, 4, or 5. They unblock quality measurement and retention before the larger product features land.

**A1. Eval suite scaffolding and CLI runner.**
- Files: create `src/agent/eval/cli.ts`, `src/agent/eval/cli.test.ts`, `src/agent/eval/types.ts` (the `EvalCase`, `ExpectedLoop`, `MatchResult` types), `src/agent/eval/load-cases.ts`, `src/agent/eval/README.md` (PII scrubbing procedure for real emails).
- Add `eval` script to `package.json`: `"eval": "tsx src/agent/eval/cli.ts"`.
- The CLI accepts `--mode deterministic|model`, `--filter <case-id-prefix>`, `--out <path>`, `--update-baseline`, `--json`.
- Deliverable 1 acceptance criteria, but only the runner shell (matcher and cases come from A2/A3).

**A2. Matcher implementation.**
- Files: `src/agent/eval/matcher.ts`, `src/agent/eval/matcher.test.ts`.
- Implement normalized token Jaccard matcher per deliverable 2. Export `matchLoops`, the placeholder `gradedMatchLoops`, and an internal `tokenize` helper.
- Test all six listed cases.

**A3. Initial fixture set.**
- Files: `src/agent/eval/cases/synthetic-*.case.ts` (at least 10), `src/agent/eval/cases/real-*.case.ts` (at least 15 scrubbed from Arav's inbox).
- Each file exports `default const evalCase: EvalCase = { id, normalized, label }` using `NormalizedEmail` from `src/email/normalize.ts`.
- Reuse `launchThreadFixture` shape; do NOT modify the existing fixture file.

**A4. CI workflow.**
- File: `.github/workflows/eval.yml`. Runs `pnpm install`, `pnpm eval --mode deterministic`. Fails if exit code is non-zero (CLI exits 1 when precision/recall drops below the committed baseline in `src/agent/eval/baseline.json`).

**A5. Raw email retention purge cron.**
- Files: `src/workflows/functions/raw-email-retention-purge.ts`, `src/workflows/functions/raw-email-retention-purge.test.ts`.
- Add migration for `users.raw_email_retention_days`, `inbound_emails.scrubbed_at`, `email_messages.scrubbed_at`. File: `src/db/migrations/<next>-retention-columns.sql`.
- Implement the scrub SQL per deliverable 10 inside a `step.run('scrub-batch', ...)` for a batch of up to 1000 users at a time.
- Settings UI: extend the existing settings page with a "Raw email retention" select. File: `app/settings/page.tsx` (or the privacy sub-section once split out — see A6).

**A6. Settings split: `/settings/privacy`, `/settings/data`, `/settings/audit`.**
- Files: `app/settings/privacy/page.tsx`, `app/settings/data/page.tsx`, `app/settings/audit/page.tsx`, `app/settings/layout.tsx` (tab navigation).
- Wire the retention select from A5 into `/settings/privacy`. The deletion/export/audit pages stub-render in this task; their handlers land in Wave B/C.

**A7. Idempotency audit doc and regression tests.**
- File: `docs/observability/idempotency.md` (new), `src/email/inbound.test.ts` (extend with the double-POST regression test).
- State the four idempotency layers per deliverable 12 and link to the lines of code that enforce each.

### Wave B — requires Phase 3 (needs nudges, drafts, approvals)

**B1. Per-email deletion handler.**
- Files: `app/api/data/delete-email/route.ts`, `src/data/delete-email.ts` (the deletion service for testability), `src/data/delete-email.test.ts` (integration test against real Postgres).
- Implement deliverable 8. The settings UI stub in `/settings/data/page.tsx` (from A6) gets wired here.

**B2. Account-wide deletion pipeline.**
- Files: `app/api/data/delete/route.ts`, `src/workflows/functions/process-data-deletion.ts`, `src/workflows/functions/process-data-deletion.test.ts`, migration for `data_deletion_requests` table, additions to `audit_action` enum.
- Implement deliverable 7 including the Clerk Backend SDK call. Integration test must cover: cascade behavior, pending_inbound_emails purge by sender, audit_log explicit delete, idempotent retries.

**B3. JSON export pipeline.**
- Files: `app/api/data/export/route.ts`, `src/workflows/functions/generate-data-export.ts`, `src/workflows/functions/send-export-email.ts`, `docs/data-export-schema.md`.
- Implement deliverable 9.

**B4. Audit log view.**
- Files: `app/settings/audit/page.tsx` (fill in the stub from A6), `src/audit/list-for-user.ts`.
- Implement deliverable 11.

**B5. Outbound nudge idempotency.**
- File: edit `src/workflows/functions/send-nudge.ts` (created in Phase 3) and add `src/workflows/functions/send-nudge.idempotency.test.ts`.
- Implement deliverable 12's "outbound nudge" subsection.

**B6. False-positive nudge and draft-edit metrics cron.**
- Files: `src/workflows/functions/score-nudge-feedback.ts`, `src/workflows/functions/score-draft-feedback.ts`, migration for `quality_metrics_daily`.
- Implement the production-data side of deliverable 3.

### Wave C — requires Phase 2.6 (needs live Postmark)

**C1. Postmark deliverability webhook.**
- Files: `app/api/postmark/webhook/route.ts`, `src/email/deliverability.ts`, `src/email/deliverability.test.ts`, migration for `users.outbound_email_state` + new enum.
- Implement deliverable 6.

**C2. Outbound sender suppression check.**
- Files: edit the outbound sender interface (Phase 2.5) to consult `users.outbound_email_state` and to mark suppressed sends as `nudges.status='skipped'` with reason.
- Test must cover all four state values.

**C3. Sentry initialization.**
- Files: `instrumentation.ts`, `instrumentation-client.ts`, `src/observability/sentry.ts` (the `beforeSend` PII scrubber), `src/observability/inngest-sentry.ts`.
- Implement deliverable 4. Add `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `KEEPS_SENTRY_REDACT_EMAILS` to `src/config/env.ts`.

**C4. Model call logging wrapper.**
- Files: `src/agent/instrumented-generate-object.ts`, edit `src/agent/extract-loops.ts` and any other `generateObject` caller (Phase 3 nudge drafter, Phase 4 connector drafters, Phase 5 report summarizer) to route through the wrapper. Migration for `model_calls` table.
- `/admin/model-calls/page.tsx` and admin-flag check.
- Implement deliverable 5.

### Wave D — requires Phase 4 (needs connector action tables and events)

**D1. Connector failure alerting.**
- Files: `src/workflows/functions/notify-connector-failure.ts`.
- Implement deliverable 15.

**D2. Connector idempotency regression test.**
- File: extend Phase 4's connector action test file with the double-execute regression.
- State the contract from deliverable 12.

### Wave E — touches everything; lands last in the phase

**E1. Dead-letter queue and admin pages.**
- Files: migration for `failed_processing`, `src/workflows/dead-letter.ts` (shared helper), edit `src/workflows/functions/process-email.ts` to call the helper on final failure, `app/admin/failed-processing/page.tsx`, `app/api/admin/failed-processing/replay/route.ts`, CLI `scripts/replay-failed-processing.ts`.
- Implement deliverables 13 and 14.

**E2. Retry policy audit.**
- File: edit each Inngest function file to set explicit `retries` per deliverable 13. Adjust `nudge_status` enum migration to add `failed`. Edit `src/workflows/functions/send-nudge.ts` to handle final-failure transition.

**E3. Quality metrics dashboard.**
- Files: `app/admin/quality/page.tsx`, `src/admin/quality-metrics.ts`.
- Render the time series from `quality_metrics_daily` plus the latest `eval_runs` row on `main`.

**E4. Privacy copy refresh.**
- File: `app/(marketing)/privacy/page.tsx` (create or edit), edit `app/onboarding/page.tsx` to add a one-paragraph privacy promise referencing the retention default and delete/export capabilities. Confirm copy with Arav before shipping.

## Testing

Three categories of test that must exist by the end of Phase 6.

### Deletion-cascade integration tests against real Postgres

- Use the docker Postgres on 55433 (the existing local stack).
- Test files: `src/data/delete-email.test.ts`, `src/workflows/functions/process-data-deletion.test.ts`.
- Each test boots a fresh schema via the migration runner, seeds: 2 users, each with a thread containing 3 inbound emails, each with extracted loops, source evidence, loop events, nudges (pending and sent), approval requests, drafts, connector actions, generated reports.
- Assertions:
  - Per-email delete: only the targeted email and its descendants are gone; the other user is untouched; nudges that lost their only references are hard-deleted; audit row is present.
  - Account delete: every table the user touches is empty for that user id; `audit_log.user_deleted` row exists with no userId; the other user is untouched.
  - Idempotent replay: re-running `process-data-deletion` with the same `dataDeletionRequestId` does not error and does not double-emit `data.delete_completed`.

### Retention-scrub tests with injected clock

- Test file: `src/workflows/functions/raw-email-retention-purge.test.ts`.
- The function accepts `now: () => Date` so tests can advance time deterministically.
- Cases:
  - Email aged 29 days, retention 30 days → not scrubbed.
  - Email aged 31 days, retention 30 days → scrubbed; `loops` and `source_evidence` rows still readable; `source_evidence.quote` non-empty.
  - User with `raw_email_retention_days = null` ("until I delete") → no email ever scrubbed regardless of age.
  - Already-scrubbed row (with `scrubbed_at` set) → second pass does nothing (idempotent).
  - Mixed batch with 100 emails across 10 users → correct subset scrubbed.

### Eval runner self-test

- Test file: `src/agent/eval/cli.test.ts`.
- Builds an in-memory case set: one expected loop summary "Send the deck by Friday" and one predicted loop summary "Send the deck by Friday." with `kind: commitment`. Asserts precision = 1.0, recall = 1.0.
- Second case: predicted summary "Send a deck", expected "Send the deck by Friday" — asserts precision drops appropriately.
- Third case: empty predicted, non-empty expected — recall = 0, precision undefined (the matcher returns null and the report says "no predictions").
- Asserts the CLI exits 1 when below baseline.

### Existing test suite

- `src/agent/extract-loops.test.ts` continues to pass; deliverable 1 does not modify it.
- `pnpm typecheck`, `pnpm test`, `pnpm build` must remain green throughout the phase.

## Risks & Open Questions

1. **What raw email retention default for alpha?** Recommended default: **30 days** (per roadmap recommended defaults), with `until I delete` as an explicit user opt-out. This gives debugging headroom for the first month without surprising users who expect emails to disappear.
2. **Should audit log survive account deletion as orphaned rows?** Schema currently says `set null`, which would orphan. Recommended in deliverable 7: explicitly delete the user's audit rows on account-wide delete. The single retained `user.deleted` row with a hashed email lets us answer compliance questions ("did this address ever delete?") without retaining anything user-attributable. *Open*: do we want a separate `deletion_attestations` table for legal-style proof-of-deletion? Recommend deferring to Phase 8 (pilot packaging) unless a pilot demands it.
3. **Matcher v1 will under-credit synonyms.** "Confirm the discount cap" vs expected "Approve the discount cap" will score as a miss under token Jaccard. Recommended mitigation: when we observe more than ~5 false-negative matches in the real-case subset, flip to the deferred model-graded matcher with a frozen rubric. The rubric draft (already in the `gradedMatchLoops` TODO comment) is: "Score 1 if same actionable commitment; 0.5 if same topic but different ownership; 0 otherwise." Until then, the deterministic matcher gives a stable signal across releases, which is what we actually need for regression detection.
4. **Will users understand "raw email" vs "loops"?** Recommended: the settings UI copy literally explains both, with an inline example of what disappears (the original BCC'd email body) and what stays (the two-line loop summary and quote). If pilots are confused, we should consider renaming "raw email retention" to "original email retention" — defer that copy iteration to Wave E4.
5. **Sentry might capture model-output fragments that contain user content even with the scrubber.** Recommended: the `beforeSend` scrubber denylists a small set of known body field paths; in addition we add a Sentry "Data Scrubber" advanced rule for any string longer than 200 chars in `event.extra`. Pilot for one week before raising retention.
6. **Eval baseline drift.** The committed baseline starts loose (P=0.7, R=0.6). Each PR that legitimately improves quality should run `pnpm eval --update-baseline` and commit the new file. If a PR worsens quality knowingly (e.g. flipping a heuristic off), the developer must justify in the PR description. Recommend a CODEOWNERS rule for `src/agent/eval/baseline.json` so changes are reviewed.
7. **What's the minimum acceptable precision before adding more users?** Recommended threshold from the roadmap open question: **0.75 precision on the real-case subset, 0.85 on the synthetic subset, with low-confidence-handling-rate ≥ 0.6**, before we expand beyond the initial 5 design partners.
8. **Should users see confidence numerically?** Per locked recommended default in the roadmap: **no, plain language only** ("I am not sure I am reading this right"). Display the underlying number on the admin model-calls page (deliverable 5) for debugging.

## Out of Scope

- Enterprise compliance certifications (SOC 2, ISO, HIPAA, GDPR DPA templates). Phase 8 picks this up if a pilot demands it.
- Self-hosting / private-cloud deployment. Roadmap defers this until a pilot demands it.
- A formal admin console with role management. The `/admin/*` pages here are utilitarian and gated by a single `isAdmin` flag on `users`.
- Team-visible audit logs or shared deletion (we are single-user until Phase 7).
- Re-ingesting historical email after retention scrub. Once raw is gone it stays gone; users who want longer retention pick the right setting up front.
- Training detection / opt-out toggles for model providers. We already commit in product-contract to not training on customer content; we do not build extra plumbing in Phase 6.
- A formal labeled-eval-case ingestion UI for pilot users. The `eval_cases` table exists for the admin workflow only; a pilot-facing "flag this loop as wrong" path is a Phase 8 candidate.
- Synthetic prompt-injection / red-team test corpus. Worth doing, but lands after the basic eval harness has shipped — track as a follow-up.

## Exit Criteria

Phase 6 is done when every box below is true.

- [ ] `pnpm eval` runs locally in deterministic mode in under 10 seconds and prints precision, recall, low-confidence handling rate, and per-case detail.
- [ ] `pnpm eval --mode model` runs locally with `OPENAI_API_KEY` set and stores an `eval_runs` row.
- [ ] `.github/workflows/eval.yml` runs `pnpm eval` on every PR and fails the build below the committed baseline.
- [ ] At least 25 eval cases exist in `src/agent/eval/cases/`, with ≥10 synthetic and ≥15 anonymized real.
- [ ] Sentry captures errors from `process-email`, `send-nudge`, the inbound webhook, and the Postmark webhook with PII scrubbed.
- [ ] `model_calls` table records every `generateObject` invocation; `promptPreview` is null by default; `structuredOutput` is populated.
- [ ] Postmark Bounce and SpamComplaint webhooks reach `/api/postmark/webhook` and set `users.outbound_email_state` correctly; outbound sender refuses to send for non-`active` users.
- [ ] `/settings/privacy` exposes "Delete all data" with email-typing confirmation; the deletion pipeline removes the Clerk user, the `users` row, and all descendants per cascade; `audit_log` for that user is explicitly purged and a single `user.deleted` row remains with a hashed email; `data.delete_completed` event is emitted.
- [ ] `/settings/data` lists inbound emails; per-email deletion removes the email, source evidence, loops, loop events, and orphaned nudges.
- [ ] `/settings/data/export` produces a JSON file via signed link emailed to the user; schema documented in `docs/data-export-schema.md`.
- [ ] `/settings/privacy` exposes "Raw email retention" with values 30/90/365/until I delete; the daily cron scrubs `raw_payload`, `html_body`, `text_body`, `stripped_text_reply`, `headers`, `attachment_metadata`, `normalized_payload` for matching `inbound_emails` rows while preserving `source_evidence.quote` and `loops`.
- [ ] `/settings/audit` displays the user's audit rows.
- [ ] Idempotency is verified by regression tests at all four layers: inbound webhook, workflow, nudge send, connector action. The doc `docs/observability/idempotency.md` exists and is current.
- [ ] Every Inngest function has an explicit `retries` config per deliverable 13.
- [ ] `failed_processing` rows are created on final retry failure; `/admin/failed-processing` displays them; "Replay" re-emits the event with idempotency intact.
- [ ] `connector.action_failed` triggers Sentry breadcrumb, a row in `quality_metrics_daily`, and the user-facing reconnect email after 3 failures in 1 hour.
- [ ] `quality_metrics_daily` has at least one row per metric per the last 7 days in production; `/admin/quality` renders the time series and the latest CI eval result.
- [ ] All new tables and column additions have migrations in `src/db/migrations/`.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` are green.
- [ ] Privacy copy on the onboarding page and a `/privacy` page reflects the retention default and the delete/export capabilities.
