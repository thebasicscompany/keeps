# Phase 5: Generated Insight Views

Status: done
Depends on: 3
Roadmap reference: `docs/roadmap.md` — "Phase 5: Generated Insight Views"

## Goal

A user can email Keeps a natural-language insight command ("what are my insights?", "what am I waiting on?", "what is stale?", "weekly summary", "show Acme loops") and Keeps replies privately with a short ranked summary plus a signed expiring link to a memo-style report page. The report page is mobile-friendly, server-rendered, groups loops (waiting on me, waiting on others, due soon, overdue, stale, recently done) with `due_soon` / `overdue` derived from `due_at` per AR-6, surfaces source-evidence chips, and exposes per-row actions (done / dismiss / snooze / draft nudge) that mutate state through the same service layer email reply commands already use — guaranteeing identical state transitions and identical `loop.updated` events. Report links expire after 7 days; sensitive source-evidence inspection requires a Clerk session; ranking and inclusion are deterministic, and only the human-facing summary text is model-authored.

## Why Now

Phase 3 introduced nudges, daily digests, the approval-link primitive (signed expiring URLs), and the first `report.requested` event scaffolding. With nudges flowing and approval-link infrastructure already proven, this phase upgrades reports from "scaffolded event" to a real product surface — without forcing users to learn or revisit a dashboard. Doing this before Phase 6 also lets the reliability/eval phase observe whether generated views are actually used or just demoed, which feeds the "Generated Views Become A Dashboard By Accident" risk in the roadmap.

## Preconditions

- Phase 2.5 intent router (`process-email` classifies `capture | command | approval | question | correction`) is live; we add a new `insight` command sub-type that flows through the same router (AR-2).
- Phase 2.6 Clerk auth is live; the report page can detect a logged-in session and gate sensitive source-evidence display on it.
- Phase 3 outbound sender, threading headers, and signed-link primitive (used for approval URLs) are in place and reusable.
- Loop lifecycle-only status enum from AR-6 is migrated: stored statuses are `candidate, open, waiting_on_me, waiting_on_other, blocked, snoozed, done, dismissed`. `due_soon` / `overdue` are computed at query time.
- `src/loops/service.ts` exposes `applyLoopReplyCommand` (already in repo) as the canonical mutation entry point for email-driven loop state changes.

## Deliverables

1. **`generated_reports` table + signed expiring URL system.**
   - New Drizzle table with: `id (uuid pk)`, `user_id`, `kind enum (insights | waiting_on | stale | weekly | entity)`, `scope jsonb` (e.g. `{}` or `{"entity":"Acme"}` or `{"daysStale":14}`), `summary text` (the model-authored short summary), `token_hash text` (sha256 of the URL token; raw token never stored), `expires_at timestamptz` (default `now() + interval '7 days'`), `created_at`, `last_viewed_at timestamptz`, `view_count integer default 0`, `requested_via text` (e.g. `email_command`, `digest`, `manual`), `request_inbound_email_id uuid` (nullable FK), `request_nudge_id uuid` (nullable FK).
   - Acceptance: a `report.requested` event with kind/scope produces exactly one row; the response URL is `/{base}/r/<token>` where `<token>` is a 32-byte URL-safe random string returned only once; database stores the hash. Token is verified by hashing the inbound token and looking up `token_hash`. Expired or unknown tokens render a friendly dead-end page with no leak about whether the report ever existed.

2. **Live-query report payload (no payload snapshotting).**
   - The `generated_reports` row stores `scope` + `summary`, not a frozen loop list. The report page resolves loops on render against `scope` + the current loop state (subject to access checks).
   - Acceptance: marking a loop done via reply email immediately reflects in a freshly opened (but not yet expired) report; the report does not show stale rows.
   - Justification recorded inline in `src/reports/service.ts`: snapshots would (a) make row actions inconsistent (action mutates live row but view shows stale row), (b) double-store data we already own, (c) tempt us to drift from `loops` as source of truth. The only fields we freeze are the model-written `summary` text and the report's `scope`, because those represent the user's intent at request time.

3. **Insight email commands routed through the Phase 2.5 intent router.**
   - Add `classifyInsightCommand(text)` in `src/agent/intent-router.ts` (the Phase 2.5 module). Deterministic regex/keyword patterns first: `^\s*(what are my )?insights?\s*\??$`, `^\s*what (am i|is) waiting on\??$`, `^\s*what is stale\??$`, `^\s*weekly (summary|digest)\??$`. Entity-scoped ("show Acme loops", "Acme status", "loops with Maya") fall through to a `generateObject` call with a small schema `{ kind: "entity", entity: string }` (AR-8) when no deterministic pattern matches but the message clearly references a tracked participant.
   - `process-email` `command` branch dispatches insight commands by emitting `report.requested` (with `kind`, `scope`, `userId`, `inboundEmailId`).
   - Acceptance: each of the five sample commands lands in the correct kind/scope deterministically without a model call; an entity command produces a model-classified `{ kind: "entity", scope: { entity: "Acme" } }` event; an ambiguous string produces a clarifying private reply instead of a wrong report.

4. **`report.requested` Inngest function generates the report and replies.**
   - File: `src/workflows/functions/generate-report.ts`. Steps: load user → assemble loops via `src/reports/query.ts` (see below) → produce model-summary via `src/reports/summarize.ts` (`generateObject`, deterministic fallback that joins top-3 loop summaries) → insert `generated_reports` row with hashed token → enqueue a private reply nudge via the Phase 2.5 sender interface → emit `report.generated`.
   - Acceptance: idempotent on `(userId, inboundEmailId, kind, scope-hash)` so re-delivery of the inbound email does not double-generate.

5. **Memo-style report page (`app/r/[token]/page.tsx`).**
   - Server-rendered Next.js route. Layout: compact header (kind label + scope chip + "as of <relative time>" + total open count); grouped sections rendered in this fixed order: `Needs you (waiting on me)` → `Due soon` → `Overdue` → `Waiting on others` → `Stale` → `Recently done`. Empty sections collapse to a single muted line, not a card.
   - Each row: one-line summary, optional owner/requester chip, optional due-relative text, source-evidence chip (clickable). Row actions: `Done`, `Dismiss`, `Snooze...`, `Draft nudge` rendered as compact buttons (shadcn `Button` size sm, ghost variant) inline at the right of the row on desktop, stacked under the row on mobile.
   - Idiom: matches existing `src/components/ui` (shadcn, Tailwind 4, sparse utilitarian). No nested cards, no marketing copy, no skeleton shimmer, no charts. One `Card` per group section maximum; rows are plain `<li>` with borders.
   - Acceptance: lighthouse mobile-pass on a 6-loop fixture, no horizontal scroll, all groups render correctly with the derived `due_soon`/`overdue` logic, source-evidence chip on a row whose evidence requires login shows a lock affordance and links to `/sign-in?next=/r/<token>` instead of revealing the quote.

6. **Row-action endpoint that shares the email-command service layer.**
   - Refactor `src/loops/service.ts`: extract a `mutateLoopState({ userId, loopId, action, snoozeUntil?, commandText, source: "email_command" | "report_row_action" })` function from `applyLoopReplyCommand`. `applyLoopReplyCommand` continues to handle parsing email reply text and ordinal resolution, then delegates each loop update to `mutateLoopState`. Web row actions skip parsing and call `mutateLoopState` directly. Both paths write the same `loop_events` row (with a `metadata.source` discriminator) and emit the same `loop.updated` event payload.
   - New API route: `app/api/reports/[token]/actions/route.ts`. Body: `{ loopId, action: "done" | "dismiss" | "snooze" | "draft_nudge", snoozeUntil?: string }`. Auth: report token validates → resolves `user_id` → mutation is scoped to that user only. Token can mutate; viewing sensitive source-evidence still requires Clerk session.
   - "Draft nudge" enqueues a pending nudge via the existing nudges path; it does not send anything outbound until the user approves it through the existing email reply flow.
   - Acceptance: a parity test asserts that `applyLoopReplyCommand("dismiss 2", ...)` and a row-action POST `{action: "dismiss"}` for the same loop produce byte-identical `loop_events` rows (except `metadata.source`) and identical `loop.updated` event payloads.

7. **Deterministic ranking + insight query layer.**
   - File: `src/reports/query.ts`. Pure function `assembleReport({ kind, scope, now, loops }) -> ReportSections`. Inputs are already-fetched rows so the function is unit-testable with an injected clock.
   - Bucketing rules (deterministic, no model):
     - `Needs you`: `status = waiting_on_me`, plus `status = open` where `due_at <= now + 48h`.
     - `Due soon`: `due_at` within (`now`, `now + 7d`] and not already in `Needs you`.
     - `Overdue`: `due_at < now` and `status not in ('done','dismissed','snoozed')`.
     - `Waiting on others`: `status = waiting_on_other`.
     - `Stale`: no `loop_events` (other than `created`) and no inbound thread message in the last **N = 10 days**, and `status in ('open','waiting_on_me','waiting_on_other')`. Configurable in `src/reports/config.ts`. (Recommended default 10 — long enough to avoid noise on weekly cadences, short enough to be useful for biweekly check-ins.)
     - `Recently done`: `status = done` and `updated_at >= now - 7d`.
   - Importance score (used to order within each section): primary by due-date proximity (`overdue` weight 3, `<=24h` 2, `<=7d` 1, else 0) + secondary by waiting-duration (days since last activity, log-scaled), + tertiary by `confidence` as tiebreaker. Stable sort.
   - Entity-scoped reports apply the same buckets but filter loops where `participants[].name` or `participants[].email` matches the entity (case-insensitive substring or domain match), and additionally the `owner_text` / `requester_text` / `source_evidence.quote` fields. Matching is deterministic; no model decides inclusion.

8. **Model summary boundary (AR-8).**
   - File: `src/reports/summarize.ts`. `generateSuggestedSummary({ sections })` calls `generateObject` with schema `{ headline: string, bullets: string[] (max 3) }`. The model is shown only the already-deterministically-selected top loops (already-ranked) and writes the headline + bullets for the email body. Deterministic fallback (no model creds): `headline = "${total} open loops."`, `bullets = top three rows' summaries verbatim`.
   - The model never adds, removes, or re-orders loops in the report or the reply. Code in `summarize.ts` enforces this by ignoring any field other than `headline` / `bullets` from the model response.

9. **Email reply UX.**
   - File: `src/reports/reply.ts`. Builds the private email body exactly matching the roadmap example: "You have N open loops.\n\nMost important:\n1. ...\n2. ...\n3. ...\n\nPrivate view: <signed link>". Includes a one-line "Reply with done 1, snooze 2 until Monday, dismiss 3" footer so the report response itself is also commandable through Phase 2.5's reply-command flow.
   - Subject line per kind: `Your Keeps insights`, `What you are waiting on`, `Stale loops`, `Weekly summary`, `Loops for <entity>`.

10. **Friendly dead-end page for expired/invalid tokens.**
    - `app/r/[token]/page.tsx` handles `not_found` (token hash absent) and `expired` (token hash present but `expires_at < now`) identically: renders the same minimal page with copy `This Keeps view is no longer available. Email "what are my insights?" for a fresh link.` Server returns 200 in both cases (no 404 leak). No logging of attempted-but-missing tokens with PII; aggregate counters only.

## Data & Migrations

New table `generated_reports` (see Deliverable 1 for field list). Enum:

```sql
CREATE TYPE generated_report_kind AS ENUM (
  'insights', 'waiting_on', 'stale', 'weekly', 'entity'
);
```

Indexes:

- `unique(token_hash)` — primary lookup path for `/r/<token>`.
- `index(user_id, created_at desc)` — for "your recent reports" debug views.
- `index(expires_at)` — for an optional janitor cron that deletes long-expired rows; not built in this phase.

No `report_views` table. The roadmap marks it optional; we instead use the `last_viewed_at` + `view_count` columns on `generated_reports`. Rationale: viewing analytics on private expiring views adds storage and PII surface area for marginal value, and we want to avoid building anything that encourages dashboard-style traffic analysis on report opens. If Phase 6 evaluation needs per-open timing, add the table then.

Migration: `src/db/migrations/<n>_generated_reports.sql` (Drizzle generates). Schema additions in `src/db/schema.ts`: new enum `generatedReportKindEnum`, new table `generatedReports`, exported types.

Audit-log enum gets new actions: `report.requested`, `report.generated`, `report.viewed`, `report.action_applied`. Add to `auditActionEnum` in the same migration.

No changes to `loops`, `source_evidence`, `loop_events`, or `nudges` schemas. `loop_events.metadata` gains a documented `source: "email_command" | "report_row_action"` convention but no schema change.

## Events

All payloads are JSON-serializable; types live in `src/workflows/events.ts`.

- `report.requested` — `{ userId: string, kind: "insights"|"waiting_on"|"stale"|"weekly"|"entity", scope: Record<string, unknown>, requestedVia: "email_command"|"digest"|"manual", inboundEmailId?: string, nudgeId?: string }`. Emitted by the `command` branch of `process-email` after intent classification.
- `report.generated` — `{ userId: string, reportId: string, kind: string, scope: Record<string, unknown>, expiresAt: string (ISO), tokenHash: string, summaryHeadline: string, replyNudgeId: string }`. Emitted by `generate-report` after persistence + reply enqueue. Does **not** include the raw token.
- `report.viewed` — `{ userId: string, reportId: string, viewedAt: string, viewerKind: "anonymous_link"|"clerk_session", userAgentHash?: string }`. Emitted from the report page server component on each render (debounced via `last_viewed_at >= now - 5m` to avoid event spam on refresh).
- `loop.updated` — unchanged shape; row-action path emits the exact same payload as the email-command path (`{ loopId, userId, status, eventType }`).

Inngest idempotency:

- `generate-report` uses `idempotency: event.data.userId + ':' + event.data.kind + ':' + hash(event.data.scope) + ':' + (event.data.inboundEmailId ?? 'manual')` so a webhook redelivery cannot create two reports for the same insight request.

## Task Breakdown

Tasks are grouped into independent waves. Within a wave, tasks touch disjoint files and can be run by parallel agents. Between waves, later tasks depend on earlier ones.

### Wave A — schema, types, deterministic primitives (parallelizable)

- **A1. Schema + migration.** Files: `src/db/schema.ts`, `src/db/migrations/<n>_generated_reports.sql`. Add `generatedReportKindEnum`, `generatedReports` table, extend `auditActionEnum`. Export `GeneratedReport` / `NewGeneratedReport` types. Migration must round-trip with `pnpm db:generate` + `pnpm db:migrate` locally.
- **A2. Token primitive.** Files: `src/reports/token.ts`, `src/reports/token.test.ts`. Functions: `mintReportToken()` returns `{ token, tokenHash }` (32-byte URL-safe base64 + sha256 hex); `verifyReportToken(token, storedHash)` returns boolean using `crypto.timingSafeEqual`. No DB access here.
- **A3. Insight intent classifier.** Files: `src/agent/intent-router.ts` (extend existing Phase 2.5 module — add `classifyInsightCommand` export), `src/agent/intent-router.test.ts`. Five deterministic patterns first, model fallback via `generateObject` with a small schema `{ kind: "entity", entity: string }` ONLY when no deterministic pattern matches and the input contains a capitalized word resembling a participant. Deterministic fallback for tests: return `{ kind: "unknown" }` and let the caller send a clarification reply.
- **A4. Deterministic query/ranking.** Files: `src/reports/query.ts`, `src/reports/query.test.ts`, `src/reports/config.ts`. Pure functions over already-fetched data: `assembleReport({ kind, scope, now, loops, loopActivity })` returns `ReportSections`. Tests inject `now` so bucket boundaries (`due_soon` window, `stale` N=10, `recently done` 7d) are exercised at boundaries. Tests must not require a database.
- **A5. Reply builder.** Files: `src/reports/reply.ts`, `src/reports/reply.test.ts`. `buildReportEmail({ kind, sections, link, summary })` produces subject + body matching roadmap example. Pure string function; uses existing tone module if Phase 2.5 added one, otherwise direct string templates.

### Wave B — services that compose Wave A primitives

- **B1. Refactor `applyLoopReplyCommand` to extract `mutateLoopState`.** File: `src/loops/service.ts`. Add `mutateLoopState({ userId, loopId, action, snoozeUntil?, commandText, source })` exported function. `applyLoopReplyCommand` continues to parse + select targets, then loops over `mutateLoopState`. Acceptance: existing `service.test.ts` passes unchanged.
- **B2. Reports service.** File: `src/reports/service.ts`. Functions: `createReport({ userId, kind, scope, requestedVia, inboundEmailId?, nudgeId?, repository })` returns `{ reportId, token, expiresAt }`; `loadReportByToken(token, repository)` returns `{ report, sections, summary } | { status: "not_found" | "expired" }`; `applyReportRowAction({ token, body, repository })` calls `mutateLoopState` after validating token + scoping to the report's `user_id`. Inline justification comment explaining the live-query (no payload snapshot) decision.
- **B3. Reports repository.** File: `src/reports/repository.ts`. Drizzle-backed implementations of the I/O the service needs: `insertReport`, `findReportByTokenHash`, `touchReportViewed (debounced)`, `loadLoopsForScope (userId, scope) -> loops + recent loop_events for staleness`. Keeps DB queries in one place; service stays unit-testable.
- **B4. Model summary boundary.** Files: `src/reports/summarize.ts`, `src/reports/summarize.test.ts`. `generateSuggestedSummary({ sections, useModel })` calls `generateObject` with `{ headline, bullets[0..3] }` and ignores other fields. Deterministic fallback returns headline + verbatim top-3 row summaries. Tests verify the model boundary by feeding a mock model response with extra fields and asserting they are dropped.

### Wave C — workflow + UI surfaces (parallelizable, depend on Wave B)

- **C1. `generate-report` Inngest function.** File: `src/workflows/functions/generate-report.ts`. Triggered by `report.requested`. Steps: `loadLoopsForScope` → `assembleReport` → `generateSuggestedSummary` → `createReport` (mints token, inserts row) → `enqueueReportEmailNudge` (uses Phase 2.5 outbound sender). Emits `report.generated`. Idempotency key per spec above.
- **C2. `command` branch dispatch.** File: `src/workflows/functions/process-email.ts`. Inside the existing `command` branch (added in Phase 2.5), call `classifyInsightCommand`. If insight match, emit `report.requested` and return; if not, fall through to existing reply-command path. Add a small clarification reply when the user asked for "Acme loops" but no participant matches any tracked loop.
- **C3. Report page (server component).** File: `app/r/[token]/page.tsx`. Server-renders memo. Loads report via service. Detects Clerk session via `auth()`; passes `canViewSensitiveEvidence: boolean` to row components. Emits `report.viewed` via server action. Friendly dead-end page for `not_found` / `expired` returns 200.
- **C4. Report page row + section components.** Files: `src/reports/components/ReportHeader.tsx`, `src/reports/components/ReportSection.tsx`, `src/reports/components/LoopRow.tsx`, `src/reports/components/SourceEvidenceChip.tsx`, `src/reports/components/RowActions.tsx`. Uses existing `src/components/ui/{button,badge,separator,card}.tsx`. No new UI primitives. Mobile-first: stack actions under row below `sm`, inline above.
- **C5. Row-action API route.** File: `app/api/reports/[token]/actions/route.ts`. POST handler validates token → resolves `user_id` → dispatches to `applyReportRowAction`. Returns the updated section JSON so the client can re-render without a full page reload. Errors render as plain JSON `{ error: string }`; client component shows inline error under the row.
- **C6. Optional: `report.viewed` audit + counter.** File: `src/reports/service.ts` (extends B2). On render, if `last_viewed_at` is null or older than 5 minutes, bump `view_count` and `last_viewed_at` and emit `report.viewed`.

### Wave D — wire-up, fixtures, end-to-end tests (depend on Waves A–C)

- **D1. End-to-end fixture: insights command → email + link.** File: `src/reports/__tests__/insights-e2e.test.ts`. Drives the workflow with an in-memory repository: post a "what are my insights?" inbound through `process-email`, assert `report.requested` then `report.generated` fired, assert the outbound nudge body matches the roadmap example shape, assert the token resolves to a live report.
- **D2. Parity test (the keystone test).** File: `src/loops/parity.test.ts`. For each command (`done`, `dismiss`, `snooze`), run the email-command path and the row-action path against the same seeded loop and assert: identical `loops` row state, identical `loop_events` rows (other than `metadata.source`), identical emitted `loop.updated` event payload.
- **D3. Token expiry + forgery tests.** File: `src/reports/token.test.ts` (already added in A2; extend here). Verify: expired token → dead-end page; tampered token (last char flipped) → dead-end page; correct token → live report; `crypto.timingSafeEqual` is used (string compare alone would fail an injected mock asserting constant-time).
- **D4. Derived-urgency query tests with injected clock.** File: `src/reports/query.test.ts` (extend A4). Fixtures around the `due_soon` 7-day boundary, the `<=48h` "Needs you" boundary, the N=10 stale boundary, and the 7-day "recently done" boundary. Each boundary tested at `t-1s`, `t`, `t+1s`.
- **D5. Rendering smoke test.** File: `app/r/[token]/page.test.tsx`. Renders the page with a 6-loop fixture covering every section + an entity-scoped report. Asserts: every section heading present, source-evidence chip on a sensitive-evidence loop shows lock affordance when `canViewSensitiveEvidence` is false, expired-token branch renders the dead-end copy.
- **D6. README + audit log.** File: `docs/phases/README.md`. Update Phase Index status for Phase 5 from `planned` to `in_progress` when work starts. (No code change.)

## Testing

Unit:

- `src/reports/token.test.ts` — mint/verify, constant-time compare, expiry.
- `src/reports/query.test.ts` — bucketing with injected clock at all boundaries; entity matching against `participants`, `owner_text`, `requester_text`; deterministic ordering of top-3.
- `src/reports/summarize.test.ts` — model fallback path; verifies model response fields outside the schema are dropped.
- `src/reports/reply.test.ts` — subject and body shape per kind.
- `src/agent/intent-router.test.ts` — five deterministic insight patterns; entity fallback to `generateObject` with mocked model; unknown returns `kind: "unknown"`.
- `src/loops/service.test.ts` — unchanged, must still pass after the `mutateLoopState` refactor.

Integration:

- `src/reports/__tests__/insights-e2e.test.ts` — full insights command flow with in-memory repository.
- `src/loops/parity.test.ts` — keystone test for row-action vs email-command parity.
- `app/r/[token]/page.test.tsx` — server-rendered smoke test with React Server Components in test mode; renders the not-found, expired, and live branches.

Fixtures:

- Six-loop fixture covering every section: 1 `waiting_on_me` overdue, 1 `open` due in 12h, 1 `open` due in 4 days, 1 `waiting_on_other` stale (last activity 12 days ago), 1 recently `done` 2 days ago, 1 `candidate`.
- Entity-scoped fixture: three of the above tagged with `participants: [{ name: "Acme" }]` so "show Acme loops" returns three rows.

No live model creds required for any test; all model paths have the deterministic fallback.

## Risks & Open Questions

- **Risk: reports become a back-door dashboard.** A user could bookmark `/r/<token>` and refresh it daily.
  - Recommended default: hard 7-day expiry, no renewal endpoint, no "extend" button. If a user repeatedly emails "what are my insights?" within an hour, the workflow returns the same un-expired link rather than minting a new one (additional idempotency window).
- **Open: should "weekly summary" auto-include the prior week's done loops?**
  - Recommended default: yes — it is the only kind where `Recently done` is the headline section, ordered by `updated_at desc`. Other kinds keep `Recently done` collapsed by default.
- **Open: should the entity classifier be limited to known participants?**
  - Recommended default: yes — the model returns an entity string, but the deterministic query layer drops it if no loop matches. The clarification reply explicitly says "I do not see any loops tagged with <entity>. Did you mean one of these: <top 3 participants>?". Keeps the model from hallucinating entities into existence.
- **Open: snapshot vs live-query.**
  - Recommended default (and chosen here): live-query with stored scope. Documented in `src/reports/service.ts` justification comment. Revisit only if Phase 6 evaluation surfaces a "row changed under me" UX complaint, in which case we add a per-request snapshot stored in Inngest run history rather than the DB.
- **Open: staleness threshold N.**
  - Recommended default: **N = 10 days**. Avoids weekly-cadence noise, surfaces biweekly-check-in misses, lines up with what operators typically consider "this has gone quiet." Configurable in `src/reports/config.ts` so a Phase 6 eval can shift it without code changes.
- **Open: `report_views` table or columns?**
  - Recommended default (and chosen here): columns on `generated_reports` (`last_viewed_at`, `view_count`). Skip the table. Justification: minimizes PII surface; aggregate counters are sufficient for the "is this surface used" question; if Phase 6 needs per-open timing, add the table then.

## Out of Scope

- Persistent dashboard navigation, a "my reports" index page, or any UI that encourages daily checking. The only entry point to a report is an email link.
- Team / shared / multi-user reports. Phase 7.
- Renewing or extending expired report tokens.
- Advanced analytics (charts, time-series, retention metrics in reports).
- Live websocket / SSE updates on the report page after initial render.
- Admin or ops reporting views.
- Linear/Jira/GitHub integration into reports.
- Connector actions from the report page (Slack/Calendar are still draft-then-approve via email per Phase 4).
- Eval/precision tracking on report ranking — belongs in Phase 6.

## Exit Criteria

- [x] `generated_reports` table migrated (hand-written idempotent SQL `0013`/`0014`, applied twice locally + to prod). NOTE: `pnpm db:migrate` is broken-by-design; migrations are hand-written sequential SQL.
- [x] Each of "what are my insights?", "what am I waiting on?", "what is stale?", "weekly summary", "show Acme loops" routes deterministically (the first four without a model call) and produces a `report.requested` event with the correct kind/scope. Insight commands route via `classify-intent.ts` `subtype:"insight_command"` → `route-email.ts` `runInsightCommandBranch` (NOT the Phase 3 question stub).
- [x] `generate-report` Inngest function generates one report per request (idempotent on `userId + kind + inboundEmailId`), persists with hashed token + 7-day expiry, enqueues a private reply matching the roadmap shape, and emits `report.generated`.
- [x] `/r/<token>` renders a memo-style page for a live report: header, six grouped sections with `due_soon`/`overdue` derived per AR-6, source-evidence chips, row actions; mobile-first layout.
- [x] Source-evidence chip on a sensitive-evidence loop shows a lock and routes to Clerk sign-in (preserving `next=/r/<token>`) when the viewer is anonymous.
- [x] Expired or unknown tokens render the friendly dead-end page with HTTP 200 and no information leak.
- [x] Row actions hit `src/loops/service.ts::mutateLoopState`; the keystone parity test (`src/loops/parity.test.ts`) passes for `done`, `dismiss`, `snooze`.
- [x] `report.requested`, `report.generated`, `report.viewed`, and `loop.updated` events fire with documented payloads; `report.viewed` debounces at 5 minutes per report.
- [x] Model boundary holds: ranking and inclusion are deterministic in `src/reports/query.ts`; the model only writes `headline` + `bullets[0..3]` in `src/reports/summarize.ts`; tests verify extra model fields are dropped.
- [x] All unit + integration tests pass; `pnpm typecheck`, `pnpm test` (1072 passed), `pnpm build` green.
- [x] Phase 5 row in `docs/phases/README.md` Phase Index is moved to `done`.

## Closeout (2026-06-13)

Shipped + live-verified on https://keeps.email. Full loop confirmed in prod by Arav: emailed "what are my insights?" → private ranked reply + signed `/r/<token>` link → memo page rendered his real open loop under **Needs you** → tapped **Done** → loop transitioned and re-opening showed it under **Recently done** (live-query, no snapshot).

**How it was built:** orchestrated sprint — Opus orchestrator + per-task worktree subagents (Sonnet/Opus), reviewed diff-by-diff and cherry-picked onto `main`. Waves A (schema + deterministic primitives) → B (services) → C (workflow + UI) → D (keystone parity + e2e/render tests + gates + deploy + live wave).

**Plan corrections that held:** intent router is `classify-intent.ts` + `route-email.ts` (not the plan's `intent-router.ts`); migrations are hand-written idempotent SQL `0013`/`0014` (not drizzle-generated); the report token mirrors `src/approvals/tokens.ts`; the reply is enqueued as a `report`-type nudge and sent via the digest/nudge sender path with a commandable `Reply-To` + `ordinalMap`.

**Keystone (D2):** `mutateLoopState` is the single mutation funnel; `src/loops/parity.test.ts` asserts the web row-action and the email command produce byte-identical `loop_events` (except `metadata.source`) and identical `loop.updated`, and that `applyReportRowAction` maps `done→mark_done`/`dismiss`/`snooze` correctly + a forged token never mutates.

**Live-wave bug caught & fixed (commit after deploy):** an `open` loop with no due date and recent activity matched none of the six buckets → counted in `totalOpen` but rendered nowhere → the model was handed an empty top-items list and hallucinated a bullet. Fix: (1) `assembleReport` falls any unbucketed `open` loop into **Needs you**; (2) `generateSuggestedSummary` skips the model when there are zero top items. Both regression-tested.

**Follow-ups (non-blocking):**
- Idempotency key is `userId:kind:inboundEmailId` (scope-hash omitted — Inngest CEL can't hash; a single inbound command yields one kind+scope so it's unique in practice). Add scope-hash if manual/digest report requests are introduced.
- `draft_nudge` row action enqueues an inert pending nudge (won't auto-send — the sweep is loop-driven and the send pass filters by `inboundEmailId`); a real draft→approve→send flow for report-originated nudges is deferred.
- `report.viewed` / `view_count` columns exist + debounce works; no analytics surface built (intentional).
- Postmark free tier (100/mo) — report replies add volume; upgrade to $15/mo if it becomes limiting (Arav defers).
