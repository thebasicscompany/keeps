# Phase 2.6: Auth and Go-Live (Clerk + Postmark + Vercel/RDS/Inngest Cloud)

> **Decision update (2026-06-12, domains):** `keeps.ai` is NOT purchased and is not a pilot blocker. Pilot email config: outbound From `keeps@basicsoftware.ai` (Arav's domain — verify in Postmark with DKIM/Return-Path; or a plain `arav@basicsoftware.ai` sender signature for the zero-DNS first test), inbound + Reply-To via Postmark's generated address `<hash>@inbound.postmarkapp.com` (plus-addressing populates MailboxHash there too — no DNS at all). App runs on `*.vercel.app` with a Clerk dev instance. Wave C parameterizes the reply-to base address (`POSTMARK_REPLY_TO_BASE`, replacing `POSTMARK_REPLY_TO_DOMAIN`) so the eventual brand domain is a pure env change. Read this plan's `agent@keeps.ai` references as the configured From/reply-to base.

> **Decision update (2026-06-12):** Neon is replaced by AWS RDS Postgres — Arav already has an SST-provisioned RDS instance and AWS credits. The app deploys to Vercel (unchanged), so the RDS instance must be publicly accessible with TLS enforced (`?sslmode=require` on `DATABASE_URL`) and a strong password; Vercel has no stable egress IPs, so the security group allows 0.0.0.0/0 on 5432 — acceptable for the pilot, revisit (RDS Proxy / private networking) in Phase 6. Cap the postgres.js pool low for serverless (e.g. `max: 5` in `src/db/client.ts`). All "Neon" references below should be read as "RDS".

Status: planned
Depends on: 2.5
Roadmap reference: `docs/roadmap.md` — "Not Yet Done", "External Setup Needed Next", "Architecture Decision Record" (Email Provider, Auth)

## Goal

When this phase is done, Keeps runs in production with real user auth and real email. Clerk owns sign-up, sign-in, sessions, and per-address email verification, and a Clerk webhook syncs into our domain `users` + `user_identities` tables. The dev-session cookie stub and `POST /api/auth/start` are gone; everything that reads the current user uses Clerk's server helpers. The pending-inbound claim flow fires from the Clerk "email verified" event rather than dev signup, and unknown-sender reply emails point at Clerk's sign-up URL with the sender email prefilled. Outbound email goes through a `PostmarkSender` implementing the Phase 2.5 `EmailSender` interface, with threading headers and `Reply-To: agent+n_<nudgeId>@keeps.ai` per AR-3. Inbound email arrives at the production webhook URL with the existing custom-header shared secret enforced as a hard requirement in prod, and Postmark inbound `MailboxHash` is confirmed to populate from plus-addressing. The app is deployed to Vercel against Neon Postgres with Inngest Cloud handling workflows; live `generateObject` extraction runs when `OPENAI_API_KEY` is present, with the deterministic fallback preserved per AR-8.

## Why Now

Phase 2.5 closed the local loop: a single Inngest processing path (AR-1), an intent router (AR-2), reply-command ordinal mapping persisted on nudges (AR-3), workflow idempotency (AR-4), and an outbound `EmailSender` interface with a dev recording transport. Everything between BCC and "nudge with Reply-To plus-address" is exercisable end to end on `localhost` and through a real Postmark inbound test fixture in CI. The only things blocking real users are: (a) authenticated sessions, (b) a live email transport, and (c) a public URL. Doing those three together unlocks the first real BCC test from Gmail, which is the smallest demo that proves the product before Phase 3 piles nudges and digests on top.

## Preconditions

- Phase 2.5 is merged: `src/email/outbound.ts` defines `EmailSender` with a `DevRecordingSender` and nudges persist `{ordinalMap, kind}` in `nudges.metadata`. If Phase 2.5 reshapes the interface, this plan adapts the `PostmarkSender` to whatever Phase 2.5 lands; treat AR-3 (Reply-To plus-addressing, `In-Reply-To`/`References`) as binding regardless.
- `pnpm typecheck`, `pnpm test`, `pnpm build` pass on `main`.
- Arav owns: the `keeps.ai` domain and DNS registrar, the Clerk account, the Postmark account, the Vercel project, the Neon project, and the Inngest Cloud account. (External-setup checklist below; this phase coordinates with those, it does not block waiting for them.)
- Decision locked: Clerk (not Better Auth, not WorkOS) for V0 auth. Single Clerk application; no organizations in V0. Email is the primary identifier; magic link is acceptable but password + email-code is fine if simpler in Clerk's defaults.

## Deliverables

1. **Clerk integration replaces the dev session.**
   - `@clerk/nextjs` is installed and `ClerkProvider` wraps the App Router root. `middleware.ts` uses `clerkMiddleware()` and marks the inbound webhook, Clerk webhook, and Inngest endpoints as public. Sign-up and sign-in routes exist at `/sign-up/[[...rest]]` and `/sign-in/[[...rest]]` using Clerk's `<SignUp />` / `<SignIn />` components.
   - Acceptance: A new user can sign up via Clerk on the deployed URL, receive Clerk's email verification, land back on `/`, and see the post-auth onboarding stepper. `getDevSession`, `encodeDevSession`, and `keeps_dev_session` no longer exist anywhere in the repo. `POST /api/auth/start` is deleted (404 from the route).
   - Acceptance: `app/page.tsx` resolves the signed-in user via `auth()` from `@clerk/nextjs/server` and passes the matching Keeps user record (looked up by `user_identities.provider='clerk'` AND `provider_account_id = clerkUserId`) to the stepper. Unauthenticated visitors see the email-entry step which links to `/sign-up`.

2. **Clerk webhook syncs users and triggers the claim flow.**
   - `POST /api/auth/clerk/webhook` verifies the request via Clerk's `verifyWebhook()` helper (Svix-backed) and handles two event families:
     - `user.created` → upsert into `users` (status `pending` if no verified email yet, `verified` if the primary email is already verified) and write a `user_identities` row with `provider='clerk'`, `providerAccountId=<clerkUserId>`, `email=<primary email address>`, `isPrimary=true`.
     - `user.updated` (which fires when an email address is verified or added) → for every `email_addresses[i]` with `verification.status === 'verified'`, ensure a `user_identities` row exists for `(provider='clerk', providerAccountId=<clerkUserId>, email=<that address>)`, mark the matching `users` row `verified`, and invoke `claimHeldInboundEmailsForUser` with `{ id: userId, email: verifiedAddress }`. (We watch `user.updated` rather than a dedicated `email.created` event because Clerk's `email.created` is for OTP/email-delivery hand-off, not address-verified state — see Risks.)
   - Acceptance: Send an email from a new address to `agent@keeps.ai` (held as pending), then sign up with that address in Clerk and verify it — the held pending row claims into `inbound_emails`, an `email.received` Inngest event fires for it, and a loop appears as if the user had signed up first. Replaying the webhook is idempotent (no duplicate identities, no duplicate claim).

3. **Unknown-sender reply points at Clerk sign-up.**
   - `buildUnknownSenderReply` in `src/email/inbound.ts` constructs `new URL("/sign-up", appUrl)` and sets `?email_address=<sender>` (Clerk's `<SignUp />` reads `email_address` from query to prefill).
   - Acceptance: An inbound email from an unknown sender produces a reply whose signup link routes through Clerk with the address prefilled, and completing sign-up + verification claims the held email (deliverable 2).

4. **`PostmarkSender` implements the Phase 2.5 `EmailSender` interface.**
   - `src/email/postmark-sender.ts` exports `PostmarkSender` constructed with `{ serverToken, fromAddress, replyToDomain, messageStream }`. It implements the `EmailSender` interface from Phase 2.5 (`send({ to, subject, textBody, htmlBody?, headers, replyTo, inReplyTo?, references? })`; the mailbox hash is not a separate field — it is derived from `replyTo`, which carries `agent+n_<nudgeId>@<replyToDomain>`). It POSTs to `https://api.postmarkapp.com/email` with header `X-Postmark-Server-Token`, JSON `{ From, To, Subject, TextBody, HtmlBody, Headers, ReplyTo, MessageStream }`, propagates `In-Reply-To` and `References` as `Headers`, and constructs `ReplyTo: agent+n_<nudgeId>@<replyToDomain>` per AR-3.
   - `src/email/sender-factory.ts` (introduced here if not in 2.5): returns `PostmarkSender` when `POSTMARK_SERVER_TOKEN` and `NODE_ENV==='production'` are set, otherwise the Phase 2.5 `DevRecordingSender`. All workflow code calls `getEmailSender()` and does not import `PostmarkSender` directly.
   - Acceptance: A unit test stubs `fetch` and asserts the exact Postmark request body for a sample nudge (correct `From`, `ReplyTo` with `n_<nudgeId>`, threading headers passed by the caller from the `outbound_emails` row). A staging smoke test against a real Postmark server token sends a private reply to the verifying engineer's inbox and confirms the reply lands threaded.

5. **Inbound webhook hardened for production.**
   - `app/api/email/inbound/route.ts` is updated so the `KEEPS_INBOUND_WEBHOOK_SECRET` check is mandatory in production (`NODE_ENV==='production'`) — if the env var is missing or the header does not match, return 401. Today the route skips the check when the env var is unset; this is a footgun in prod.
   - Payload size guard: reject payloads above 10 MB with 413 before `request.json()` (use `Content-Length` header; if absent, allow `request.json()` and catch). Postmark documents 35 MB inbound limits including attachments, but we only consume metadata so 10 MB of JSON is plenty.
   - 200-fast: the route does only verify → normalize → persist → emit `email.received` → 202 (per AR-1, already true from 2.5; we re-verify here and assert it in a contract test). No inline loop processing fallback survives.
   - Acceptance: In production, requests without the secret get 401. Requests with a 12+ MB body get 413. The route returns within 1s P95 in production logs after warm-up.

6. **Cloud deployment: Vercel + RDS + Inngest Cloud.**
   - Vercel project created from the repo, with the env matrix below set in Production and Preview environments. The Inngest endpoint `/api/inngest` is registered to the Inngest Cloud app via the Vercel integration. The Postmark inbound webhook URL points at `https://<vercel-prod-host>/api/email/inbound` with the shared-secret custom header.
   - Migrations are applied to RDS by hand once after cutover: `psql $DATABASE_URL -f src/db/migrations/000N_*.sql` in order (`pnpm db:migrate` does not work — no drizzle journal, pre-existing). CI-driven migrations are out of scope (Phase 6).
   - Acceptance: A real BCC from a Gmail account to `agent@keeps.ai` produces an `inbound_emails` row in Neon, an `email.received` event visible in Inngest Cloud, a `process-email` run that emits `email.classified` and (for capture) `loops.extracted`, persisted `loops` + `source_evidence` + pending `nudges`, and an outbound private reply that lands in the sender's Gmail inbox with `Reply-To: agent+n_<nudgeId>@keeps.ai`. Replying `dismiss 1` to that nudge resolves the loop's first ordinal.

7. **Live model extraction enabled.**
   - The `process-email` workflow currently passes `useModel: true` (verified during planning) to `processInboundEmailForLoops`. With `OPENAI_API_KEY` set on Vercel, `generateObject` runs; without it, the deterministic regex fallback runs. No code change is required if 2.5 left `useModel: true`; this deliverable is the env wiring and verification that the live model path executes end to end.
   - Acceptance: After setting `OPENAI_API_KEY`, a fresh BCC produces a model-derived loop summary (not the regex shape) and observability shows a model call with structured output matching the schema. Removing the key falls back to regex without errors.

## Data & Migrations

No new tables. No enum changes. Two data invariants to assert (no schema change needed):

- `user_identities.provider` gains a new accepted value `clerk` (the column is `text`, no enum constraint — confirmed in schema). Existing `dev_email` rows remain readable but are no longer written.
- `users.email` remains the canonical sender-email key used by the inbound pipeline. The Clerk webhook is responsible for keeping `users.email` and at least one `user_identities` row in sync for the verified primary address. If a Clerk user verifies *additional* addresses, each gets its own `user_identities` row; the inbound pipeline (`findVerifiedUserByEmail`) already checks identities before falling back to the user row, so multi-address users work for free.

Add two `audit_action` enum values via a new Drizzle migration:

- `auth.clerk_user_created`
- `auth.clerk_email_verified`

(Replacing the dev-only `auth.dev_session_created` action is left in place for historical readability; no rows are deleted.) Migration file: `src/db/migrations/000X_add_clerk_audit_actions.sql`.

## Events

No new Inngest event shapes. The existing `email.sender_verified` event (defined in `src/email/inbound.ts`) is the one the Clerk webhook handler will emit after a successful claim, identical to what dev signup emits today. Reusing it means the Phase 3 workflow code that listens for verification works unchanged whether the user came from dev or Clerk.

The Clerk webhook is *not* an Inngest event source. It runs inline in the HTTP handler (verify → upsert → claim → respond 200), so Clerk's delivery retries are the durability mechanism. Replays must be idempotent (deliverable 2).

## Task Breakdown

Tasks are grouped into waves. Within a wave, tasks touch disjoint files and can be executed by parallel agents. Between waves, run sequentially.

### Wave A — Clerk plumbing and dev-stub removal (parallelizable)

**A1. Install and wire `@clerk/nextjs`.**
- Files: `package.json`, `pnpm-lock.yaml`, `middleware.ts` (new), `app/layout.tsx`.
- Add `@clerk/nextjs` dependency. Create `middleware.ts` with `clerkMiddleware()` and a matcher that excludes `/api/email/inbound`, `/api/inngest`, `/api/auth/clerk/webhook`, and static assets. Wrap the root layout in `<ClerkProvider>`. Do not touch `app/page.tsx` (Wave B).
- Done when: `pnpm typecheck` passes and the dev server boots with Clerk's "missing keys" warning rather than crashing.

**A2. Add sign-in / sign-up routes.**
- Files: `app/sign-up/[[...rest]]/page.tsx`, `app/sign-in/[[...rest]]/page.tsx`.
- Render Clerk's `<SignUp />` and `<SignIn />` components. Pass `signInUrl="/sign-in"` and `signUpUrl="/sign-up"` and `afterSignInUrl="/"` / `afterSignUpUrl="/"`. Allow Clerk's default styling for now (visual polish is out of scope).
- Done when: `/sign-up?email_address=foo@bar.com` renders Clerk's signup form with the email prefilled.

**A3. Add env schema entries for Clerk.**
- File: `src/config/env.ts`.
- Extend `envSchema` with `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET` (all `.optional()` so local dev without Clerk still works for the inbound webhook tests). Note: `@clerk/nextjs` also reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; add that as an alias entry that mirrors `CLERK_PUBLISHABLE_KEY`.
- Done when: `pnpm typecheck` passes and tests that read `getOptionalEnv()` still pass.

**A4. Delete dev session module and `/api/auth/start`.**
- Files (delete): `src/auth/dev-session.ts`, `app/api/auth/start/route.ts`. Files (edit): `src/auth/dev-users.ts` — rename `verifyDevUserAndClaimInbound` to `verifyClerkUserAndClaimInbound` taking `{ clerkUserId, email }`, drop the `provider: 'dev_email'` identity and write `provider: 'clerk', providerAccountId: clerkUserId` instead. Update the audit action to `auth.clerk_user_created` / `user.email_verified`.
- Find all callers via `grep -rn "getDevSession\\|keeps_dev_session\\|devSessionCookieName\\|encodeDevSession\\|verifyDevUserAndClaimInbound"` and update them. As of planning, callers are: `app/page.tsx`, `app/api/auth/start/route.ts` (both deleted/replaced). Re-run grep at execution time to catch anything added between now and execution.
- Done when: the grep above returns zero hits and `pnpm test` passes.

**A5. Update `app/page.tsx` to use Clerk.**
- File: `app/page.tsx`.
- Replace `getDevSession()` with `auth()` from `@clerk/nextjs/server`. If unauthenticated, render the stepper with `sessionEmail={null}` (the existing "email" step links to `/sign-up` via the form's `action`). If authenticated, look up the Keeps user via `user_identities` (`provider='clerk', providerAccountId=<clerkUserId>`) and pass the primary email to the stepper. The "email" step's form action becomes a link to `/sign-up` (not a POST) since auth is handled by Clerk.
- File: `app/get-started-stepper.tsx`.
- Replace the email-step `<form action="/api/auth/start" method="post">` with a link to `/sign-up?email_address=<typed value>` (use a small client-side handler to capture the input and `router.push`). Keep all visual styling identical.
- Done when: signed-in users see the capture-address step; signed-out users see the email-entry step that routes to Clerk sign-up with the address prefilled.

**A6. Audit-log enum migration.**
- Files: `src/db/schema.ts`, `src/db/migrations/000X_add_clerk_audit_actions.sql` (new).
- Add `auth.clerk_user_created` and `auth.clerk_email_verified` to `auditActionEnum`. Generate the migration with `pnpm drizzle-kit generate`.
- Done when: migration applies cleanly against local Postgres and `pnpm typecheck` passes.

### Wave B — Clerk webhook + claim flow (sequential after Wave A)

**B1. Clerk webhook route.**
- File: `app/api/auth/clerk/webhook/route.ts` (new).
- POST handler verifies the request using Clerk's `verifyWebhook(request)` helper (which wraps Svix verification against `CLERK_WEBHOOK_SIGNING_SECRET`). Switch on `event.type`:
  - `user.created`: extract `data.id` (clerkUserId), `data.email_addresses` (find the one matching `data.primary_email_address_id`). Upsert `users` row (status `verified` if `verification.status === 'verified'`, else `pending`). Insert/upsert `user_identities` row with `provider='clerk'`. Write `audit_log` entry `auth.clerk_user_created`. If primary email is verified, call into the claim helper (see B2).
  - `user.updated`: for each `email_addresses[i]` with `verification.status === 'verified'`, upsert a `user_identities` row keyed on `(provider, providerAccountId)` (the existing unique index) with `email` set to that address. If any newly-verified address now exists, set `users.status='verified'` and call the claim helper for that address. Write `audit_log` `auth.clerk_email_verified`.
  - Other event types: return 200 (we acknowledge but ignore).
- Return 200 within 5s. On verification failure, return 401.
- Done when: a fixture Svix-signed payload posted to the route creates the expected `users` + `user_identities` rows; a replay of the same payload does not duplicate rows.

**B2. Extract claim helper from `dev-users.ts`.**
- File: `src/auth/clerk-users.ts` (new, replacing `src/auth/dev-users.ts`).
- Export `upsertClerkUserAndClaimInbound({ clerkUserId, email, verified })`. Logic mirrors the current `verifyDevUserAndClaimInbound`: upsert `users`, upsert `user_identities` (with `provider='clerk', providerAccountId=clerkUserId`), call `claimHeldInboundEmailsForUser`. Keep the `INNGEST_EVENT_KEY || INNGEST_DEV` dispatch gate so that local dev without Inngest still works. **Remove** the inline `processInboundEmailForLoops` fallback (it violates AR-1 — claims must always go through Inngest; local dev runs Inngest dev server).
- Done when: B1 uses this helper exclusively and `pnpm test` passes (unit tests for this module assert the upsert and the `email.sender_verified` + `email.received` events fire).

**B3. Update `buildUnknownSenderReply` for Clerk sign-up URL.**
- File: `src/email/inbound.ts`.
- Change the signup URL construction: `const signupUrl = new URL("/sign-up", appUrl); signupUrl.searchParams.set("email_address", senderEmail);` (Clerk's `<SignUp />` reads `email_address`).
- Done when: existing tests for `buildUnknownSenderReply` are updated and pass; the reply body contains a link with `/sign-up?email_address=...`.

### Wave C — Postmark sender and webhook hardening (parallelizable, independent of Wave B)

**C1. `PostmarkSender` implementation.**
- File: `src/email/postmark-sender.ts` (new).
- Exports `class PostmarkSender implements EmailSender` with constructor `{ serverToken, fromAddress, replyToDomain, messageStream }`. `send()` POSTs to `https://api.postmarkapp.com/email`. Maps the `EmailSender` interface (from Phase 2.5) onto Postmark's request body. Constructs `ReplyTo: agent+n_${nudgeId}@${replyToDomain}` per AR-3 when a nudge ID is present in the call. Forwards `In-Reply-To` / `References` as `Headers: [{ Name, Value }]`. Throws a typed `PostmarkSendError` on non-2xx with the Postmark `ErrorCode` for retry classification.
- Done when: unit test with `fetch` stubbed asserts exact request body for: (a) an unknown-sender signup reply (no nudge ID, no threading), (b) a nudge reply with nudge ID and threading headers populated.

**C2. Sender factory.**
- File: `src/email/sender-factory.ts` (new, unless 2.5 already added it — re-verify at execution).
- `getEmailSender()` returns `PostmarkSender` when `POSTMARK_SERVER_TOKEN` is set, otherwise the Phase 2.5 `DevRecordingSender`. Reads from `getOptionalEnv()`. All workflow / handler code that needs to send email imports `getEmailSender()` from this module — never `PostmarkSender` directly.
- Done when: a test asserts the factory returns `PostmarkSender` with `POSTMARK_SERVER_TOKEN` set and `DevRecordingSender` without.

**C3. Inbound webhook production hardening.**
- File: `app/api/email/inbound/route.ts`.
- Before the secret check, compute `const isProd = process.env.NODE_ENV === 'production'`. If `isProd && !env.KEEPS_INBOUND_WEBHOOK_SECRET`, return `503 { error: 'webhook_secret_not_configured' }`. If a secret is set, the existing header equality check stands. Add `if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 10 * 1024 * 1024) return 413` immediately after the secret check.
- Done when: a contract test posts to the route with `NODE_ENV='production'` and no secret → 503; with secret + wrong header → 401; with 11 MB body → 413; with valid request → 202.

**C4. Env schema entries for Postmark, Inngest Cloud, public URL.**
- File: `src/config/env.ts`.
- Add: `POSTMARK_FROM_ADDRESS` (default `agent@keeps.ai`), `POSTMARK_REPLY_TO_DOMAIN` (default `keeps.ai`), `POSTMARK_MESSAGE_STREAM` (default `outbound`). `POSTMARK_SERVER_TOKEN` already exists. `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` already exist. Confirm `NEXT_PUBLIC_APP_URL` is wired everywhere we build outbound links (it is, per `inbound.ts` and `dev-users.ts`).
- Done when: schema reflects production env shape and tests pass.

### Wave D — Cloud deployment (sequential after Waves A/B/C land on main)

This wave is human + agent collaboration. Engineering tasks are bullets; external steps live in the External Setup Checklist.

**D1. Vercel project and env matrix.**
- Files (engineering side): `vercel.json` (new, only if non-default node version or build command needed — likely none needed), `.env.example` (updated to list the full production env matrix as comments).
- Env matrix (Production env in Vercel, mirrored for Preview where it makes sense):

  | Var | Local (`.env.local`) | Preview | Production |
  | --- | --- | --- | --- |
  | `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Vercel preview URL | `https://keeps.ai` (or `https://app.keeps.ai`) |
  | `DATABASE_URL` | Docker Postgres 55433 | RDS `keeps_preview` database (same instance) | RDS `keeps` production database (`?sslmode=require`) |
  | `CLERK_PUBLISHABLE_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dev instance | Clerk dev | Clerk prod instance |
  | `CLERK_SECRET_KEY` | Clerk dev | Clerk dev | Clerk prod |
  | `CLERK_WEBHOOK_SIGNING_SECRET` | dev webhook svix secret | dev | prod webhook svix secret |
  | `POSTMARK_SERVER_TOKEN` | unset (uses dev sender) | Postmark sandbox token | Postmark live token |
  | `POSTMARK_FROM_ADDRESS` | `agent@keeps.ai` | `agent@keeps.ai` | `agent@keeps.ai` |
  | `POSTMARK_REPLY_TO_DOMAIN` | `keeps.ai` | `keeps.ai` | `keeps.ai` |
  | `KEEPS_INBOUND_WEBHOOK_SECRET` | local random | preview-only random | prod random (32+ chars) |
  | `INNGEST_EVENT_KEY` | unset (uses dev server) | Inngest cloud preview key | Inngest cloud prod key |
  | `INNGEST_SIGNING_KEY` | unset | Inngest signing key | Inngest signing key |
  | `INNGEST_DEV` | `1` | unset | unset |
  | `OPENAI_API_KEY` | optional | optional | set |
  | `OPENAI_MODEL` | `gpt-5.1` | `gpt-5.1` | `gpt-5.1` |

- Done when: `.env.example` documents every var with a one-line "what it's for" and explicit "leave unset in local" guidance for `INNGEST_EVENT_KEY` and `POSTMARK_SERVER_TOKEN`.

**D2. Run migrations against RDS.**
- Human-first task: make the RDS instance publicly accessible (or confirm it is), enforce TLS, set a strong password, and create the `keeps` database. Engineering task: apply `src/db/migrations/0000–000N` in order via `psql $DATABASE_URL -f ...`. Verify all enums and tables exist via `psql \dt` and `\dT+`.
- Done when: a `SELECT 1 FROM users LIMIT 1;` against RDS prod returns without error and all migrations through the Wave A audit-action migration have been applied.

**D3. Register `/api/inngest` with Inngest Cloud.**
- Engineering task: in Inngest Cloud, create an app named `keeps` pointed at `https://<prod-host>/api/inngest`. Inngest will fetch the function manifest. Confirm `process-email` registers.
- Done when: a manual event `email.received` sent from the Inngest Cloud dashboard with a real `inboundEmailId` triggers a `process-email` run that succeeds (or fails with a legible error, not a 500 from missing env).

**D4. Configure Clerk webhook endpoint.**
- Engineering task: in Clerk dashboard → Webhooks → add `https://<prod-host>/api/auth/clerk/webhook`, subscribe to `user.created` and `user.updated`. Copy the signing secret into Vercel as `CLERK_WEBHOOK_SIGNING_SECRET`. Send a test event from the Clerk dashboard and confirm it returns 200.
- Done when: a test `user.created` event from Clerk results in a row in `users` and `user_identities` on Neon prod.

**D5. Configure Postmark.**
- Engineering task: in Postmark, create a Server (call it `keeps-prod`). Note the server token. For outbound: confirm From signature for `agent@keeps.ai` is verified (DNS in External Setup). For inbound: use Postmark's generated inbound address first (`<hash>@inbound.postmarkapp.com`) and configure the inbound webhook URL `https://<prod-host>/api/email/inbound` with a custom HTTP header `X-Keeps-Webhook-Secret: <KEEPS_INBOUND_WEBHOOK_SECRET>`. Verified via search: Postmark also supports basic auth via `https://user:pass@host/path` — recommend enabling that *in addition* to the custom header in production once the URL is stable, but the custom header alone is acceptable for go-live.
- Done when: a test send from Postmark's inbound test tool produces an `inbound_emails` row in Neon, an Inngest run, and a private reply lands in the test sender's inbox.

### Wave E — Verification (sequential, gates exit)

**E1. End-to-end live smoke.**
- Send a BCC from a personal Gmail to `agent@keeps.ai`. Verify the chain in deliverable 6's acceptance.

**E2. Claim-on-verify smoke.**
- From a new address (not yet a Keeps user), email `agent@keeps.ai`. Confirm `pending_inbound_emails` has the row with `status='pending'`. Sign up to Clerk with that address. After verification, confirm: `pending_inbound_emails.status='claimed'`, `inbound_emails` has the row, Inngest ran, a loop exists.

**E3. Reply-command smoke.**
- Reply `dismiss 1` to the nudge. Confirm Postmark inbound delivers it back to the webhook, `MailboxHash` populates with `n_<nudgeId>` (verified externally — Postmark documents this behavior), reply-command resolves ordinal 1 against the stored nudge metadata, and the loop's status flips to `dismissed`.

## Testing

### What can be tested without live services

- **`PostmarkSender` request shape** — stub `fetch`, assert the exact JSON body and headers for: (a) plain transactional email (no nudge ID), (b) nudge reply with `Reply-To: agent+n_<id>@keeps.ai` and `Headers: [{Name: 'In-Reply-To', Value: '...'}, {Name: 'References', Value: '...'}]`. Fixture lives in `src/email/__tests__/postmark-sender.test.ts`.
- **Clerk webhook handler** — generate Svix-signed test payloads (Svix exposes a test utility; if too heavy, mock `verifyWebhook` to return the payload). Assert: `user.created` upserts user + identity + audit; `user.updated` with newly-verified address calls the claim helper; replay does not duplicate. Fixtures: `src/auth/__tests__/clerk-webhook.test.ts` plus raw payload JSON in `src/auth/__tests__/fixtures/` (one for each of: new user already-verified, new user pending, existing user newly-verified second address).
- **Sender factory** — assert `POSTMARK_SERVER_TOKEN` selects Postmark; absence selects dev recording.
- **Inbound webhook hardening** — contract tests for 401/413/503 paths as in C3.
- **Sign-up URL builder** — assert `buildUnknownSenderReply` produces a URL containing `/sign-up?email_address=`.
- **Claim helper** — unit test `upsertClerkUserAndClaimInbound` with the existing in-memory `InboundEmailRepository` fake from Phase 1.

Local "almost-live" rehearsal:

- Run `ngrok http 3000` against the local Next.js dev server, point a Clerk dev instance's webhook at the ngrok URL, and complete a sign-up. This validates Wave B without Vercel.
- Use Postmark's "Check" feature on the inbound stream to POST a sample payload at the ngrok URL with the custom header.

### Staged go-live smoke checklist (the human runs this after Wave D)

In order, with the bare minimum that must be true at each step. Stop at the first failure.

1. **Vercel deploys green.** `pnpm build` runs on Vercel, deployment URL serves `/` with the unauthenticated stepper.
2. **Clerk sign-up works.** Hit `/sign-up`, complete email + verification, land on `/` signed in. `users` and `user_identities` rows exist in Neon.
3. **Postmark inbound reaches the webhook (test payload).** From Postmark's inbound test tool, POST a sample to `/api/email/inbound`. Returns 202, `inbound_emails` row appears (for the signed-up email), Inngest run visible.
4. **Real BCC from Gmail → loop.** BCC `agent@keeps.ai` on an email containing a clear commitment ("I'll send the deck Friday"). Inngest `process-email` succeeds, a `loops` row appears with the model-derived summary.
5. **Nudge email lands.** A pending nudge generated by the loop sends through `PostmarkSender` and arrives in the BCC sender's Gmail inbox. Headers show `Reply-To: agent+n_<nudgeId>@keeps.ai` and `In-Reply-To` referencing the original BCC's message ID.
6. **Reply `dismiss 1` resolves the loop.** Reply to the nudge with `dismiss 1`. Postmark inbound delivers back to the webhook. `MailboxHash` carries the nudge ID. The loop's `status` flips to `dismissed`, `loop_events` records the dismissal.
7. **Unknown-sender claim path.** From a second email (not yet a Keeps user), BCC `agent@keeps.ai`. `pending_inbound_emails` row appears. Sign up to Clerk with that address; after verification, the held row claims into `inbound_emails`, a loop appears, a nudge sends to the new user.

If any of steps 4–7 fails, the phase is not done; debug and re-run from the failing step.

## Risks & Open Questions

- **Clerk event names for verification.** Verified via WebFetch/WebSearch: `user.created` and `user.updated` are real. Clerk also exposes `email.created` but that is for OTP/code email delivery (lets you handle email sending yourself), not for "an email address became verified." Recommended default: watch `user.updated` and inspect `email_addresses[*].verification.status === 'verified'`. If during execution we discover a dedicated `email_address.verified` event in the Event Catalog, switch to it (simpler) and update this plan inline.
- **Postmark inbound auth.** Verified: Postmark supports basic auth in the URL (`https://user:pass@host`) and custom headers (up to 30). It does not support HMAC signing of inbound. Recommended default: enforce the custom header `X-Keeps-Webhook-Secret` (already implemented), and add basic auth in the URL as belt-and-suspenders before opening up beyond pilots.
- **DNS — start with Postmark's generated inbound address.** Recommended default per the task description: do not block go-live on `MX in.keeps.ai → inbound.postmarkapp.com`. Use Postmark's generated `<hash>@inbound.postmarkapp.com` first; forward `agent@keeps.ai` to that address via the registrar's email-forwarding feature, or via a tiny inbound forwarder, depending on what Arav's DNS setup supports cheapest. Cut over to a real `MX in.keeps.ai` once Phase 2.6 is shipped and the address is durable. Outbound DKIM and Return-Path on `keeps.ai` must be set day one or Gmail will spam-fold nudges.
- **MailboxHash and plus-addressing.** Verified externally that Postmark Inbound splits a `+hash` from the local part into `MailboxHash`. AR-3's `Reply-To: agent+n_<nudgeId>@keeps.ai` will populate `MailboxHash = n_<nudgeId>` on reply. Confirm in E3 with a real reply; if for any reason it does not (e.g., Gmail rewrites the Reply-To), fall back to embedding the nudge ID in the subject as `[n_<id>]` and parsing it server-side. Recommended default: stick with `MailboxHash`; subject fallback is a quick patch if needed.
- **Webhook idempotency across providers.** Clerk's Svix delivery is at-least-once; the upsert path in B1/B2 handles duplicates. Postmark's inbound is also at-least-once and we already dedupe on `(provider, providerMessageId)`. Two independent sources of replay protection; no new work.
- **Migrations against RDS.** Run manually, locally, with `DATABASE_URL` pointing at RDS (hand-applied SQL via psql; no drizzle journal). CI-driven migrations are not in this phase; track in Phase 6.
- **Publicly accessible RDS.** Vercel functions have no stable egress IPs, so the security group is open on 5432 with TLS enforced. Mitigations now: strong password, `sslmode=require`, low pool max in `src/db/client.ts`. Revisit with RDS Proxy or Vercel Secure Compute in Phase 6.
- **`useModel: true` in `process-email`.** Phase 2.5 should have left this true; if not, flip it on as part of D1/D2 verification. Without `OPENAI_API_KEY` the code path falls back to regex — safe default.
- **Out-of-scope: subdomain routing.** No `arav@keeps.ai` personal aliases. Single inbound address `agent@keeps.ai`.

## Out of Scope

- Organizations / multi-tenant Clerk (V0 is individual-first).
- Better Auth / WorkOS evaluation. Locked decision.
- DNS automation. Records are placed by Arav by hand in this phase.
- CI-driven migrations and preview-branch DB seeding. Phase 6.
- A dashboard surface beyond the existing onboarding stepper.
- Outbound email batching or scheduled sends. Phase 3 cron sweep owns nudge scheduling.
- Email deliverability monitoring tooling beyond Postmark's built-in dashboards. Phase 6.
- Slack/Calendar connectors. Phase 4.
- Dead-letter queue, retention controls, eval suite. Phase 6.
- Generated reports / signed expiring view links. Phase 5.

## Exit Criteria

- [x] All Wave A tasks merged: dev session module is gone (grep clean), Clerk middleware/provider live, sign-in / sign-up pages render, env schema has Clerk vars, audit-action migration applied.
- [x] All Wave B tasks merged: `POST /api/auth/clerk/webhook` verifies Svix signatures, handles `user.created` and `user.updated`, upserts users + identities, triggers `claimHeldInboundEmailsForUser`, and is idempotent on replay.
- [x] All Wave C tasks merged: `PostmarkSender` passes its unit-test contract; sender factory returns Postmark in prod and dev recorder otherwise; inbound webhook returns 503 if secret missing in prod, 401 on wrong secret, 413 on oversized body.
- [x] Wave D complete: Vercel + RDS + Inngest Cloud + Clerk + Postmark all configured with the documented env matrix.
- [x] Wave E smoke checklist passes end to end: real email → loop with model summary → nudge email with correct `Reply-To` and threading headers → `dismiss 1` reply → loop dismissed.
- [ ] Unknown-sender claim path verified live: BCC from new address → pending row → Clerk sign-up + verify → claim → loop + nudge for the new user. **(DEFERRED 2026-06-12 — needs a second non-user address; everything it depends on is verified.)**
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass on `main`.
- [x] `docs/roadmap.md` "Not Yet Done" items related to auth, inbound webhook URL, outbound delivery, and Inngest cloud keys are checked off.

### Go-live verification — 2026-06-12

Production URL: `https://keeps-ivory.vercel.app` (Vercel project `arav-bhardwajs-projects/keeps`).

Infra provisioned this session:
- **DB:** dedicated RDS `keeps-prod` (Postgres 17.9, `db.t4g.micro`, 20 GB gp3, default VPC, publicly accessible + `sslmode=require`, SG `sg-047e0078ebfab57e5` open on 5432). Migrations 0000–0004 applied by hand via `psql` (`loop_status`=8, `audit_action`=16 verified). *Created under AWS root creds — make a dedicated IAM user before further AWS work.*
- **Env:** 14 prod vars set. Inngest keys auto-injected by the Vercel↔Inngest integration. Postmark token reused (not rotated — owner's call).

Smoke evidence (steps 1–6 PASS):
1. `GET /` 200 (stepper) · no-secret inbound → 401 · valid-secret 11 MB body → 413.
2. Clerk sign-up `arav@basicsoftware.ai` → `users`(verified) + `user_identities`(clerk) + `auth.clerk_user_created/_email_verified`.
3. Synthetic Postmark payload → 202 `sender_unknown` → `pending_inbound_emails` row; Inngest accepted the event (event key valid).
4. Real email → `inbound_emails` + `email.received` → `process-email` → **2 loops** (`open`/`commitment`, conf 0.96/0.90, due-date parsed).
5. Nudge **sent** via Postmark (`provider_message_id` returned, plus-routed `Reply-To`), landed in inbox.
6. `dismiss 1` reply → loop `dismissed` + `loop_events.dismissed` + `loop.updated` + confirmation email.

**Two issues found and fixed during go-live (runbook notes):**
- **Inngest functions weren't registered.** The Vercel↔Inngest integration's auto-sync did not register `process-email` against the live endpoint, so `email.received` events created no runs (silent — event accepted, no invocation). Fixed by an explicit sync to the **stable alias**: `inngest-cli api --prod sync-app keeps --url https://keeps-ivory.vercel.app/api/inngest`. Re-run this after any deploy if runs stop appearing.
- **Loop extraction 400'd on every model call.** OpenAI strict Structured Outputs (gpt-5.1, `/v1/responses`) rejected `KeepsLoopExtraction` because `loopCandidateSchema`'s five `.default()` fields were emitted as non-required. Fixed in `src/agent/schemas.ts` (commit `77717a3`) — all fields now required, optionality via `.nullable()`. Verified live against the OpenAI API.
