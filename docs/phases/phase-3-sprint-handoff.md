# Phase 3 Sprint Handoff (Nudges, Digests, Approvals)

Orchestrated sprint: Fable oversees and verifies; subagents (Sonnet/Opus per task) write the code. Launch with a fresh session:

```sh
cd /Users/aravb/Developer/keeps && claude
```

---

## Prompt

```
You are orchestrating Phase 3 (nudges, digests, approval workflow) for Keeps. Working directory: /Users/aravb/Developer/keeps. You (Fable) do NOT write the feature code yourself — you spawn subagents per task with the Agent tool, review every diff critically before accepting it, run the gates between waves, commit atomically, and run the live verification with Arav. Ground truth: docs/phases/phase-3-nudges-digests-approvals.md (the executable plan — 17 deliverables, waves A-E, exit criteria), AR-3/AR-5/AR-6/AR-7/AR-9 in docs/phases/README.md, git log.

CURRENT STATE (verified 2026-06-12 end of Phase 2.7, do not re-derive):
- Production LIVE and canonical at https://keeps.email (NEXT_PUBLIC_APP_URL points there; keeps-ivory.vercel.app stays as alias and as INNGEST_SERVE_ORIGIN). Full 2.7 capture aperture verified live: activation email w/ RFC 3834 guards + 7d window, CC-once thread-follow w/ spoof guard, inline passwordless stepper.
- Clerk is a PRODUCTION instance (ins_3F2ZEXgzNlzELgpmr2UFLHdMdEW, app app_3F20fnrf3nlQSElAoQdn9CUW2QN, frontend API clerk.keeps.email). Password auth is DISABLED (email_code only — Clerk's email-OTP custom-flow prerequisite). The `clerk` CLI is installed and authenticated: `clerk config pull/patch --app <id> --instance prod` works; use it instead of asking Arav for dashboard reads where possible. Custom auth flows use `@clerk/nextjs/legacy` hooks (v7's default useSignUp is the new signals API). Webhook (user.created/user.updated -> claim) verified live on the production instance.
- DB: RDS keeps-prod, migrations 0000-0005 applied. pnpm db:migrate is broken BY DESIGN (no drizzle journal) — Phase 3's plan mentions `pnpm db:push` / drizzle migrations: OVERRIDE that. Migrations are hand-written sequential SQL files (next is 0006) in src/db/migrations/, idempotent (IF NOT EXISTS; ALTER TYPE ADD VALUE one non-transactional statement each — copy the style of 0004/0005), applied via psql in the live wave (psql at /opt/homebrew/opt/libpq/bin; prod DATABASE_URL: `doppler secrets get DATABASE_URL --project keeps --config prd --plain`). Vercel env vars are SENSITIVE/write-only — Doppler is the ops path.
- Inngest: auto-sync on deploy WORKS. Live functions: process-email, alert-on-pipeline-failure, pipeline-canary (daily 13:00 UTC), send-activation-email. Registration = add to the functions array in app/api/inngest/route.ts, deploy, verify by behavior (probe), never manual sync.
- Outbound mail: sendNudge (src/loops/send-nudge.ts) for nudges; sendSystemEmail (src/email/system-send.ts) for non-nudge mail (sets Auto-Submitted: auto-replied, persists outbound_emails with NULL user_id/nudge_id — both columns are nullable since 0005). findSendableNudge has a PRIVACY GUARD: nudges are never addressed to a non-owner address (thread-followed counterparties must never receive the owner's loop summary) — preserve it in every new send path.
- Inbound webhook secret: lives ONLY in the Postmark inbound URL (basic-auth password) and Vercel env — NOT in .env.local or Doppler. For live probes, ask Arav for it once (do not rotate — rotating breaks live inbound mail).
- Tests: 142 green, vitest, all unit tests use in-memory fakes/ports (NO live Postgres, NO live Inngest). Phase 3's plan calls for Postgres-backed repository tests on localhost:55433 and Inngest dev-server integration tests — check whether local Postgres/Inngest dev are actually running before assuming; if not, follow the established repo convention (pure cores + injected ports + in-memory fakes, integration coverage via the route/function wrappers like process-email.test.ts) and note the deviation in the commit.
- Postmark is on the free 100/mo tier — digest+nudge volume will exceed it. Flag the $15/mo upgrade to Arav before the live wave.

ENGINEERING GOTCHAS — put these in every relevant subagent prompt verbatim:
1. Inngest step determinism: the function body re-executes per step. Anything random/time-based MUST be minted inside a step.run and read from its memoized return (the pipeline canary's first prod run failed exactly this way). For Phase 3 crons: mint `now` once in the first step.
2. Outbound sends live in their own dedicated SEND-ONLY Inngest step — no DB writes in the same step — with bookkeeping (stamps, audit rows) in a separate following step reading the memoized send result. Otherwise a DB blip after a Postmark accept double-sends (send-activation-email.ts is the reference: check / send-only / record). Postmark: Reply-To must be a top-level field, never inside the Headers array (error 300).
3. OpenAI strict structured outputs: generateObject Zod schemas must have NO .default()/.optional() — every field required, optionality via .nullable() (commit 77717a3 fixed a prod outage). Phase 3 mostly avoids the model, but digest free-text replies route into extraction.
4. New Inngest functions register in app/api/inngest/route.ts and auto-sync on deploy — no manual sync step. AR-5: NO step.sleepUntil anywhere in src/workflows/ — sweeps + waitForEvent only.
5. Every time-dependent function takes injected `now` (mirror parseLoopReplyCommand). Timezone math via Intl.DateTimeFormat with IANA tz, no new deps; unknown tz falls back to UTC.
6. AR-3: ordinal->loopId/approvalId resolution ALWAYS comes from the referenced nudge's persisted metadata (via MailboxHash), NEVER from a fresh listing at reply time.
7. Approval tokens: random 32-byte base64url, store only the SHA-256 hash, plaintext only in the email link; decisions idempotent (double-decide = no-op returning current state).

ORCHESTRATION PLAN (waves from the phase doc; spawn agents with the Agent tool, model per task; tasks within a wave run in PARALLEL — use isolation:"worktree" when agents would share files, have each commit on its branch and report it, cherry-pick after review, and git worktree remove + branch -D every worktree BEFORE running gates in the main tree — vitest scans .claude/worktrees and double-counts tests):
Wave A — foundations, 5 parallel agents:
  A1 [sonnet]: migrations 0006+ (loops bookkeeping, users digest prefs, approval tables w/ requires_login, audit_action + loop_event_type ADD VALUEs) + schema.ts + Draft/ApprovalRequest/ApprovalStatus types + src/nudges/types.ts. Do NOT run migrations.
  A2 [sonnet]: typed event registry src/workflows/events.ts per the Events section + migrate existing send sites to the typed helper (mechanical).
  A3 [sonnet]: nudge policy constants + pure selectors + timezone helper (src/nudges/policy.ts, selectors.ts, src/users/timezone.ts) + boundary/DST tests.
  A4 [sonnet]: digest model + renderer (src/digests/build.ts, render.ts) incl. the two AR-9 requirements: opening coverage line, closing capture prompt; snapshot tests for the roadmap UX sample + edge cases.
  A5 [sonnet]: approval tokens (mint/hash/verify) + approval reply command parser (src/approvals/tokens.ts, commands.ts) + tests.
Wave B — service layer after A is reviewed+committed, 3 parallel agents:
  B1 [sonnet]: approval service + repository (createApprovalRequest, verifyApprovalToken, decideApproval — idempotent, emits approval.received) + tests.
  B2 [OPUS]: executeApprovedDraft funnel + action registry (test_action only) + policy gate evolution authorize(action, context) with assertApprovalAllowed delegating — this is the security boundary every future connector runs through; tests for allowed/needs_approval/denied, unknown action_kind failure path.
  B3 [sonnet]: nudge + digest repositories (eligibility queries, daily-cap counting, due-at-hour selection, 23h digest recency guard) + tests per repo convention.
Wave C — Inngest functions after B, 4 parallel agents:
  C1 [sonnet]: sweep-nudges cron (*/10) + send-nudge consumer (re-validate eligibility inside, send-only/record step split, loop_events 'nudged', cap deferral to next local 9 AM).
  C2 [sonnet]: sweep-digests cron (hourly) + send-digest consumer (build, render, send, persist digest nudges row w/ ordinal map, 23h in-function idempotency).
  C3 [OPUS]: handle-approval workflow (send approval email -> step.waitForEvent('approval.received', match data.approvalId, timeout 7d, env override for tests) -> approved/rejected/timeout branches) + sweep-approval-expiry cron (*/15) failsafe.
  C4 [OPUS]: intent router extension — question branch (answer-question -> digest-style reply), approval branch (MailboxHash -> nudge_type 'approval' -> parse -> decideApproval), digest free-text fallthrough to capture/extraction (AR-9). Touches process-email/route-email — highest-regression-risk task; demand integration-style tests through the route wrapper.
Wave D — app surface, parallel with C, 1 agent:
  D1 [sonnet]: approval pages (app/approvals/[id]/page.tsx + decide route + links.ts; token-only for requires_login=false, Clerk session redirect otherwise) + settings page for digest prefs/timezone (browser-detected tz via Intl). DESIGN SYSTEM (updated 2026-06-12, supersedes any cream/terracotta reference): use the square seafoam system now live in app/get-started-stepper.tsx — tokens seafoam #C1F5DF / ink #14140F / paper #FAFAF8 / wash #E9FBF4 / deep #1E6B4F / line #E2E2DD / muted #6F6F66 / error #B42318; radius 0 everywhere; bezeled square seafoam buttons (copy primaryButtonClass); Bricolage Grotesque is the global font (already in app/layout.tsx); DotField background is home-page-only, not needed on approval/settings pages. Emails: plain text first; if an email needs a tap target, copy the minimal inline-styled HTML button pattern from buildUnknownSenderReplyHtml in src/email/inbound.ts (system fonts, no images, square seafoam button).
Wave E — YOU (Fable): integration tests E1-E3 (one sonnet agent if substantial), full gates, then live wave with Arav:
  E0: apply migrations via psql (Doppler DATABASE_URL), verify columns/tables/enums. Deploy. Verify all new crons registered by behavior.
  E1: seed/adjust a real loop so next_check_at is past -> sweep fires -> nudge lands in Arav's inbox; reply "snooze 1 until Monday" -> status snoozed, next_check_at = user-local Monday 9 AM, next sweep skips it.
  E2: digest live: set Arav's digest_send_hour to the next hour (or trigger digest.daily_due manually), digest arrives with coverage line + capture prompt; reply "done 2" resolves ordinal 2; reply with a free-text brain dump -> loops created.
  E3: approval live on Arav's phone: create a test_action approval -> email arrives -> tap approve link -> approval.executed audit; second approval decided via reply "approve"; third left to expire (set short TTL) -> expiry email + audit.
  Close out: check off Phase 3 exit criteria; flag Postmark tier upgrade if not done.

YOUR VERIFICATION DUTIES (non-negotiable):
- Read every subagent diff before accepting. Adversarial focus: B2/C3's authz + token path (try to execute a draft without an approved approval; replay a decided approval; use an expired/mismatched token; double-decide), C4's router regressions (existing capture/command/correction flows must be untouched — 142 existing tests stay green), digest timezone math (DST, UTC fallback), and the daily-cap arithmetic at boundaries.
- Run pnpm typecheck && pnpm test between waves; full pnpm build before deploy. New code needs new tests (subagent prompts must demand them).
- Commit per task or per wave, atomic, message style "Phase 3 <task>: ..." ending with "Co-Authored-By: Claude <noreply@anthropic.com>". Never commit secrets; never print secret values.
- If a subagent's work fails review twice, fix it yourself rather than spawning a third attempt.

Working style: act, don't ask, for reversible engineering steps. Arav does: anything on his phone, Clerk/Postmark/Inngest dashboard reads you can't reach via CLI, sending real emails from his accounts, and the Postmark plan upgrade. Stop at the first live-smoke failure, debug yourself (psql, vercel logs, clerk CLI, probes) before involving him. Start with Wave A.
```
