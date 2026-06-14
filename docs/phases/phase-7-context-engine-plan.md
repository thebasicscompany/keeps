# Phase 7 — Context Engine (Final Plan)

> Turn Keeps from a per-email **loop tracker** into a context **engine**: capture promotes people/companies to first-class **entities**; extraction becomes **context-aware** (it sees relevant open loops + known entities and **reconciles** instead of always creating new); inbound replies automatically **advance or close** the matching loop; recall **synthesizes** an entity's true status. So that CC'ing more email makes the assistant *smarter*, not just *longer* — and a durable commitment graph accrues underneath.

Status: **planned, not started.** Confirmed Phase 7 with Arav 2026-06-13. Design validated against 2024–2026 research + a ~15-tool build-vs-buy survey (2026-06-14). Supersedes the scratch `context-engine-sprint-handoff.md`.

---

## 1. The gap (why this sprint exists)

Phases 0–6 are DONE + live at keeps.email. Capture → extract → nudge → recall all work. But it's a stateless per-email loop extractor. Three structural gaps:

1. **Extraction is stateless.** `extractLoops({ email })` (`src/agent/extract-loops.ts`) prompts the model with only Subject / From / Participants / body — never prior loops, thread history, or known people. The 5th email about a deal extracts as if the first 4 never happened. *(Verified: input is `{ email, useModel? }` only.)*
2. **No entity graph.** `loops.ownerText` / `requesterText` are free-text columns (`src/db/schema.ts:425`). No people/companies table. "Show Acme loops" is a substring match over a flat list (`src/reports/query.ts:74` `matchesEntity`).
3. **No reconciliation or synthesis.** New emails (incl. a counterparty "done!" reply) spawn NEW loops; nothing finds/closes/advances the matching open loop. "Insights" is deterministic bucketing, not understanding.

---

## 2. The architecture (4 decisions)

The unifying principle, validated across all research: **the LLM does fuzzy semantic judgment; deterministic code holds the merge pen and decides what is true. The model proposes; code disposes.** (AR-8 model boundary.)

The framing that makes it tractable: **a false merge is a PRECISION failure; a duplicate loop is a RECALL failure — and they are asymmetric.** A duplicate is visible and cleanable; a false merge silently destroys a commitment — the worst possible trust failure. So every merge-class decision is tuned for precision, accepting lower recall. Corollary: **candidate retrieval can never cause a false merge — only the final decision can** — so scoping/retrieval is cheap and loose; the decision is strict and conservative.

### Decision A — Entity resolution: deterministic, exact-email-first
Find-or-create by **normalized exact email** (lowercase, strip `+tags`) — the only safe auto-merge key (what HubSpot/Salesforce do). Else conservative name/alias match. **Name is an alias/attribute, never a join key** (kills the "John Smith @ Acme" vs "@ Beta" false-merge class). Company = email domain minus a freemail/ISP blocklist. Merges reversible via a `merged_into` tombstone.
- *Rejected:* embedding similarity (near-identical vectors for different people → silent merge); LLM-as-resolver (LLMs over-match when primed with candidates).

### Decision B — Context-aware extraction + reconciliation: model proposes, three-band decider disposes
Inject a *scoped* set of relevant open loops + known entities into the extraction prompt. Model proposes, per candidate, a flat reconciliation `{ reconcilesLoopId, reconcileAction, reconcileConfidence, reconcileEvidence }`. Deterministic decider applies **three bands** (Fellegi-Sunter standard):
- **HIGH** confidence **AND** a corroborating structured signal (same thread OR same resolved entity) → auto-reconcile (update/close existing via `mutateLoopState`).
- **LOW** → create-new.
- **UNCERTAIN MIDDLE** → create-new anyway (safe default — no commitment ever lost) **AND** ask the user on the private-reply channel ("looks like your existing loop about X — same one?"). On confirm: dismiss the duplicate + apply the update to the original (both via `mutateLoopState`).

Prompt framing (research-critical): frame as **select-one-among-candidates** (ComEM, COLING 2025 — comparing across candidates beats isolated yes/no); make **create-new the explicit safe default** to counter sycophancy/anchoring (injected candidates prime a false "yes, match"); **require a cited shared identifier** (`reconcileEvidence`) for any non-null `reconcilesLoopId`. **Auto-CLOSE is destructive** (telling the user something's done when it isn't) — gate it as strictly as merge; prefer a "looks done?" confirmation.
- *Rejected:* single-pass where the model's "yes, merge" is the final write (every over-match → silent false merge); pure embedding-threshold matching (conflates topical similarity with same-commitment identity).

### Decision C — Context scoping: heuristic blocking, no embeddings in v1
Candidates = open loops where `same thread` OR `same resolved entity` OR `(recent window AND open)`, capped top-N (~10) by recency. Pure SQL. Email gives a uniquely strong free signal — the thread graph — that generic record-linkage lacks. Below ~50–100K post-filter candidates a vector index buys nothing; at our scale (hundreds–thousands of loops) it's pure liability.
- *Deferred:* embeddings/`pgvector` — add only if production shows cross-thread/cross-entity duplicate loops leaking. The heuristic's blind spot (a brand-new thread to a new contact about an existing deal) is exactly where we *want* create-new anyway.

### Decision D — Synthesis recall: deterministic slice, model writes only prose
Code assembles the entity's loops + linked threads + recent `loop_events` into a structured, ordered slice. The model writes **only the human summary** over that fixed slice, constrained to reference only provided rows (cite ids). Deterministic fallback = structured list.
- *Rejected:* agentic retrieval (model constructs its own queries → wrong joins, hallucinated columns, the "57% of citations are post-rationalized" problem; non-reproducible, non-auditable).

---

## 3. Build vs buy — native, but not "from scratch"

**Decision: build native for v1.** A ~15-tool survey (Mem0, Zep/Graphiti, Letta, Cognee, LangMem, LlamaIndex, Splink, Zingg, dedupe, Senzing, RecordLinkage, Postgres extensions, …) confirmed it. Two disqualifying facts:
1. **No credible TS/Node entity-resolution library exists** — every serious ER engine (Splink, Zingg, dedupe, Senzing) is Python/JVM = a second runtime + deploy on our Vercel/Inngest/Node stack.
2. **Graphiti is Python-only and forces Neo4j/FalkorDB** (no Postgres backend — open issue #779) and **auto-merges nodes/edges via internal LLM calls** = the exact false-merge machinery we forbid, non-deterministic + unauditable.

Deeper reason the whole category misses: these tools optimize to **auto-merge at scale** (accepting a false-merge rate for throughput); we want **abstention at tiny scale** with a near-perfect natural key (email). At hundreds–thousands of records the statistical machinery (EM/blocking) gets *noisier*, not better.

**"Native" ≠ "from scratch" — we buy the hard parts and copy proven schemas:**
- **Buy (Postgres extensions):** `pg_trgm` + `fuzzystrmatch` (trigram similarity, Levenshtein, Metaphone) drive name-similarity **suggestions** into a review queue — never auto-merge. Optional pure-TS `talisman`/`natural` if in-app Jaro-Winkler/Metaphone scoring is wanted.
- **Copy (data models):** Mem0's `ADD/UPDATE/DELETE/NOOP` verb taxonomy → our `create/advance/close/noop`; Graphiti's **bi-temporal** schema (valid-time vs ingestion-time columns + invalidate-don't-delete); Splink's **Fellegi-Sunter three-band** (= our decider); OpenRefine's human-confirm reconciliation UX (= the "ask" band).
- **Write ourselves (~few hundred lines):** the conservative resolver + the reconciliation decider — the part that *must* be ours because the never-false-merge guarantee lives there.

**v2+ (not this sprint):** a soft semantic-memory layer for non-loop context ("Sarah prefers Tuesday calls") — there Graphiti > Mem0; evaluate Graphiti-on-FalkorDB vs extending Postgres then, as a layer feeding the decider, never owning the graph. Semantic recall ("where's the Acme deal?", read-only, no merge risk) = `pgvector` in the existing RDS, or LlamaIndex.TS `VectorMemoryBlock` (TS-native, MIT) scoped to recall-only.

---

## 4. Cardinal constraints / invariants (non-negotiable)

1. **No false merge.** Bias hard toward create-new. High confidence + corroborating signal required to auto-reconcile. Deterministic fallback NEVER reconciles. Conservative entity resolution: exact-email only, never merge two distinct emails.
2. **Model boundary (AR-8).** Model PROPOSES; app code DECIDES via threshold + `mutateLoopState`. Strict OpenAI structured outputs: every `generateObject` schema is FLAT, all fields required, optionality via `.nullable()` (NO `.default()`/`.optional()`, NO nested discriminatedUnion). Every model path has a deterministic no-creds fallback (default test run has no `OPENAI_API_KEY`).
3. **Single mutation funnel.** ALL reconciliation (close/advance/merge) routes through `mutateLoopState(...)` (`src/loops/service.ts:191`) — identical `loop_events` + `loop.updated`. Never hand-mutate loops. *(The Phase 5 parity invariant: email-command and web-row-action paths already share it.)*
4. **Provenance (AR-9).** Every reconciliation (including each "ask") writes a `loop_event` and is explainable in ONE sentence. Digest/insight copy states what got merged/closed automatically.
5. **Context scoping.** Never dump the whole backlog into a prompt. Scope to same-thread + same-entity + recent-open, capped top-N. Document the rule.

---

## 5. Repo realities & gotchas (verified 2026-06-13)

- **DB is AWS RDS, not Neon.** `pnpm db:migrate`/`db:generate` are BROKEN BY DESIGN (no drizzle journal). Migrations are HAND-WRITTEN sequential idempotent SQL in `src/db/migrations/`. **Next number is 0018.** Copy 0008 style for new TABLES + ENUM TYPES (CREATE TYPE in a `DO $$ … duplicate_object` guard + CREATE TABLE/INDEX IF NOT EXISTS); copy 0009/0016 style for ENUM-VALUE additions (`ALTER TYPE … ADD VALUE IF NOT EXISTS`) in their OWN separate non-transactional file (0019). Mirror `src/db/schema.ts` + export types. Apply to local twice to prove idempotency.
- **Local dev Postgres:** container `keeps-postgres` on port 55433 (postgres/postgres, db `keeps`). `postgres://postgres:postgres@localhost:55433/keeps`. psql at `/opt/homebrew/opt/libpq/bin/psql`. If not running: `docker run -d --name keeps-postgres -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=keeps -p 55433:5432 postgres:16` then apply 0000–0017 before 0018. Prod `DATABASE_URL` via `doppler secrets get DATABASE_URL --project keeps --config prd --plain` (NEVER echo it — a redaction miss leaked it once).
- **OpenAI strict outputs** caused a prod outage (commit 77717a3) — see constraint #2.
- **Inngest determinism:** function body re-executes per step; mint anything random/time-based INSIDE `step.run`; pass primitives across boundaries (Date→ISO). Read DB state (relevant open loops + entities) INSIDE the workflow and pass a compact, serialization-safe context into the model step. Functions register in `app/api/inngest/route.ts`; idempotency is a CEL expression on `event.data`. (Existing `findLoopsByInboundEmailId` already guards re-processing.)
- **Tests:** NODE vitest env (no jsdom). DB-gated tests use `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps` + the DB-injectable repository constructor pattern (`constructor(db?)` defaulting to `getDb()`). React render tests use `renderToStaticMarkup` (mock `next/navigation` useRouter). `getDb()` throws without `DATABASE_URL` — never call at module top level. ~1302 tests currently green.
- **No git remote** — deploy with `vercel deploy --prod --yes` (CLI authed as abharw, project keeps). Inngest auto-syncs on deploy. **Composio Gmail MCP is BLOCKED by Google** — automated live email round-trip unavailable; do live checks MANUALLY or via the `/api/email/inbound` shared-secret fallback (POST a Postmark-shaped payload) or by sending Inngest events directly.

### Keystones to reuse
- `mutateLoopState(...)` — `src/loops/service.ts:191` (the mutation funnel).
- Intent router: `src/agent/classify-intent.ts` (deterministic `classifyEmailIntent`) + `src/workflows/functions/route-email.ts` (dispatch; extraction is the `capture` branch at ~328).
- Persistence: `LoopProcessingRepository.persistExtractedLoops()` writes loops + sourceEvidence + `loop_events` (`created`).
- Recall: `generated_reports` + `src/reports/{query.ts,summarize.ts,service.ts}` + `app/r/[token]/page.tsx`. `entity` report kind exists but is a string filter — this sprint makes it real.
- Eval: `src/agent/eval/*` (token-Jaccard matcher threshold 0.5, 16 synthetic cases, `pnpm eval`, `eval_runs` table). EXTEND with reconciliation cases.
- Model logging: every `generateObject` routes through `src/agent/instrumented-generate-object.ts` (purpose tag).

---

## 6. Wave-by-wave execution plan

Waves map to parallel worktree subagents; commit per task; review every diff; cherry-pick onto main; remove worktrees + `git worktree prune` + `next typegen` BEFORE gates (vitest scans `.claude/worktrees` and double-counts). Pre-add any new deps/env to main BEFORE fanning out (agents share symlinked node_modules; they must not run `pnpm add`). Serialize shared-file edits (Inngest registration, `events.ts`, the capture-branch edit) into integration commits.

### WAVE 0 — entity foundation (FIRST, alone, so later waves share the schema)
- **W0** [sonnet / orchestrator]: migration **0018** —
  - `entities` table: `id, user_id, kind enum(person|company|other), display_name, canonical_email nullable, aliases jsonb default '[]', metadata jsonb, merged_into_entity_id nullable self-FK (reversible-merge tombstone; resolveEntity follows the pointer), first_seen_at, last_seen_at, created_at, updated_at`; unique `(user_id, canonical_email)` where not null; index `(user_id, kind)`.
  - Nullable FK columns `loops.owner_entity_id` / `loops.requester_entity_id` (`REFERENCES entities ON DELETE SET NULL` — KEEP `ownerText`/`requesterText` as provenance fallback).
  - `loop_entities` join table: `loop_id, entity_id, role enum(owner|requester|participant)`, unique `(loop_id, entity_id, role)`.
  - New enum TYPEs in 0018; any enum-VALUE adds in 0019 (non-transactional). Mirror schema.ts + export types. Apply to local 55433 twice. **Only schema task — all other agents import the resulting types.**

### WAVE A — entity resolution + backfill (after W0)
- **A1** [sonnet]: `src/entities/resolve.ts` (+ DB-gated test) — `resolveEntity({ userId, name, email }, db?)`: find-or-create by NORMALIZED exact email first; follow `merged_into_entity_id` pointers; else conservative name match vs `display_name`+aliases (NEVER fuzzy-merge two distinct emails); updates `last_seen_at`; appends alias. Company = domain minus freemail blocklist. Name is an alias, never a join key. DB-injectable. (Use `pg_trgm`/`fuzzystrmatch` only for *suggestion* scoring later — A1 itself is exact-email + exact-alias.)
- **A2** [sonnet]: backfill — one-time Inngest function or `scripts/backfill-entities.ts` CLI: walk existing loops + email participants, resolve entities, populate `owner_entity_id`/`requester_entity_id` + `loop_entities`, WITHOUT mutating loop content. Idempotent (skip already-linked). DB-gated test on a seeded graph. Run against prod in the ops wave.
- **A3** [sonnet]: wire `resolveEntity` into the capture path — when loops are persisted (the loop-creation repository / capture branch), resolve owner/requester/participants → link them. Do NOT change extraction yet. Update first/last_seen_at.

### WAVE B — context-aware extraction + reconciliation (after A; THE core; review hardest)
- **B3** [sonnet] (build first — B1/B2 depend on it): `loadExtractionContext({ userId, threadId, participants, db })` → scoped `CompactLoop[]` / `CompactEntity[]` (same-thread + same-entity + recent-open, capped top-N). Pure-ish + DB-injectable. The workflow reads this inside a step and passes it to B1.
- **B1** [opus]: extend `extractLoops` to accept optional `context: { openLoops, knownEntities, threadSummary? }`. Prompt includes a compact rendering of relevant open loops + entities. Output schema gains FLAT all-required-nullable fields per candidate: `reconcilesLoopId: string|null`, `reconcileAction: 'create'|'update'|'close'`, `reconcileConfidence: number`, `reconcileEvidence: string|null`. **Prompt framing:** select-one-among-candidates; create-new is the explicit safe default; require `reconcileEvidence` whenever `reconcilesLoopId` is non-null; order candidates by recency (watch position bias). Preserve strict outputs; deterministic fallback returns `create`/`0`/`null` (never reconciles). Route through instrumented-generate-object (purpose `extract_loops`).
- **B2** [opus]: `src/agent/reconcile.ts` (+ tests) — the **three-band decider + apply**. Given the model's proposal + actual open loops: (1) validate `reconcilesLoopId` exists in the candidate set (reject hallucinated ids → create); (2) require non-empty `reconcileEvidence` (else → create); (3) run the deterministic candidate-matcher guardrail (reuse/extend the eval token-matcher) + corroborating-signal check (same thread OR same entity); (4) band on `reconcileConfidence` × guardrail agreement → `{create | reconcile<update|close> | ask}`. `close` uses a stricter band than `update`. Cross-entity/cross-thread (no shared signal) → never auto-reconcile. Apply update/close via `mutateLoopState`; "ask" → emit a private-reply prompt + create-new; on user-confirm, dismiss duplicate + apply update to original (both via `mutateLoopState`; add a "merged/superseded by user confirmation" loop_event type — 0019 if needed). Optional adversarial "refute this merge" second check before destructive actions (deterministic first; model pass optional w/ no-creds fallback). Every decision writes a `loop_event`. Wire into the capture branch (one agent owns that edit).

### WAVE C — synthesis recall + entity views (after A; parallel with B where files are disjoint)
- **C1** [opus]: entity status synthesis. New report scope (extend `generated_reports` / the `report.requested` event + `src/reports/query.ts`) that, for an entity, gathers loops + linked threads + recent `loop_events` into a structured slice; `src/reports/summarize.ts` synthesizes a real STATUS (headline + state) — model writes only the human summary over the deterministically-assembled slice; fallback = structured list. "Where's the Acme deal?" routes here.
- **C2** [sonnet]: make the `entity` recall a real entity VIEW — classify-intent/route-email detect an entity query → resolve the entity (Wave A) → C1 synthesis; the `/r/<token>` page groups by entity with relationship recency (first/last seen, open count). Adapt the real router + report page, not a parallel one.

### WAVE D — measurement + trust + ops/live (you + agents)
- **D1** [opus]: EXTEND the eval suite with RECONCILIATION cases covering all THREE bands — sequences where correct = auto-reconcile (update/close), = create-new, AND = **ask** (uncertain middle); adversarial near-duplicates that MUST NOT auto-merge; a cross-entity/cross-thread case (never auto-reconcile). Metrics: reconciliation precision/recall, a **false-merge rate** (hard gate near zero), a **false-auto-close rate**. Verify the "ask" band catches what would otherwise be false merges. Riskiest correctness surface — own its review.
- **D2** [sonnet]: provenance + admin — every reconciliation explainable in one digest sentence (AR-9); an `/admin` view of recent reconciliation decisions (reuse `requireAdmin`). Digest/insight copy states what got merged/closed automatically.
- **Then orchestrator:** full gates (`pnpm typecheck && pnpm exec vitest run src app && pnpm build`); apply 0018(/0019) to prod via psql; run A2 backfill against prod; `vercel deploy --prod --yes`; verify new Inngest functions registered by behavior; LIVE wave with Arav (manual or `/api/email/inbound` fallback) — CC a fresh email referencing a prior commitment → confirm it UPDATES the existing loop (not a dup); a counterparty "done" reply → CLOSES the waiting-on loop; "where's <entity> at?" → synthesized status. Update `docs/phases/README.md` + roadmap; write the Closeout; update `keeps-status` + `keeps-vision` memories (entities now first-class).

---

## 7. Verification duties (orchestrator, non-negotiable)

Read every subagent diff before accepting. Adversarial focus:
- **(a) False-merge safety** — no two distinct commitments ever collapse; decider is conservative; deterministic fallback never merges; near-duplicate eval cases stay separate; the "ask" band catches the uncertain middle.
- **(b) Model boundary (AR-8)** — model proposes, code decides via threshold + `mutateLoopState`; strict schemas intact (flat, required-nullable); deterministic fallbacks intact.
- **(c) Entity-resolution conservatism** — email-exact first, never merge distinct emails; name is an alias.
- **(d) Reconciliation through `mutateLoopState`** — identical `loop_events` + `loop.updated`; Phase 5 parity invariant holds.
- **(e) Provenance (AR-9)** — every auto-update/close/ask leaves an auditable, one-sentence-explainable trail.
- **(f) Context scoping** — prompts stay bounded, not whole-backlog.

Run `pnpm typecheck && (scoped) pnpm test` between waves; full `pnpm build` before deploy. New model code needs new tests with deterministic fallbacks. Commit per task, atomic, message style `Phase 7 <task>: …` ending `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit secrets. If a subagent's work fails review twice, fix it yourself rather than spawning a third attempt. Checkpoint after each wave; keep main green; fine to run across sessions.

---

## 8. Orchestrator handoff prompt

> Paste into a fresh session on **Opus** (`cd /Users/aravb/Developer/keeps && claude`, then `/model` → Opus). See the copy-paste block in the chat that produced this doc, or the `## Prompt` section below.

```
You are the Opus orchestrator for the Context Engine sprint (Phase 7) of Keeps. Working directory: /Users/aravb/Developer/keeps. You ORCHESTRATE and VERIFY — you do NOT write feature code yourself. Spawn a subagent per task with the Agent tool (isolation:"worktree", model per the wave assignments), review every diff critically before accepting, run the gates between waves, cherry-pick reviewed commits onto main, and run the ops/live steps with Arav.

READ FIRST: docs/phases/phase-7-context-engine-plan.md (this is the full plan — architecture, constraints, repo realities, wave breakdown, verification duties). Also: docs/phases/README.md (AR-1..AR-9, esp. AR-8 model boundary + AR-9 provenance), memory keeps-vision + keeps-status + phase7-context-engine, docs/phases/phase-6-sprint-handoff.md (shows the worktree→review→cherry-pick→gates→ops orchestration mechanics that shipped Phase 6), and git log.

THE GOAL (one sentence): turn Keeps from a per-email loop tracker into a context engine — capture promotes people/companies to first-class ENTITIES; extraction is CONTEXT-AWARE (sees scoped open loops + known entities + thread history and RECONCILES instead of always creating new); inbound replies/follow-ups automatically advance or close the matching loop; recall SYNTHESIZES an entity's true status — so CC'ing more email makes the assistant smarter, not just longer.

NON-NEGOTIABLE INVARIANTS (plan §4): (1) NO FALSE MERGE — bias hard to create-new; three-band decider (auto / create-new / ASK the user on the uncertain middle); deterministic fallback never reconciles. (2) MODEL BOUNDARY (AR-8) — model proposes, code decides via threshold + mutateLoopState; strict OpenAI outputs (flat, all-required, optionality via .nullable(), no nested unions); every model path has a deterministic no-creds fallback. (3) ALL reconciliation routes through mutateLoopState (src/loops/service.ts:191) — identical loop_events + loop.updated; never hand-mutate. (4) PROVENANCE (AR-9) — every decision writes a loop_event, explainable in one sentence. (5) CONTEXT SCOPING — never dump the whole backlog; scope to same-thread + same-entity + recent-open, capped.

REPO REALITIES (plan §5 — put the relevant ones in every subagent prompt VERBATIM): DB is AWS RDS not Neon, migrations are hand-written idempotent SQL (next is 0018, enum-value adds in 0019 non-transactional), local Postgres on :55433; strict OpenAI outputs (a violation caused a prod outage); Inngest step determinism (read DB state inside the workflow, pass compact serialization-safe context into the model step); NODE vitest env + DB-injectable repository pattern + no OPENAI_API_KEY in the default run; no git remote (vercel deploy --prod --yes); Composio Gmail MCP blocked (live email manual or /api/email/inbound fallback).

WORKTREE MECHANICS (give every subagent VERBATIM): you are in a fresh worktree with NO node_modules — first run `ln -s /Users/aravb/Developer/keeps/node_modules node_modules`. Verify with `pnpm exec tsc --noEmit` + `pnpm exec vitest run <your files>` (set TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps for DB-gated). Do NOT edit src/db/schema.ts / migrations / src/config/env.ts unless that IS your task (W0 owns schema). When you add a route, run `pnpm exec next typegen` before tsc. Commit on your branch; return ONLY: SHA, files changed, tsc result, test result, decisions/risks (no full diffs — the orchestrator inspects via git show).

EXECUTION ORDER (plan §6): Wave 0 (migration 0018, FIRST and ALONE) → Wave A (A1 resolveEntity, A2 backfill, A3 wire-into-capture) → Wave B (B3 context loader first, then B1 context-aware extraction, B2 three-band reconcile decider — review hardest) ‖ Wave C (C1 entity synthesis, C2 entity view) where files are disjoint → Wave D (D1 reconciliation eval incl. false-merge gate, D2 provenance/admin) → orchestrator: full gates, prod migration + backfill (Arav go-ahead), deploy, live UAT with Arav. Pre-add new deps/env to main before fanning out; serialize shared-file edits (Inngest registration, events.ts, the capture-branch edit) into integration commits. Remove worktrees + `git worktree prune` + `next typegen` before gates.

VERIFICATION DUTIES (plan §7): read every diff; adversarial focus on false-merge safety, model boundary, entity-resolution conservatism, mutateLoopState routing, provenance, context scoping. Gates between waves; full build before deploy. Commit per task atomic, "Phase 7 <task>: …" ending Co-Authored-By: Claude <noreply@anthropic.com>. If a subagent fails review twice, fix it yourself.

BUILD VS BUY (plan §3 — decided, do not re-litigate): build native. No external memory/ER framework (all Python/JVM or force a graph DB or auto-merge non-deterministically — wrong for our TS/Postgres stack + false-merge constraint). Buy pg_trgm/fuzzystrmatch (Postgres extensions) for name-similarity SUGGESTIONS only. Copy proven schemas (Mem0 verbs, Graphiti bi-temporal, Splink three-band, OpenRefine human-confirm). Embeddings/pgvector deferred to v2.

Working style: act, don't ask, for reversible engineering steps. Arav does: prod deploy/migration go-aheads (irreversible) and any live UAT that sends real email or mutates real data. Stop at the first live-smoke failure and debug yourself (psql, vercel logs) before involving him. Large sprint — checkpoint after each wave, keep main green, fine to run across sessions. START with Wave 0.
```
