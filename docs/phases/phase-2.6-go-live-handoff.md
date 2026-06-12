# Phase 2.6 Go-Live Handoff (Wave D + E)

One agent prompt. Launch with a fresh session (Sonnet is sufficient — ops + smoke checklist):

```sh
cd /Users/aravb/Developer/keeps && claude --model claude-sonnet-4-6
```

---

## Prompt

```
You are finishing Phase 2.6 (go-live) for Keeps, an email-first work-memory product. Working directory: /Users/aravb/Developer/keeps. Ground truth: docs/phases/phase-2.6-auth-go-live.md (read the decision banners at top), docs/phases/phase-2.6-handoffs.md (Go-Live section), git log. Engineering Waves A–C are merged and live-verified: the full email round trip (real inbound via Postmark generated address → loop → real nudge → "dismiss 1" reply → loop dismissed) already ran successfully through a local cloudflared rehearsal on 2026-06-12. Your job is Wave D (cloud deploy) + Wave E (live smoke), collaborating with Arav for dashboard-only steps.

CURRENT STATE (verified 2026-06-12, do not re-derive):
- Vercel CLI installed and authed (user: abharw). Project ALREADY linked: arav-bhardwajs-projects/keeps (.vercel/ in repo, gitignored).
- Inngest Cloud: Arav has an account, mid-onboarding at "Connect Inngest to Vercel". When the Vercel env is otherwise ready, have him click it and select the keeps project — the integration auto-injects INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY into Vercel env (do NOT set those by hand; verify they appear).
- AWS CLI configured on this machine (root creds — flag to Arav to make an IAM user later, don't block on it).
- DATABASE DECISION IS PENDING — ask Arav FIRST (see below), everything else can proceed in parallel.
- RDS findings (already investigated, trust these): SST instance operator-hq-dev-databaseinstance-tdcumuun (postgres 17.9, db.t4g.micro, us-east-1, master user operator_hq) is PRIVATE BY DESIGN — its subnets (subnet-0df7e60334b9ee4e1, subnet-0acc8f3264de4348e) ride the VPC main route table which has NO internet-gateway route. Flipping PubliclyAccessible alone will NOT work. The VPC (vpc-0e06ade1f984847b0) does have an IGW (igw-043f83bc3ab6d30b0) and public route tables (rtb-01730ea7308c7fa91, rtb-0bd58e16087bd8125). A default VPC also exists: vpc-0762d3c74c555d9c0.
- Local secrets live in .env.local (Clerk dev-instance keys, Postmark server token — token is ACTIVE there from the rehearsal). Postmark inbound address: c2e77520ab75754b699524acf16f5fd2@inbound.postmarkapp.com. From address for pilot: arav@basicsoftware.ai (keeps@basicsoftware.ai once the domain DKIM verifies in Postmark).
- Postmark inbound webhook currently points at a DEAD ephemeral cloudflared URL — you will repoint it to prod.
- Background processes may still be running from the rehearsal (next dev, inngest-cli dev, cloudflared) — kill them; they're not needed for deploy.

STEP 0 — ask Arav the pending DB question (one question, then proceed):
  (a) New dedicated RDS db.t4g.micro Postgres for Keeps in the default VPC, publicly accessible + TLS, SG open on 5432 (Vercel has no stable egress IPs), ~$12–15/mo on credits — RECOMMENDED, zero SST entanglement;
  (b) make the SST operator-hq dev instance public (requires moving it to public subnets — fights SST state, NOT recommended, get explicit confirmation twice before touching);
  (c) Neon free tier (0.5GB, zero cost, no AWS work).
  Implement whichever he picks. For (a): create a DB subnet group from default-VPC subnets, a dedicated security group (5432 from 0.0.0.0/0), instance with --publicly-accessible, generate a strong master password yourself (do not reuse anything), engine postgres 17, allocate 20GB gp3. Wait for available, then create database "keeps".

STEP 1 — migrations: apply src/db/migrations/0000…0004 IN ORDER via psql against the new DATABASE_URL (append ?sslmode=require). pnpm db:migrate does NOT work in this repo (no drizzle journal — known, do not fix). Verify with \dt and \dT+ (loop_status must have 8 labels; audit_action 16).

STEP 2 — Vercel env (Production), via `vercel env add <NAME> production`:
  NEXT_PUBLIC_APP_URL = the prod URL (set after first deploy, then redeploy)
  DATABASE_URL = from step 0/1, with ?sslmode=require
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY = copy values from .env.local (Clerk dev instance is fine for the pilot)
  CLERK_WEBHOOK_SIGNING_SECRET = set in step 4
  KEEPS_INBOUND_WEBHOOK_SECRET = GENERATE A FRESH 32+ char random value (do not reuse the local one)
  POSTMARK_SERVER_TOKEN = from .env.local — but FIRST tell Arav to rotate the token in Postmark (Settings → API Tokens; the old one leaked into a chat transcript) and use the NEW value
  POSTMARK_FROM_ADDRESS = arav@basicsoftware.ai
  POSTMARK_REPLY_TO_BASE = c2e77520ab75754b699524acf16f5fd2@inbound.postmarkapp.com
  POSTMARK_MESSAGE_STREAM = outbound
  OPENAI_API_KEY / OPENAI_MODEL (gpt-5.1) — ask Arav for a key; without it extraction falls back to regex (works, but Deliverable 7 wants the model path verified)
  Leave INNGEST_DEV unset. INNGEST_EVENT_KEY/SIGNING_KEY come from the Inngest Vercel integration (verify present after Arav connects it).

STEP 3 — deploy: pnpm typecheck && pnpm test && pnpm build locally first (must be green; 83+ tests). Then `vercel deploy --prod`. Set NEXT_PUBLIC_APP_URL to the resulting URL and redeploy. Verify: GET / serves the unauthenticated stepper; POST /api/email/inbound with no secret → 401 (secret IS configured) and with an 11MB content-length → 413.

STEP 4 — webhooks (Arav does dashboards, you verify):
  a. Inngest: Arav clicks "Connect Inngest to Vercel", selects keeps. Then in Inngest Cloud confirm the app synced and process-email is registered. Fire a test email.received from the dashboard with a real inboundEmailId from the prod DB (there won't be one yet — do this after the first smoke email instead).
  b. Clerk: Arav adds webhook endpoint https://<prod-host>/api/auth/clerk/webhook subscribed to user.created + user.updated, gives you the signing secret → vercel env add CLERK_WEBHOOK_SIGNING_SECRET production → redeploy. Send a test user.created from the Clerk dashboard → expect 200 and rows in prod users/user_identities.
  c. Postmark: Arav (or you, telling him exactly what to paste) repoints the inbound stream webhook URL to https://keeps:<NEW_KEEPS_INBOUND_WEBHOOK_SECRET>@<prod-host>/api/email/inbound — the route accepts the secret as a basic-auth password (Postmark's UI has no custom-header field; this is already implemented and tested).

STEP 5 — Wave E smoke (plan §Testing "Staged go-live checklist", stop at first failure, fix, re-run):
  1. Deploy green, / serves stepper. 2. Clerk sign-up works end to end. 3. Postmark test payload → 202 → prod inbound_emails row → Inngest Cloud run visible. 4. Real email from arav@basicsoftware.ai to the inbound address → loop row in prod DB. 5. Nudge lands in his inbox (From arav@basicsoftware.ai; if Postmark account approval has cleared, also test from Gmail — check approval status, sandbox restricts recipients to verified-signature domains). 6. Reply "dismiss 1" → loop dismissed, loop_events row, confirmation email. 7. Claim path: from an address that is NOT a user, email the inbound address → pending_inbound_emails row → sign up via Clerk with that address + verify → row claims, loop appears, nudge sends.

STEP 6 — cleanup + close-out: re-comment POSTMARK_SERVER_TOKEN in .env.local (local dev must use the dev recording sender). Update the Exit Criteria checkboxes in docs/phases/phase-2.6-auth-go-live.md (and roadmap "Not Yet Done" items it covers). Commit docs + any code fixes atomically as you go ("Phase 2.6 D/E: …", ending with "Co-Authored-By: Claude <noreply@anthropic.com>"). Report: each smoke step pass/fail with evidence, anything deferred.

Working style: act, don't ask, for reversible engineering steps; ask Arav before creating AWS resources (step 0), before anything destructive, and for all dashboard actions. Never print secret values into the chat or commit them. If a smoke step fails, debug it yourself (vercel logs, Inngest Cloud run logs, psql) before involving Arav.
```
