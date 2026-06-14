# Keeps — Engineer Onboarding & Handoff

Welcome. This doc gets you from `git clone` to a running app + green test suite, explains the architecture, and points you at the active work (Phase 7 "Context Engine"). Read it top-to-bottom once; it's ~15 minutes.

> **TL;DR:** pnpm monorepo-less Next.js (App Router) app. Postgres (AWS RDS in prod, Docker locally on `:55433`). Background work via Inngest. LLM extraction via OpenAI. Email in/out via Postmark. Auth via Clerk. Connectors (Slack/Calendar) via Composio. Deployed on Vercel. Secrets via Doppler. Migrations are **hand-written SQL** (drizzle-kit is disabled by design).

---

## 1. What Keeps is

Keeps turns the email you CC into tracked **commitments** ("loops") and nudges you about them. Capture → extract loops (LLM) → nudge/digest → approve → act (Slack DM / Calendar event) → recall ("what are my insights?" → a ranked memo). It's a single-user product today (alpha), live at **https://keeps.email**.

Phases 0–6 are **done and in production**. You're joining mid **Phase 7 — Context Engine**, which promotes people/companies to first-class **entities** and makes extraction **context-aware** (reconcile an existing loop instead of always creating a new one). See §6.

---

## 2. Prerequisites

- **Node 24+** (repo is developed on 25.x), **pnpm 10+** (`corepack enable` or `npm i -g pnpm`).
- **Docker** (for local Postgres).
- **Doppler CLI** (`brew install dopplerhq/cli/doppler`) — secrets manager; see §4.
- **psql** client. On macOS: `/opt/homebrew/opt/libpq/bin/psql` (libpq keg).
- Access (ask Arav to invite you): the **GitHub repo**, the **Doppler `keeps` project**, and optionally the **Vercel project** + **Postmark/Composio/Clerk** dashboards.

---

## 3. Local setup (clone → running app)

```bash
git clone <repo-url> keeps && cd keeps
pnpm install

# 1. Start local Postgres (container named keeps-postgres on :55433)
docker run -d --name keeps-postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=keeps \
  -p 55433:5432 postgres:16

# 2. Apply ALL migrations in order (hand-written SQL — see §5). One-liner:
PSQL=/opt/homebrew/opt/libpq/bin/psql
URL=postgres://postgres:postgres@localhost:55433/keeps
for f in src/db/migrations/0*.sql; do echo "applying $f"; $PSQL "$URL" -v ON_ERROR_STOP=1 -f "$f"; done

# 3. Secrets: pull dev env from Doppler (see §4) OR copy .env.example → .env.local
doppler run --project keeps --config dev -- pnpm dev
# ...or, with a local .env.local:
pnpm dev   # http://localhost:3000
```

### Running the test suite

Tests run in the **Node** vitest env (no jsdom). Most are pure; DB-backed tests are **gated** on `TEST_DATABASE_URL` and skipped without it.

```bash
# Pure tests only (no DB, no API keys — this is what CI-by-default runs):
pnpm test

# Full suite incl. DB-gated integration tests (needs local Postgres up + migrated):
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps pnpm exec vitest run src app

# Typecheck + build (the deploy gate):
pnpm typecheck && pnpm build
```

The default run has **no `OPENAI_API_KEY` and no `DATABASE_URL`** — every model code path has a deterministic no-creds fallback, and `getDb()` throws if `DATABASE_URL` is unset (so it's never called at module top level). ~1380 tests should be green.

### LLM eval harness

```bash
pnpm eval            # deterministic matcher over synthetic cases; gates precision/recall
```

---

## 4. Secrets (Doppler)

All env config lives in **Doppler**, project **`keeps`**, configs: `dev` (you), `stg`, `prd` (production). The production source of truth is mirrored from Vercel.

```bash
doppler login
doppler setup --project keeps --config dev          # links this dir to the dev config
doppler run -- pnpm dev                              # injects secrets into the process
doppler secrets --only-names                         # list keys (never prints values)
```

`src/config/env.ts` is the canonical schema of every variable (all `.optional()` with sane defaults, so the app degrades gracefully when a key is absent). The keys you'll care about for Phase 7 work specifically: `DATABASE_URL` (local: `postgres://postgres:postgres@localhost:55433/keeps`) and `OPENAI_API_KEY` (only needed to exercise live model paths — tests don't need it). Everything else (Clerk, Postmark, Composio, Inngest, Sentry) is needed for the full app but not for entity/extraction unit work.

### What's already in `keeps/dev` (provisioned for you)

`doppler run --project keeps --config dev -- …` already injects these working values:
`DATABASE_URL` (→ **local** `:55433`, deliberately — see the warning below), `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `OPENAI_MODEL`, `INNGEST_DEV`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `KEEPS_DEV_AUTH_SECRET`, `KEEPS_INBOUND_WEBHOOK_SECRET`, `POSTMARK_FROM_ADDRESS`, `POSTMARK_REPLY_TO_BASE`, `POSTMARK_MESSAGE_STREAM`.

> ⚠️ **`DATABASE_URL` in `keeps/dev` points at your LOCAL Postgres on purpose.** The DB-gated tests CREATE and DELETE rows; pointing them at the prod database would corrupt production. Prod runs on **AWS RDS** (`keeps-prod.…us-east-1.rds.amazonaws.com`, `us-east-1`); only the lead applies prod migrations / runs the backfill there, by hand. Don't repoint your dev `DATABASE_URL` at prod.

### Keys you must add yourself (vaulted — not auto-provisioned)

These are stored "Sensitive" in Vercel prod and can't be exported programmatically, so they're **not** in `keeps/dev` yet. You're in the same Vercel org, so the source of truth is the **Vercel project `arav-bhardwajs-projects/keeps`** → Settings → Environment Variables (Production) — read the values there (or ask Arav), then `doppler secrets set <KEY> --project keeps --config dev`:
`OPENAI_API_KEY` (live LLM — tests don't need it), `POSTMARK_SERVER_TOKEN` (sending email), `CLERK_WEBHOOK_SIGNING_SECRET`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET`, `COMPOSIO_SLACK_AUTH_CONFIG_ID`, `COMPOSIO_GCAL_AUTH_CONFIG_ID`, `KEEPS_ADMIN_PROBE_SECRET`. (`COMPOSIO_*_TOOLKIT_VERSION` have code defaults; override only to bump.) **You can do all Phase-7 entity/extraction work — incl. the full DB-gated test suite — with zero of these**, since model paths have deterministic fallbacks; add `OPENAI_API_KEY` only when you want to exercise live extraction.

**Never** echo a secret value in a shell/log/PR. Prod `DATABASE_URL` once leaked via a redaction miss — treat all values as toxic.

---

## 5. Database & migrations (READ THIS — it's not standard Drizzle)

- DB is **AWS RDS Postgres** in prod. There is **no Drizzle journal** — `pnpm db:migrate` / `db:generate` are **broken by design**. Do not run them.
- Migrations are **hand-written, sequential, idempotent SQL** in `src/db/migrations/` (`0000` … `0018`). The Drizzle schema in `src/db/schema.ts` is kept as a **hand-maintained mirror** (used for the query builder + types, not migration generation).
- **Writing a new migration:** next number is **`0019`**.
  - New TABLES / new ENUM TYPES → copy the `0008`/`0015` style: `CREATE TYPE` inside a `DO $$ … duplicate_object` guard + `CREATE TABLE/INDEX IF NOT EXISTS`. Mirror the table in `schema.ts` and export its `$inferSelect`/`$inferInsert` types.
  - **ENUM-VALUE additions** to an existing type → copy `0009`/`0016`: `ALTER TYPE … ADD VALUE IF NOT EXISTS`, in their **own separate file**, because `ADD VALUE` **cannot run inside a transaction**.
  - Prove idempotency: apply your migration to local **twice**; the second run must only emit "already exists, skipping" NOTICEs, no errors.
- **Prod migrations are applied by hand via `psql`** (the orchestrator/lead does this during the ops step), using the prod `DATABASE_URL` from `doppler secrets get DATABASE_URL --project keeps --config prd --plain` (never echo it).

---

## 6. Phase 7 — Context Engine (the active sprint)

**The plan + full context:** `docs/phases/phase-7-context-engine-plan.md`. Read §4 (invariants), §5 (repo realities), §6 (waves), and **§6b (adversarial-audit refinements — these are binding decisions)**.

**The one-sentence goal:** make CC'ing more email make the assistant *smarter*, not just *longer* — capture promotes people/companies to entities, extraction reconciles against scoped open loops instead of always creating new, replies advance/close the matching loop, recall synthesizes an entity's true status.

**The cardinal invariant:** **NO FALSE MERGE.** Collapsing two distinct commitments (or people) is a silent, destructive precision failure — far worse than a duplicate (a visible, recoverable recall failure). The model **proposes**; deterministic code **disposes** (AR-8). Every reconciliation routes through `mutateLoopState(...)` (`src/loops/service.ts`) and writes a `loop_event` (AR-9 provenance).

### What's already shipped (on `main`, green)

| Wave | What | Key files |
|------|------|-----------|
| 0 | Entity schema — `entities`, `loop_entities`, `loops.owner/requester_entity_id`, `entity_kind`/`loop_entity_role` enums | `src/db/migrations/0018_phase7_entities.sql`, `src/db/schema.ts` |
| A1 | Conservative resolver — find-or-create by normalized exact email; name is an alias never a join key; role mailboxes → kind `other`; company = domain − freemail (+punycode flag); reversible merge tombstone | `src/entities/resolve.ts` (+ `.test.ts`, `.db.test.ts`) |
| A3 | Link entities into capture (**post-commit best-effort** — a linking error never rolls back a loop) | `src/entities/link.ts`, `src/loops/repository.ts` |
| A2 | Idempotent backfill for existing loops (reuses `linkLoopEntities`) | `scripts/backfill-entities.ts` |

An adversarial Codex audit ran after Wave A and (a) caught + fixed two real false-merge edges in the resolver, (b) produced design refinements now recorded in **plan §6b**. Don't re-litigate those.

### What's next (Wave B — the core, review-hardest)

- **B3** `loadExtractionContext(...)` — scoped candidate loops + known entities. Per §6b: union **multiple** candidate generators (same-thread + same-entity + trigram/full-text over summary & counterparty), cap **after** scoring.
- **B1** make `extractLoops` context-aware — inject the scoped candidates; output gains FLAT, all-required-nullable reconciliation fields (`reconcilesLoopId`, `reconcileAction`, `reconcileConfidence`, `reconcileEvidence`); **strict OpenAI structured outputs** (no `.optional()`/`.default()`/nested unions — a violation caused a prod outage). Two-step anti-anchoring prompt. Deterministic fallback **never** reconciles.
- **B2** `src/agent/reconcile.ts` — the **three-band decider + apply**. Bands key **structurally first** (same thread / `In-Reply-To` / same entity / due-date / quoted commitment); LLM confidence is a weak secondary feature. HIGH+corroboration → auto-reconcile via `mutateLoopState`; LOW → create-new; **uncertain middle → create a SUPPRESSED duplicate (no nudges) + ask on the private-reply channel** (Arav's decision — email is the only UI, so a visible "duplicate" open loop just spams nudges). Auto-`close` is gated stricter than `update`.

Then **Wave C** (entity synthesis recall + entity views), **Wave D** (reconciliation eval incl. a **false-merge-rate hard gate** + **candidate-recall** metric; provenance/admin), then ops (prod migrate + backfill + deploy + live UAT).

---

## 7. Architecture map (where things live)

```
app/                     Next.js App Router (routes, /r/<token> report pages, /admin/*, /api/*)
src/
  agent/                 LLM layer — extract-loops.ts, classify-intent.ts, schemas.ts (Zod),
                         instrumented-generate-object.ts (every model call is logged), eval/
  config/env.ts          the canonical env schema (Zod)
  connectors/            Composio (Slack DM, Calendar) integration
  db/
    client.ts            getDb() — never call at module top level
    schema.ts            hand-maintained Drizzle mirror of the SQL migrations
    migrations/          hand-written sequential idempotent SQL (0000…0018; next is 0019)
  email/                 Postmark normalize/send, body extraction, HTML button renderer
  entities/              Phase 7 — resolve.ts (resolver), link.ts (loop↔entity linking)
  loops/                 service.ts (mutateLoopState = the single mutation funnel),
                         repository.ts (DB-injectable: constructor(db?) defaults to getDb()),
                         commands.ts, send-nudge.ts
  reports/               recall — query.ts (deterministic buckets), summarize.ts (LLM writes
                         only prose over a fixed slice), service.ts, repository.ts
  workflows/             Inngest functions + events.ts; route-email.ts is the dispatch hub
scripts/                 one-off CLIs (backfill-entities.ts, replay-failed-processing.ts)
docs/phases/             the phase plans + this handoff; phase-7-context-engine-plan.md is live
```

### Conventions & gotchas (internalize these)

1. **Single mutation funnel.** All loop state changes (close/advance/snooze/reconcile) go through `mutateLoopState(...)` in `src/loops/service.ts` — it writes identical `loop_events` + emits `loop.updated`. Never hand-mutate a loop row.
2. **Model boundary (AR-8).** LLMs propose; code decides via thresholds. Every `generateObject` schema is **flat, all-required**, optionality via `.nullable()` — no `.default()`/`.optional()`, no nested `discriminatedUnion`/`oneOf` (OpenAI strict mode rejects them; this caused a prod outage). Every model path has a deterministic no-creds fallback.
3. **Provenance (AR-9).** Every automated decision leaves an auditable, one-sentence-explainable trail (a `loop_event` / `model_calls` row).
4. **Inngest determinism.** Function bodies re-execute per step; mint anything random/time-based **inside** `step.run`, pass primitives across step boundaries (Date→ISO). Read DB state inside the workflow and pass a compact serialization-safe context into the model step. Functions register in `app/api/inngest/route.ts`.
5. **DB-injectable repositories.** Repos take `constructor(db?)` (or functions take `db?`) defaulting to `getDb()`, so DB-gated tests inject a handle pointing at local `:55433`.
6. **React render tests** use `renderToStaticMarkup` (mock `next/navigation` `useRouter`).
7. **Composio toolkit versions MUST be pinned** (`COMPOSIO_*_TOOLKIT_VERSION`) — `"latest"` is rejected at execute time in `@composio/core` 0.10.0.

---

## 8. Deploy & ops

- **Deploy:** `vercel deploy --prod --yes` (Vercel CLI, project `keeps`). Inngest auto-syncs its functions on deploy.
- **Prod DB migrations:** applied by hand via `psql` with the prod `DATABASE_URL` from Doppler `keeps/prd` (never echo it). Apply `0019+` before deploying code that depends on them.
- **Live email testing:** the Composio Gmail MCP round-trip is **blocked by Google** — do live checks manually, or POST a Postmark-shaped payload to `/api/email/inbound` (shared-secret), or send Inngest events directly.
- **Dead-letter/replay:** failed processing lands in `failed_processing`; `/admin/failed-processing` + `scripts/replay-failed-processing.ts` replay it.

---

## 9. Working agreement

- Keep `main` green: `pnpm typecheck && (scoped) vitest` before every commit; full `pnpm build` before deploy.
- Atomic commits, message style `Phase 7 <task>: …`.
- The false-merge invariant is sacred. When a reconciliation/merge decision is uncertain, **create-new (or suppress + ask)** — never guess a merge.
- Questions on intent/scope → ask Arav. Questions on "how does X work here" → the answer is almost always in `docs/phases/phase-7-context-engine-plan.md` or the file's own header comment.
