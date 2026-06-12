# Phase 2.5: Pipeline Hardening

Status: planned
Depends on: Phase 2 (loop extraction + private-reply state)
Roadmap reference: `docs/roadmap.md` "Current Status" — "Not Yet Done" (reply-command ingestion, idempotency, loop status cleanup); rulings AR-1, AR-2, AR-3, AR-4, AR-6 in `docs/phases/README.md`.

## Goal

After Phase 2.5, every inbound email — regardless of dev or prod — flows through a single Inngest path. The `process-email` workflow is an intent router (capture / command / approval / question / correction) rather than a blind extractor. Outbound nudges are routed through a sender interface with a dev recording transport; each nudge persists an ordinal → loopId map and is reply-addressed with a plus-routed mailbox hash, so a user replying "dismiss 1" to a specific nudge resolves to the loop the nudge actually listed (no live re-listing). The workflow is idempotent on `inboundEmailId`. The stored `loop_status` enum is lifecycle-only — `due_soon` and `overdue` are removed and derived at query time. The end-to-end local smoke test (webhook → Inngest → loop → nudge sent via dev transport → simulated reply → loop dismissed) passes without any live Postmark traffic.

## Why Now

Phase 2 left three brittle seams that block every later phase:

1. Two processing paths (inline + Inngest) — every later workflow (cron, approval wait, connector action) needs one canonical path or behaviour will diverge between dev and prod.
2. Reply commands work as a parser but are never invoked from any actual reply, because outbound replies are not actually sent and replies cannot be tied back to a specific nudge. Phase 3 nudges/digests and Phase 4 approvals both depend on a working reply-to-nudge round-trip.
3. Inngest replays and Postmark webhook redelivery will double-create loops/nudges until the workflow is idempotent.

Phase 2.6 (live Postmark transport, Clerk auth, deployment) needs all of this to be true before it can swap dev transport for real Postmark sends, so 2.5 must happen first.

## Preconditions

- Phase 2 verified locally (see `docs/roadmap.md` Current Status).
- `INNGEST_DEV=1` is set in `.env.local` so the Inngest dev server is the only path locally as well as in prod.
- `pnpm typecheck`, `pnpm test`, `pnpm build` all currently pass.

## Deliverables

1. **Single Inngest path through the inbound route (AR-1).** `app/api/email/inbound/route.ts` no longer calls `processInboundEmailForLoops` inline. The route shape is exactly: verify shared-secret header → `handlePostmarkInboundEmail` → emit `email.received` → return 202. `shouldDispatchWorkflow` is removed. Acceptance: the route has zero references to `processInboundEmailForLoops` or `DrizzleLoopProcessingRepository`, and the response body no longer includes `phase` or `localProcessing`.

2. **Intent router workflow (AR-2).** `process-email` becomes a router that classifies first then dispatches per branch (`capture | command | approval | question | correction`). Acceptance: the workflow file imports a dedicated classifier module, dispatches via a `switch` on intent, and each branch returns a structured `{ intent, persisted, reply }` shape. `processInboundEmailForLoops` is reduced to the capture handler (it stops choosing intent and stops being the entry point).

3. **Dedicated classifier module.** `src/agent/classify-intent.ts` exports `classifyEmailIntent(email: NormalizedEmail): { intent: EmailIntent; basis: "rule" | "model"; matchedRule?: string }`. Acceptance: it covers all five intents using the deterministic rules currently inside `extract-loops.ts` `classifyIntent` (promoted, not duplicated), is unit-tested standalone, and `extract-loops.ts` imports from it (no local copy left).

4. **Command branch wired to `applyLoopReplyCommand`.** The command branch resolves the referenced nudge (see Deliverable 6), loads the loops referenced by the nudge's stored ordinal map, then runs `applyLoopReplyCommand`. Acceptance: a reply that says "dismiss 1" to a real nudge dismisses the loop the nudge listed as #1 — even if other newer loops exist. `listCommandableLoops` is no longer called from the command branch.

5. **Correction / question / approval stub branches.** Correction stores the command text on the referenced loop (or thread) via a new `loop_events.event_type = 'corrected'` insert (the enum value already exists) and replies "Got it — I will use that correction." Question and approval branches send polite stub replies ("I will handle this when approvals are live in Phase 3.") and emit `email.classified` with the intent. Acceptance: no branch throws; each branch produces a private reply nudge.

6. **Nudge ordinal map + reply addressing (AR-3).** `nudges.metadata` carries `{ ordinalMap: Record<number, string>, kind: "private_reply", ... }` at creation time, where ordinal keys map 1-based positions to loop IDs as listed in the reply body. When a nudge is sent, the outbound message sets `Reply-To: agent+n_<nudgeId>@keeps.ai`, `In-Reply-To: <provider message id of source>`, and `References: <thread root>` so Gmail threads it. Acceptance: `service.ts` `createPrivateReplyNudge` writes `ordinalMap` keyed by the loops it actually listed, and outbound headers are visible in the recorded sender row.

7. **Postmark `MailboxHash` capture and lookup.** `postmarkInboundSchema` adds an optional top-level `MailboxHash: z.string().optional().default("")` field, `NormalizedEmail` exposes `mailboxHash: string | null`, and the repository persists it on `inbound_emails` (new `mailbox_hash` column, indexed). Inbound reply resolution order: (a) `MailboxHash` matches `n_<uuid>` → load `nudges` by id; (b) fallback: `In-Reply-To` header matches an outbound message id recorded in `outbound_emails` (Deliverable 9). Acceptance: a fixture with `MailboxHash: "n_<nudgeId>"` resolves to the correct nudge in unit tests, and a fixture with no hash but an `In-Reply-To` matching a recorded outbound message resolves to the same nudge.

8. **Outbound sender interface (dev transport only).** New `src/email/outbound.ts` defines:

   ```ts
   export type OutboundEmail = {
     to: string;
     subject: string;
     textBody: string;
     htmlBody?: string;
     replyTo?: string;
     inReplyTo?: string;
     references?: string;
     headers?: Record<string, string>;
   };
   export type SendResult = { providerMessageId: string };
   export interface EmailSender { send(email: OutboundEmail): Promise<SendResult>; }
   ```

   and exports `DevRecordingSender` which:
   - generates a synthetic provider message id (`dev-<uuid>@keeps.local`),
   - inserts a row into a new `outbound_emails` table (Deliverable 10) capturing the full message,
   - transitions the referenced `nudges` row from `pending` → `sent`, sets `sent_at = now()`,
   - returns the synthetic id.

   Acceptance: the capture branch ends by constructing the `EmailSender`-shaped message from `buildPrivateLoopReply`, calling `sender.send(...)`, and writing the ordinal map at the same time. The live Postmark transport is explicitly out of scope and will land in Phase 2.6.

9. **`sendNudge(nudgeId)` service.** New `src/loops/send-nudge.ts` exports `sendNudge({ nudgeId, sender, repository })` which loads the nudge, builds the `OutboundEmail` (subject, body, reply-to with mailbox hash, In-Reply-To from the source inbound email), calls `sender.send(...)`, and updates the nudge row. Acceptance: unit test calls it against an in-memory sender and asserts the nudge row, the outbound_emails row, and the headers.

10. **`outbound_emails` table.** New table on the schema: `id uuid pk`, `user_id uuid fk`, `nudge_id uuid fk`, `provider text`, `provider_message_id text`, `to_email text`, `subject text`, `text_body text`, `headers jsonb`, `reply_to text`, `in_reply_to text`, `references_header text`, `mailbox_hash text`, `created_at timestamptz`. Indexes on `(provider, provider_message_id)` unique, `(user_id)`, `(nudge_id)`, `(in_reply_to)` for fallback reply lookup. Rationale: keeping the full message rather than only flipping `nudges.status` is justified because Phase 2.6 needs the same row to capture Postmark's returned message id and any send-failure metadata; and reply-lookup needs `in_reply_to` indexed on outbound, which is awkward on `nudges` because not every nudge becomes an email (digest grouping, future Slack channel, etc.).

11. **Workflow idempotency (AR-4).** `process-email` sets `idempotency: "event.data.inboundEmailId"` on its function config. `inngest@4.5.1` accepts this as a CEL-style expression string on `createFunction`'s options (see `node_modules/inngest/components/InngestFunction.d.ts` line 167). Additionally, the capture branch checks a persistence-level guard before extracting: if any `loops` row already exists with the same `inbound_email_id`, return `{ status: "already_processed", inboundEmailId, loops, events: [] }` and skip extraction + nudge creation. Acceptance: replaying `email.received` for the same `inboundEmailId` returns the same result, creates zero new rows, and does not emit `loop.created` a second time.

12. **Lifecycle-only `loop_status` (AR-6).** Remove `due_soon` and `overdue` from the `loop_status` pg enum. Postgres cannot drop enum values in place, so the migration drops the column default, swaps to a new enum, and drops the old type:

    ```sql
    -- 0003_phase2_5_loop_status_lifecycle.sql
    CREATE TYPE "loop_status_v2" AS ENUM (
      'candidate','open','waiting_on_me','waiting_on_other',
      'blocked','snoozed','done','dismissed'
    );
    ALTER TABLE "loops" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "loops"
      ALTER COLUMN "status" TYPE "loop_status_v2"
      USING (
        CASE
          WHEN "status"::text IN ('due_soon','overdue') THEN 'open'::loop_status_v2
          ELSE "status"::text::loop_status_v2
        END
      );
    ALTER TABLE "loops" ALTER COLUMN "status" SET DEFAULT 'candidate'::loop_status_v2;
    DROP TYPE "loop_status";
    ALTER TYPE "loop_status_v2" RENAME TO "loop_status";
    ```

    Recommended approach (justified): rename-swap rather than a text+CHECK constraint, because Drizzle's `pgEnum` round-trips cleanly to a real PG enum and we keep the same type name in code. `src/db/schema.ts` `loopStatusEnum` array drops the two values. Acceptance: `due_soon` and `overdue` are absent from `loopStatusEnum`, `LoopStatus` no longer accepts them at the TypeScript level, and a `pnpm test` grep confirms no source file still references either literal. A new derivation helper `src/loops/urgency.ts` exports `deriveUrgency(loop: { status: LoopStatus; dueAt: Date | null; nextCheckAt: Date | null }, now: Date): "due_soon" | "overdue" | null` for future query-time use; Phase 3 will adopt it.

## Data & Migrations

New migration `src/db/migrations/0003_phase2_5_hardening.sql`:

1. Add `mailbox_hash` to `inbound_emails`:
   ```sql
   ALTER TABLE "inbound_emails" ADD COLUMN "mailbox_hash" text;
   CREATE INDEX "inbound_emails_mailbox_hash_idx" ON "inbound_emails" ("mailbox_hash");
   ```

2. Create `outbound_emails` per Deliverable 10.

3. Loop status enum migration per Deliverable 12.

4. Add a partial unique index on `(loops.inbound_email_id)` is NOT desired (one email can produce multiple loops), so instead enforce the per-email idempotency via a new `loop_extractions` ledger table to be deferred to Phase 6; for Phase 2.5 the persistence-level guard is a `SELECT 1 FROM loops WHERE inbound_email_id = $1 LIMIT 1` before extract. No schema change needed for the guard.

Schema file (`src/db/schema.ts`) changes: drop `due_soon`/`overdue` from `loopStatusEnum`, add `mailbox_hash` text column on `inboundEmails`, add `outboundEmails` table definition with `$inferSelect` export.

## Events

No new Inngest event names in Phase 2.5. Existing events continue to fire from the capture branch. `email.classified` now fires from every branch (not just capture); its `intent` field becomes load-bearing for later metrics.

Payload-shape change: `email.classified.data` adds `branch: "capture" | "command" | "approval" | "question" | "correction"` (mirrors `intent`, kept distinct for forward compatibility with multi-intent emails).

## Task Breakdown

Tasks are grouped into three waves. Tasks within a wave touch disjoint file sets and can be executed by separate agents in parallel. Each wave must finish before the next begins because Wave B and C consume APIs that Wave A introduces.

### Wave A — independent foundations (parallel)

**A1 — Promote `classifyIntent` into its own module.**
Files: create `src/agent/classify-intent.ts`, edit `src/agent/extract-loops.ts`.
Move the `classifyIntent` function out of `extract-loops.ts` into `src/agent/classify-intent.ts` as `classifyEmailIntent({ body, subject })`. Export an `EmailIntent` type. `extract-loops.ts` imports it. Add `src/agent/classify-intent.test.ts` covering each of the five intents (correction, command, approval, question, capture default) including the existing edge cases used in `extract-loops.test.ts`.

**A2 — Add `mailbox_hash` capture.**
Files: edit `src/email/normalize.ts`, edit `src/email/fixtures/postmark.ts`, edit `src/db/schema.ts`, create migration `0003_phase2_5_hardening.sql` (this task owns only the `mailbox_hash` ALTER and index portion — Wave A3 owns enum portion, Wave B owns outbound_emails portion; consolidate before commit).
Add top-level `MailboxHash: z.string().optional().default("")` to `postmarkInboundSchema`. Expose `mailboxHash: string | null` on `NormalizedEmail` (null when empty). Update `DrizzleInboundEmailRepository.createInboundEmailForUser` to persist it. Add a new fixture variant `nudgeReplyPostmarkFixture` that sets `MailboxHash: "n_00000000-0000-0000-0000-000000000001"`.

**A3 — Loop status enum migration.**
Files: edit `src/db/schema.ts`, edit `src/agent/schemas.ts` (drop `due_soon`/`overdue` from the Zod enum), add migration SQL per Deliverable 12, create `src/loops/urgency.ts` + `urgency.test.ts`.
Run `grep -r "due_soon\|overdue" src app` and update every callsite; today the only callsites are `src/db/schema.ts`, `src/agent/schemas.ts`, the existing migration `0002_phase2_loops.sql` (do NOT edit historical migrations), and the docs (out of scope for this task). Add a unit test asserting `LoopStatus` cannot equal `"due_soon"` at the type level (via `// @ts-expect-error`).

**A4 — Workflow idempotency config.**
Files: edit `src/workflows/functions/process-email.ts`.
Add `idempotency: "event.data.inboundEmailId"` to the `createFunction` options object. Verify against `inngest@4.5.1` types (`node_modules/inngest/components/InngestFunction.d.ts` line 170 confirms the field is `string` and treated as a CEL expression). Pure config change; no logic change here.

### Wave B — outbound + reply round-trip (parallel after Wave A)

**B1 — Outbound sender + `outbound_emails` table.**
Files: create `src/email/outbound.ts`, extend migration `0003_phase2_5_hardening.sql` with the `outbound_emails` DDL from Deliverable 10, add `outboundEmails` to `src/db/schema.ts`, create `src/email/outbound.test.ts`.
Implement `EmailSender`, `DevRecordingSender` (uses `getDb()` and inserts into `outbound_emails`, flips `nudges.status` to `sent`). Test against a real in-memory db (using existing test harness pattern in `loops/service.test.ts`).

**B2 — Nudge ordinal map at creation.**
Files: edit `src/loops/service.ts`, edit `src/loops/repository.ts`, edit `src/loops/service.test.ts`.
Inside `processInboundEmailForLoops`, when building the nudge metadata, include `ordinalMap: Object.fromEntries(persistedLoops.map((loop, i) => [i + 1, loop.id]))`. Add a `kind: "private_reply"` field. Update `LoopProcessingRepository.createPrivateReplyNudge`'s metadata type to be explicit about these fields. Update the existing test to assert the map.

**B3 — `sendNudge` service + Inngest hook.**
Files: create `src/loops/send-nudge.ts`, create `src/loops/send-nudge.test.ts`, edit `src/workflows/functions/process-email.ts`.
After the capture branch creates the nudge, the workflow calls `sendNudge` via `step.run("send-private-reply", ...)` with a `DevRecordingSender`. `sendNudge` constructs the `Reply-To` as `agent+n_<nudgeId>@keeps.ai` (use a helper `buildNudgeReplyTo(nudgeId)` exported from `src/email/outbound.ts`), pulls `In-Reply-To` from the source inbound email's provider message id, and emits the headers in the recorded message.

**B4 — Reply-to-nudge resolution helper.**
Files: create `src/loops/resolve-reply-target.ts`, create `src/loops/resolve-reply-target.test.ts`.
Export `resolveReplyTarget(email: NormalizedEmail, deps: { db }): Promise<{ nudgeId: string; loops: PersistedLoop[] } | null>`. Resolution order: (1) parse `mailboxHash` for `^n_([0-9a-f-]+)$`, look up `nudges` by id; (2) fallback: parse `email.headers["in-reply-to"]` and look up `outbound_emails.in_reply_to`. Returns the nudge plus the loops referenced by its `metadata.ordinalMap` (ordered by ordinal). Tests cover both paths and the no-match case.

### Wave C — workflow router wiring (after Waves A and B)

**C1 — Remove inline processing from the route.**
Files: edit `app/api/email/inbound/route.ts`.
Strip the `localProcessing` block, the `shouldDispatchWorkflow` flag, the `DrizzleLoopProcessingRepository` import, and the `processInboundEmailForLoops` import. Always pass `sendEvent: sendWorkflowEvent`. Response becomes `{ accepted: true, status: result.status, email, reply }` with HTTP 202.

**C2 — Intent router in `process-email`.**
Files: edit `src/workflows/functions/process-email.ts`.
After loading the inbound email (new `step.run("load-inbound-email", ...)`), call `classifyEmailIntent`. Then `switch (intent)`:

- `capture` → existing `processInboundEmailForLoops` path (which Wave B2 already updated), then `sendNudge` via `step.run("send-private-reply", ...)`.
- `command` → call `resolveReplyTarget`; if found, call `applyLoopReplyCommand` passing the loops from `metadata.ordinalMap` directly (see C3); if not found, send a "couldn't find which loop you mean" stub reply.
- `correction` → resolve target, insert a `loop_events` row with `event_type = 'corrected'` and `command_text`, send a stub reply ("Got it — I will use that correction.").
- `question` → stub reply ("I will handle questions when Phase 3 ships.").
- `approval` → stub reply ("Approvals land in Phase 3.").

Every branch ends by emitting `email.classified` with `branch` and `intent`. Pre-flight: before any branch runs, check the persistence-level guard from Deliverable 11; if `loops` already exist for this `inboundEmailId`, return `{ status: "already_processed" }` without re-running anything (capture only — other branches still process).

**C3 — `applyLoopReplyCommand` accepts a preloaded loop list.**
Files: edit `src/loops/service.ts`, edit `src/loops/service.test.ts`.
Add an optional `loops?: PersistedLoop[]` argument to `applyLoopReplyCommand`. When provided, skip the `repository.listCommandableLoops` call. The command branch (C2) passes the loops resolved from the nudge's ordinal map. `listCommandableLoops` stays for now (Phase 3 may still use it for digest commands) but it is no longer the resolution path for nudge replies.

## Testing

### Unit tests to update

- **`src/loops/service.test.ts`** — assertions for nudge metadata now include `ordinalMap`. Add a new case: `applyLoopReplyCommand` with a preloaded `loops` arg dismisses the right loop and never touches `listCommandableLoops` (use a spy/mock repo that throws if called).
- **`src/email/inbound.test.ts`** — assert `mailboxHash` flows through `NormalizedEmail` and onto the `inbound_emails` row.
- **`src/agent/extract-loops.test.ts`** — drop the `classifyIntent`-internal cases that have moved to `classify-intent.test.ts`. The remaining tests check only the extraction shape.

### New unit tests

- **`src/agent/classify-intent.test.ts`** — one assertion per intent including the "approval" prefix and "question with trailing `?`" cases.
- **`src/loops/urgency.test.ts`** — `deriveUrgency` returns `overdue` when `dueAt < now`, `due_soon` when `nextCheckAt ≤ now ≤ dueAt`, `null` otherwise.
- **`src/loops/resolve-reply-target.test.ts`** — three cases: mailbox hash hit, In-Reply-To fallback hit, both miss.
- **`src/loops/send-nudge.test.ts`** — `Reply-To` header is `agent+n_<nudgeId>@keeps.ai`, the recorded `outbound_emails.in_reply_to` matches the source inbound email's provider message id, `nudges.status` transitions to `sent`.
- **`src/email/outbound.test.ts`** — `DevRecordingSender` returns a `dev-…@keeps.local` provider message id and persists the row.
- **`src/workflows/functions/process-email.test.ts`** — new file. Cases:
  - Router dispatches `capture` for a plain capture email, `command` for "dismiss 1", `correction` for "correct: …", `question` for "what are my loops?", `approval` for "approve".
  - Idempotent re-run: invoke the workflow twice with the same `inboundEmailId`; the second run returns `already_processed` and creates zero new `loops`/`nudges` rows.
  - Reply round-trip: capture fixture → nudge sent → simulated inbound with `MailboxHash: n_<nudgeId>` and "dismiss 1" → the loop listed as #1 in the nudge ends up `dismissed`.

### Local E2E smoke flow

Document in `docs/dev-smoke.md` (out of scope to write, but the script below should be runnable from the repo root and reproduces the full loop):

1. `pnpm dev` + Inngest dev server + Docker Postgres running.
2. `curl -X POST http://localhost:3000/api/email/inbound -H "x-keeps-webhook-secret: ..." -d @src/email/fixtures/direct.json` → Inngest fires `email.received` → capture branch runs → row appears in `outbound_emails` with `to=arav@example.com` and a `Reply-To` header containing `agent+n_<nudgeId>`.
3. `psql` query: confirm `loops`, `source_evidence`, `nudges (status=sent)`, `outbound_emails` rows exist.
4. Re-`curl` the same fixture: idempotent — no new rows, workflow returns `already_processed`.
5. Build a synthetic reply Postmark fixture with `MailboxHash: "n_<the-nudge-id-from-step-2>"`, body `"dismiss 1"`, post it to the same endpoint → loop #1 transitions to `dismissed`, a `loop_events` row with `event_type='dismissed'` is written, a follow-up nudge ("Dismissed.") is recorded in `outbound_emails`.

### Fixtures needed

- `nudgeReplyPostmarkFixture` in `src/email/fixtures/postmark.ts` (Wave A2).
- `correctionPostmarkFixture` and `questionPostmarkFixture` in the same file (small variants), used by router tests.

## Risks & Open Questions

1. **Inngest `idempotency` expression syntax in v4.5.1.** The type is a bare string and the docs example uses `event.data.foo` form. Recommended default: use the literal string `"event.data.inboundEmailId"`. If the dev server rejects this, fall back to `step.run("dedupe-check", …)` that returns early when the loop guard hits — the persistence guard alone still satisfies the AR-4 intent.

2. **Forwarded emails: which provider message id seeds `In-Reply-To`?** For a forwarded thread the Postmark `MessageID` is the forwarded envelope, not the original. Recommended default: use Postmark `MessageID` (current behaviour). Gmail threading on the *user's* side will still work because the user's reply quotes our outbound, which has its own message id.

3. **Postmark `MailboxHash` parsing rules.** Postmark strips the `+...` suffix into `MailboxHash` only when the recipient is `agent+...@keeps.ai`. Phase 3 approval emails are themselves nudge rows (with `nudge_type='approval'`) and reuse the `n_<nudgeId>` namespace, so no second prefix is currently planned. Recommended default: enforce `^n_[0-9a-f-]+$` and ignore anything else (do not throw).

4. **`outbound_emails` vs reusing `nudges`.** Justification given in Deliverable 10. The risk is a small write amplification (every nudge becomes two rows). Recommended default: accept it — it future-proofs Phase 2.6 (Postmark message id, send status, error metadata) and Phase 3 (digest emails that batch multiple nudges into one outbound message).

5. **Status enum migration in dev.** The local Postgres `keeps-postgres` has data from Phase 2 smoke tests. Recommended default: the migration is safe because no Phase 2 test fixture produces `due_soon`/`overdue` status (extraction always picks `candidate` or `open`). A `pg_dump`-and-restore is not required.

6. **Multiple loops referenced as #1 in different nudges.** If a user has two open nudges and replies "dismiss 1" without a MailboxHash and without an In-Reply-To header, resolution returns null. Recommended default: reply asking the user to reply directly to the nudge in question. Do not guess.

## Out of Scope

- Live Postmark inbound or outbound transport (Phase 2.6).
- Clerk auth swap (Phase 2.6).
- Vercel + Neon deployment (Phase 2.6).
- Cron-based nudge sweep, `loop.nudge_due` event, daily digest (Phase 3 — AR-5).
- Approval `waitForEvent` and signed approval links (Phase 3).
- Query-time use of `deriveUrgency` in digests (Phase 3).
- Real `correction` handling that re-runs extraction with the user's correction text (Phase 3).
- Dead-letter queue / failed-processing replay UI (Phase 6).

## Exit Criteria

- [ ] `app/api/email/inbound/route.ts` no longer imports `processInboundEmailForLoops` or `DrizzleLoopProcessingRepository`.
- [ ] `process-email` workflow file dispatches via a `switch (intent)` block over the five intents.
- [ ] `src/agent/classify-intent.ts` exists; `extract-loops.ts` no longer defines `classifyIntent`.
- [ ] `src/email/outbound.ts` exports `EmailSender` and `DevRecordingSender`.
- [ ] `src/loops/send-nudge.ts` exists and the capture branch calls it.
- [ ] `nudges.metadata.ordinalMap` is present on every newly created private-reply nudge.
- [ ] `outbound_emails` table exists; every recorded send has a `Reply-To` of the form `agent+n_<nudgeId>@keeps.ai`.
- [ ] `loop_status` PG enum has eight values (no `due_soon`, no `overdue`).
- [ ] `LoopStatus` TS union has eight values; `// @ts-expect-error` guard test passes.
- [ ] Replaying `email.received` with the same `inboundEmailId` is a no-op (verified by integration test).
- [ ] E2E smoke flow above passes locally.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` all pass.
