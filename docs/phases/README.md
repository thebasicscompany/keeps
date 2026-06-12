# Keeps Phase Plans

Drafted: 2026-06-12

This directory holds the detailed, executable close-up plan for each remaining phase. `docs/roadmap.md` stays the product-level narrative; these documents are the engineering plans agents and humans execute from. When a phase plan and the roadmap disagree on implementation detail, the phase plan wins (it is newer and more specific).

## Current Codebase State

Phases 0–2 are implemented and verified locally:

- Next.js 16 app shell, dev email auth stub (`src/auth/dev-session.ts`, unsigned cookie — to be replaced by Clerk).
- Postmark-shaped inbound webhook at `app/api/email/inbound/route.ts` with shared-secret header check, dedupe on provider message ID, unknown-sender holding in `pending_inbound_emails`, claim-on-signup.
- Drizzle/Postgres schema (`src/db/schema.ts`): users, identities, audit_log, email threads/messages, inbound + pending inbound emails, source_evidence, loops, loop_events, nudges. Migrations in `src/db/migrations/`.
- Inngest `process-email` function (`src/workflows/functions/process-email.ts`) triggered by `email.received`.
- Loop extraction (`src/agent/extract-loops.ts`): `generateObject` via Vercel AI SDK with a deterministic regex fallback used by tests and local runs.
- Reply command parser + service (`src/loops/commands.ts`, `src/loops/service.ts`): confirm / dismiss N / snooze / mark N done / correct. Not yet wired to real inbound replies.
- Policy gate stub (`src/policy/actions.ts`): external actions throw without an approval ID.
- Nudges are stored as `pending` rows; nothing sends outbound email yet.

Local stack: Docker Postgres on 55433, `pnpm dev` on 3000, Inngest dev server on 8288. `pnpm typecheck`, `pnpm test`, `pnpm build` all pass.

## Locked Product Decisions

These were confirmed by Arav on 2026-06-12. Plans must not reopen them.

1. **First ICP: founders/operators.** Scattered, high-stakes, email-native loops. Digest and extraction tuning targets this persona.
2. **Explicit capture (BCC/forward/direct email) is the product**, not a wedge toward full mailbox ingestion. Do not architect for mailbox-scale volume.
3. **Agent ambition:** single approved actions via OAuth connectors now; user-defined automations under standing permissions later. The approval model must be able to grow into scoped standing grants without a rewrite.
4. **Auth: Clerk.** Email verification, sessions, and later organizations come from Clerk. The sender-email → user mapping and the claim-held-emails flow key off Clerk-verified email addresses.
5. **Hosting: Vercel + managed Postgres (Neon assumed), deployed ASAP.** Email provider is Postmark (inbound + outbound). Workflows stay on Inngest (cloud) — it is serverless-friendly and already integrated.
6. **Email is the main UI.** No dashboard habit. Generated expiring views are the only visual surface beyond onboarding/settings.

## Binding Architecture Rulings

Cross-cutting decisions every phase plan must respect. Numbered for citation (AR-1 … AR-8).

- **AR-1 — Single processing path.** All inbound email processing flows through Inngest, in dev (Inngest dev server) and prod alike. The webhook route does only: verify secret → validate payload → persist → emit `email.received` → 202. The inline `processInboundEmailForLoops` fallback in the route is removed.
- **AR-2 — Workflow is an intent router.** `process-email` classifies first (deterministic rules, then model when needed): `capture | command | approval | question | correction`, then branches to a dedicated handler. Loop extraction is the *capture* branch, not the default for every email.
- **AR-3 — Reply mapping via nudge metadata + plus addressing.** Every outbound nudge/reply persists its ordinal→loopId mapping in `nudges.metadata` at send time. Outbound emails set `Reply-To: agent+n_<nudgeId>@keeps.ai` (Postmark `MailboxHash` identifies the nudge on reply) and proper `In-Reply-To`/`References` headers for threading. Inbound command replies resolve ordinals against the referenced nudge's stored mapping — never against a live re-listing.
- **AR-4 — Idempotency at the workflow layer.** `process-email` sets Inngest `idempotency` on `event.data.inboundEmailId`. Persistence guards uniqueness (one extraction result set per inbound email) so replays cannot double-create loops or nudges.
- **AR-5 — Cron sweep for time-based work; `waitForEvent` only for approvals.** No `step.sleepUntil`-per-loop. An Inngest cron (every 10–15 min) queries loops with `next_check_at <= now` and emits `loop.nudge_due`; the daily digest is another cron. Snooze/done just update the row — no cancellation choreography. Approval flows use `step.waitForEvent` with timeout, which is the right shape there.
- **AR-6 — Loop `status` is lifecycle only.** `due_soon` and `overdue` are removed from the stored enum and derived at query time from `due_at`/`next_check_at`. Stored statuses: `candidate, open, waiting_on_me, waiting_on_other, blocked, snoozed, done, dismissed`.
- **AR-7 — Policy gate grows toward standing grants.** `requiresApproval(action)` evolves to `authorize(action, context)` returning `allowed | needs_approval | denied`, where context can carry an approval ID *or* (later) a standing grant. Connector code must not hard-code "approval ID string exists" as the only authorization shape.
- **AR-8 — Model boundary unchanged.** Models return typed candidates via `generateObject`; application code decides persistence; deterministic fallbacks stay so tests and local runs need no credentials. No freeform model text mutates state.

## Outbound Email Split

The outbound email *interface* (sender abstraction, threading headers, ordinal metadata, dev transport that records instead of sending) lands in Phase 2.5 so the full loop is testable locally. The *live* Postmark transport, DNS/MX, and webhook configuration land in Phase 2.6.

## Phase Plan Template

Every phase document follows this structure:

```markdown
# Phase X: Title

Status: planned | in_progress | done
Depends on: <phases>
Roadmap reference: <section in docs/roadmap.md>

## Goal            — one paragraph; what is true when this phase is done
## Why Now         — why this ordering
## Preconditions   — what must exist before starting
## Deliverables    — numbered; each with concrete acceptance criteria
## Data & Migrations — schema changes, enum changes, new tables
## Events          — new/changed Inngest events with payload shapes
## Task Breakdown  — ordered tasks with file paths; group into waves
##                   (Wave A/B/...) where tasks within a wave are
##                   independent and parallelizable by separate agents
## Testing         — unit/integration strategy, fixtures needed
## Risks & Open Questions — with recommended defaults
## Out of Scope    — explicit non-goals
## Exit Criteria   — checklist; phase is done when all are true
```

Task breakdowns should be written so a fresh agent can execute a single task from the document alone: name files, name functions, state the expected behavior change.

## Phase Index

| Phase | Document | Scope | Depends on |
|-------|----------|-------|------------|
| 2.5 | `phase-2.5-pipeline-hardening.md` | Single Inngest path (AR-1), intent router (AR-2), reply-command closure with nudge ordinal metadata + outbound sender interface w/ dev transport (AR-3), workflow idempotency (AR-4), lifecycle-only status enum migration (AR-6) | — |
| 2.6 | `phase-2.6-auth-go-live.md` | Clerk auth replacing dev stub, claim flow on Clerk-verified email, live Postmark transport (outbound) + inbound stream/DNS, Vercel + Neon + Inngest cloud deployment, webhook hardening | 2.5 |
| 3 | `phase-3-nudges-digests-approvals.md` | Nudge cron sweep (AR-5), daily digest, approval requests + `waitForEvent`, signed expiring approval links, reply approve/reject/edit | 2.5, 2.6 |
| 4 | `phase-4-slack-calendar-connectors.md` | Nango setup, Slack + Google Calendar OAuth, `@Slack`/`@Calendar` command parsing, drafts → approval → execute-once, policy `authorize()` evolution (AR-7) | 3 |
| 5 | `phase-5-generated-insight-views.md` | Generated report records, signed expiring URLs, memo-style report pages with row actions, insight email commands | 3 |
| 6 | `phase-6-reliability-eval-trust.md` | Eval fixture suite + precision tracking, observability, delete/export/retention, dead-letter queue, replay handling | 3 (5 ideally) |

Phases 7 (team transition) and 8 (pilot packaging) intentionally remain roadmap-level until the individual product shows repeated usage.
