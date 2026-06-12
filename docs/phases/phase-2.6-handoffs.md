# Phase 2.6 Execution Handoffs

Five agent prompts across three sequential engineering waves, plus a human setup checklist (Arav) that runs in parallel with engineering and a go-live wave that needs both. Source plan: `docs/phases/phase-2.6-auth-go-live.md` — its Waves A/B/C are regrouped here for disjoint file ownership; its Waves D/E become the Go-Live section.

Within a wave, agents run in parallel (same repo, disjoint files). A wave starts only after the previous wave's agents have committed and `pnpm typecheck && pnpm test` passes.

**Repo conventions the plan doesn't know:** `pnpm db:migrate` does not work (no drizzle journal — pre-existing). Migrations are hand-written SQL applied via `docker exec keeps-postgres psql -U postgres -d keeps` locally (container `keeps-postgres`, host port 55433) and via `psql $DATABASE_URL` against RDS at cutover. Tests never touch live Postgres — injectable ports with in-memory fakes.

---

## Human Setup Checklist (Arav — start now, engineering does not block on it)

Ordered by lead time. Items 1–3 unblock local rehearsal; 4–6 unblock deploy; 7–8 happen after first deploy.

1. **Clerk** — create the Keeps application (dev instance). Copy `CLERK_PUBLISHABLE_KEY` (+ `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) and `CLERK_SECRET_KEY` into `.env.local`. Email as primary identifier, magic link or email-code — Clerk defaults are fine. Prod instance can wait until Vercel exists.
2. **Postmark** — create account + a Server named `keeps-prod`. Note the **server token**. Two sub-items:
   - **Inbound stream**: note the **generated inbound address** (`<hash>@inbound.postmarkapp.com`). ⚡ **Early real-email test option:** once engineering Waves A–B are merged, you can point this stream's webhook at an `ngrok http 3000` URL (with the `X-Keeps-Webhook-Secret` header) and BCC a real Gmail message to the generated address — that exercises real email end-to-end *before* Vercel, DNS, or `agent@keeps.ai` exist. Same trick validates the `dismiss 1` reply round-trip with real Gmail threading.
   - **Outbound DNS (longest lead time — start day one)**: `keeps.ai` is not purchased (decision 2026-06-12) — verify `basicsoftware.ai` in Postmark instead (DKIM + Return-Path at the registrar) and send From `keeps@basicsoftware.ai`. Zero-DNS stopgap for the first test: a plain sender signature for `arav@basicsoftware.ai` (email-click confirm). Without DKIM, Gmail may spam-fold nudges. Reply-To uses the generated inbound address (plus-addressing works there), so no inbound DNS ever needed for the pilot.
3. **OpenAI key** (if not already in hand) — `OPENAI_API_KEY` for live extraction; optional locally.
4. **AWS RDS** (replaces Neon — decided 2026-06-12, you have the SST-provisioned instance + credits) — make the instance publicly accessible with TLS enforced and a strong password (Vercel has no stable egress IPs; SG opens 5432 to 0.0.0.0/0 — pilot-acceptable, revisit in Phase 6), create a `keeps` database, note `DATABASE_URL` with `?sslmode=require`.
5. **Vercel** — create the project from the repo. Set the env matrix from plan §D1 (table in `phase-2.6-auth-go-live.md`) for Production/Preview. Leave `INNGEST_DEV` unset in cloud.
6. **Inngest Cloud** — create the `keeps` app; note `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` into Vercel env.
7. **After first deploy — Clerk webhook**: dashboard → Webhooks → add `https://<prod-host>/api/auth/clerk/webhook`, subscribe `user.created` + `user.updated`, copy the Svix signing secret to Vercel as `CLERK_WEBHOOK_SIGNING_SECRET`.
8. **After first deploy — Postmark inbound webhook**: point the inbound stream at `https://<prod-host>/api/email/inbound` with custom header `X-Keeps-Webhook-Secret: <KEEPS_INBOUND_WEBHOOK_SECRET>` (same value as Vercel env).

---

## Wave A (run A-1 and A-2 in parallel)

### Prompt A-1 — Clerk plumbing + env schema

```
You are executing tasks A1, A2, A3, and C4 from the frozen plan docs/phases/phase-2.6-auth-go-live.md for Keeps (email-first work-memory product). Working directory: /Users/aravb/Developer/keeps. Read the plan fully first — those four tasks plus Deliverable 1 (first bullet) are your spec.

A1: install @clerk/nextjs; create middleware.ts with clerkMiddleware() and a matcher excluding /api/email/inbound, /api/inngest, /api/auth/clerk/webhook, and static assets; wrap app/layout.tsx in <ClerkProvider>. Do NOT touch app/page.tsx (a later wave owns it).

A2: create app/sign-up/[[...rest]]/page.tsx and app/sign-in/[[...rest]]/page.tsx rendering Clerk's <SignUp /> / <SignIn /> with signInUrl/signUpUrl and afterSignInUrl/afterSignUpUrl="/". Default Clerk styling.

A3 + C4: extend envSchema in src/config/env.ts with CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, CLERK_WEBHOOK_SIGNING_SECRET, POSTMARK_FROM_ADDRESS (default "agent@keeps.ai"), POSTMARK_REPLY_TO_DOMAIN (default "keeps.ai"), POSTMARK_MESSAGE_STREAM (default "outbound") — all Clerk vars optional so local dev without Clerk still works.

You own ONLY: package.json, pnpm-lock.yaml, middleware.ts (new), app/layout.tsx, app/sign-up/**, app/sign-in/**, src/config/env.ts. Do not touch app/page.tsx, src/auth/**, src/email/**, src/db/** (other agents own them). Stage with explicit `git add <paths>` only — never `git add -A`.

When done: pnpm typecheck && pnpm test pass, and `pnpm dev` boots with Clerk's missing-keys warning rather than crashing (verify, then kill it). Commit ONLY your files: "Phase 2.6 A1-A3+C4: Clerk provider, middleware, auth routes, env schema" ending with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Brief report: what changed, deviations.
```

### Prompt A-2 — PostmarkSender + audit enum migration + inbound hardening

```
You are executing tasks C1, C3, and A6 from the frozen plan docs/phases/phase-2.6-auth-go-live.md for Keeps (email-first work-memory product). Working directory: /Users/aravb/Developer/keeps. Read the plan fully first — Deliverables 4 (first bullet), 5, and the Data & Migrations section are your spec. The EmailSender interface is in src/email/outbound.ts (Phase 2.5).

C1: create src/email/postmark-sender.ts — class PostmarkSender implements EmailSender, constructor { serverToken, fromAddress, replyToDomain, messageStream }. send() POSTs to https://api.postmarkapp.com/email with X-Postmark-Server-Token; maps the EmailSender shape to Postmark JSON { From, To, Subject, TextBody, HtmlBody, Headers, ReplyTo, MessageStream }; ReplyTo comes from the message's replyTo (which carries agent+n_<nudgeId>@<domain> per AR-3); forwards In-Reply-To / References as Headers entries; throws typed PostmarkSendError with Postmark ErrorCode on non-2xx. Take config via constructor only — do NOT read env (a parallel agent owns src/config/env.ts). Unit tests stub fetch and assert the exact request body for (a) a plain reply with no threading, (b) a nudge reply with ReplyTo + In-Reply-To + References.

C3: harden app/api/email/inbound/route.ts per task C3: in production (NODE_ENV==='production') a missing KEEPS_INBOUND_WEBHOOK_SECRET returns 503 {error:'webhook_secret_not_configured'}; wrong header stays 401; Content-Length > 10MB returns 413 before request.json(). Add contract tests for 503/401/413/202 paths.

A6: add 'auth.clerk_user_created' and 'auth.clerk_email_verified' to auditActionEnum in src/db/schema.ts. Migration convention: pnpm db:migrate / drizzle-kit do NOT work in this repo (no journal — pre-existing). Hand-write src/db/migrations/0004_add_clerk_audit_actions.sql (ALTER TYPE ... ADD VALUE IF NOT EXISTS) and apply it via `docker exec keeps-postgres psql -U postgres -d keeps` (container running, port 55433); verify the enum labels afterward.

You own ONLY: src/email/postmark-sender.ts(+test), app/api/email/inbound/route.ts(+its tests), src/db/schema.ts (enum addition only), src/db/migrations/0004_add_clerk_audit_actions.sql. Do not touch src/config/env.ts, package.json, app/layout.tsx, src/auth/** (a parallel agent owns them). Stage with explicit `git add <paths>` only — never `git add -A`.

When done: pnpm typecheck && pnpm test pass, migration applied + verified in local PG. Commit ONLY your files: "Phase 2.6 C1+C3+A6: PostmarkSender, inbound hardening, clerk audit actions" ending with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Brief report: what changed, enum verified, deviations.
```

---

## Wave B (after Wave A commits; run B-1 and B-2 in parallel)

### Prompt B-1 — dev-stub removal + Clerk user module + page wiring

```
You are executing tasks A4, A5, and B2 from the frozen plan docs/phases/phase-2.6-auth-go-live.md for Keeps (email-first work-memory product). Working directory: /Users/aravb/Developer/keeps. Read the plan fully first — Deliverable 1 (acceptance bullets) and task B2 are your spec. Wave A is merged: @clerk/nextjs installed, ClerkProvider + middleware live, sign-up/sign-in routes exist, env schema has Clerk vars, audit enum has auth.clerk_user_created / auth.clerk_email_verified.

A4 + B2: delete src/auth/dev-session.ts and app/api/auth/start/route.ts. Replace src/auth/dev-users.ts with src/auth/clerk-users.ts exporting upsertClerkUserAndClaimInbound({ clerkUserId, email, verified }) — logic mirrors verifyDevUserAndClaimInbound: upsert users, upsert user_identities (provider='clerk', providerAccountId=clerkUserId), call claimHeldInboundEmailsForUser, keep the INNGEST_EVENT_KEY || INNGEST_DEV dispatch gate, use the new audit actions. REMOVE the inline processInboundEmailForLoops fallback (AR-1: claims always go through Inngest). Unit-test the module with the in-memory repository fakes (upserts + email.sender_verified + email.received events fire; replay is idempotent). Then `grep -rn "getDevSession\|keeps_dev_session\|devSessionCookieName\|encodeDevSession\|verifyDevUserAndClaimInbound\|dev-session\|dev-users"` across the repo and fix every hit — zero hits when done.

A5: app/page.tsx resolves the user via auth() from @clerk/nextjs/server; authenticated users are looked up via user_identities (provider='clerk', providerAccountId=clerkUserId) and their email passed to the stepper; unauthenticated users get sessionEmail={null}. In app/get-started-stepper.tsx replace the email-step POST form with a client-side handler that router.push'es to /sign-up?email_address=<typed value>. Keep visual styling identical.

You own ONLY: src/auth/** (deletes + new clerk-users.ts + tests), app/api/auth/start/** (delete), app/page.tsx, app/get-started-stepper.tsx. Do not touch src/email/**, src/workflows/**, src/config/env.ts (a parallel agent owns them). Stage with explicit `git add <paths>` only — never `git add -A`. IMPORTANT signature contract: a Wave C agent will import upsertClerkUserAndClaimInbound({ clerkUserId, email, verified }) from "@/auth/clerk-users" — keep exactly that name and shape.

When done: pnpm typecheck && pnpm test pass, the grep above is clean. Commit ONLY your files: "Phase 2.6 A4+A5+B2: Clerk replaces dev session; claim helper" ending with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Brief report: what changed, grep evidence, deviations.
```

### Prompt B-2 — sender factory + signup-URL reply + workflow wiring

```
You are executing tasks C2 and B3 from the frozen plan docs/phases/phase-2.6-auth-go-live.md for Keeps (email-first work-memory product), plus wiring the factory into the send path. Working directory: /Users/aravb/Developer/keeps. Read the plan fully first — Deliverables 3 and 4 (second bullet) are your spec. Wave A is merged: PostmarkSender exists (src/email/postmark-sender.ts, config via constructor), env schema has POSTMARK_FROM_ADDRESS / POSTMARK_REPLY_TO_DOMAIN / POSTMARK_MESSAGE_STREAM (POSTMARK_SERVER_TOKEN pre-existed).

C2: create src/email/sender-factory.ts — getEmailSender() returns a PostmarkSender constructed from getOptionalEnv() when POSTMARK_SERVER_TOKEN is set, otherwise the Phase 2.5 DevRecordingSender. Test both selections (set/unset the env var around getOptionalEnv, or inject). Then wire it: wherever the workflow send path constructs DevRecordingSender directly (check src/workflows/functions/process-email.ts and the sendNudge call sites), swap to getEmailSender(). Nothing outside this module may import PostmarkSender directly.

B3: in src/email/inbound.ts, buildUnknownSenderReply builds new URL("/sign-up", appUrl) with searchParams email_address=<sender> (Clerk's <SignUp /> prefill param). Update its tests.

You own ONLY: src/email/sender-factory.ts(+test), src/email/inbound.ts(+test), src/workflows/functions/process-email.ts and src/loops/send-nudge.ts (sender construction only). Do not touch src/auth/**, app/page.tsx, app/get-started-stepper.tsx (a parallel agent owns them); do not modify src/email/postmark-sender.ts. Stage with explicit `git add <paths>` only — never `git add -A`.

When done: pnpm typecheck && pnpm test pass. Commit ONLY your files: "Phase 2.6 C2+B3: sender factory wired into send path; Clerk signup reply URL" ending with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Brief report: what changed, where the factory got wired, deviations.
```

---

## Wave C (after Wave B commits; single agent)

### Prompt C — Clerk webhook + env docs + full gates

```
You are executing task B1 plus the D1 engineering side from the frozen plan docs/phases/phase-2.6-auth-go-live.md for Keeps (email-first work-memory product). Working directory: /Users/aravb/Developer/keeps. Read the plan fully first — Deliverable 2, task B1, the Testing section, and §D1 are your spec. Waves A and B are merged: clerk-users.ts exports upsertClerkUserAndClaimInbound({ clerkUserId, email, verified }), env schema is complete, sender factory is wired.

B1: create app/api/auth/clerk/webhook/route.ts. POST verifies via Clerk's verifyWebhook() (Svix, CLERK_WEBHOOK_SIGNING_SECRET); on failure 401. Handle:
- user.created → upsert via upsertClerkUserAndClaimInbound using the primary email address (match primary_email_address_id), verified per its verification.status; audit auth.clerk_user_created.
- user.updated → for each email_addresses[i] with verification.status==='verified', ensure identity + verified status + claim via the helper; audit auth.clerk_email_verified.
- anything else → 200 acknowledged.
Replays must be idempotent (no duplicate identities, no duplicate claims). Tests: mock verifyWebhook to return fixture payloads (raw JSON fixtures in src/auth/__tests__/fixtures/ for: new user already-verified, new user pending, existing user newly-verified second address, replay). Assert rows, audit entries, claim invocation, idempotency.

Reply-to parameterization (decision 2026-06-12 — keeps.ai not purchased; pilot replies route to Postmark's generated inbound address): replace the POSTMARK_REPLY_TO_DOMAIN env entry with POSTMARK_REPLY_TO_BASE (a full email address, default "agent@keeps.ai"). buildNudgeReplyTo(nudgeId, base) in src/email/outbound.ts splits base at "@" and returns `${local}+n_${nudgeId}@${domain}` — so base "abc123@inbound.postmarkapp.com" yields "abc123+n_<id>@inbound.postmarkapp.com". Update the sender factory, send-nudge call site, PostmarkSender constructor arg, and all tests accordingly; grep for remaining POSTMARK_REPLY_TO_DOMAIN references.

D1 engineering side: update .env.example to document the full production env matrix from §D1 — every var, one-line purpose, explicit "leave unset in local" guidance for INNGEST_EVENT_KEY and POSTMARK_SERVER_TOKEN; reflect the pilot domain decision (From keeps@basicsoftware.ai, POSTMARK_REPLY_TO_BASE = generated inbound address).

You own the whole repo this wave; keep changes minimal and within the plan. When done: pnpm typecheck && pnpm test && pnpm build pass. Also boot the local stack (pnpm dev + npx inngest-cli@latest dev -u http://localhost:3000/api/inngest; Docker Postgres keeps-postgres already running) and POST a fixture Clerk payload (with verifyWebhook mocked OR signature check bypassed via a test-only env guard — do NOT weaken prod verification) to confirm the route wires up; kill servers after. Commit in logical chunks: "Phase 2.6 B1: Clerk webhook sync + claim flow" and "Phase 2.6 D1: production env matrix in .env.example", each ending with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Report: test evidence for idempotent replay, anything in the plan's Wave A-C Exit Criteria still failing.
```

---

## Go-Live (plan Waves D + E — orchestrator + Arav together, after Wave C)

Engineering prerequisite: all three waves merged, gates green. Human prerequisite: checklist items 4–8.

1. **Local rehearsal first (no Vercel needed):** `ngrok http 3000` → point Clerk dev-instance webhook at it, complete a real sign-up (validates B1 live). Point the Postmark inbound stream's webhook at the same ngrok URL and BCC a real Gmail message to the **generated inbound address** — real email through the full pipeline before deploying anything. Set `POSTMARK_SERVER_TOKEN` locally for this rehearsal so the nudge actually lands in your Gmail inbox; reply `dismiss 1` and confirm MailboxHash populates and the loop dismisses. This is the cheapest path to the phase goal demo.
2. **D2** — apply migrations 0000–0004 to RDS by hand: `psql $DATABASE_URL -f src/db/migrations/000N_*.sql` in order (no drizzle journal). Verify with `\dt` and `\dT+`. Also cap the postgres.js pool for serverless (`max: 5` in src/db/client.ts) if not already done in Wave C.
3. **D3** — register `/api/inngest` with Inngest Cloud; confirm `process-email` appears; fire a manual `email.received` from the dashboard.
4. **D4/D5** — Clerk + Postmark webhooks pointed at the prod host (human checklist 7–8).
5. **Wave E smoke** — run the plan's staged go-live checklist (§Testing, steps 1–7) in order, stopping at first failure: deploy green → Clerk sign-up → Postmark test payload → real Gmail BCC → nudge lands threaded → `dismiss 1` resolves → unknown-sender claim path.

Exit: the plan's Exit Criteria checklist, all boxes.
