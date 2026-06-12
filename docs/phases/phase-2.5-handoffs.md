# Phase 2.5 Execution Handoffs

Five agent prompts across three sequential waves. Within a wave, agents run in parallel (separate terminals, same repo — file ownership is disjoint by design). A wave starts only after the previous wave's agents have committed and `pnpm typecheck && pnpm test` passes.

Launch each with a fresh session (Opus is sufficient — these are well-specified execution tasks):

```sh
cd /Users/aravb/Developer/keeps && claude --model claude-opus-4-7
```

Paste one prompt per session. Preconditions for all: Docker Postgres `keeps-postgres` on 55433 running, `.env.local` present. Each agent commits its own work when its checks pass.

---

## Wave A (run A-1 and A-2 in parallel)

### Prompt A-1 — classifier module + idempotency config

```
You are executing two tasks from a frozen plan for Keeps, an email-first work-memory product. Read docs/phases/phase-2.5-pipeline-hardening.md fully first — execute tasks A1 and A4 from its Task Breakdown exactly as specified, plus their acceptance criteria in Deliverables 3 and 11.

Task A1: promote classifyIntent out of src/agent/extract-loops.ts into a new src/agent/classify-intent.ts exporting classifyEmailIntent and EmailIntent; extract-loops.ts imports it (no duplicate left). Create src/agent/classify-intent.test.ts covering all five intents.

Task A4: add idempotency: "event.data.inboundEmailId" to the createFunction options in src/workflows/functions/process-email.ts. Verify the field against node_modules/inngest/components/InngestFunction.d.ts (~line 170) before assuming syntax.

You own ONLY: src/agent/classify-intent.ts (new), src/agent/classify-intent.test.ts (new), src/agent/extract-loops.ts, src/agent/extract-loops.test.ts (move relocated cases out), src/workflows/functions/process-email.ts (the options object only — do not touch handler logic; another agent owns it next wave). Do not modify src/db/schema.ts or any migration.

When done: pnpm typecheck && pnpm test must pass. Then commit ONLY your files with message "Phase 2.5 A1+A4: dedicated intent classifier; workflow idempotency key". Report briefly: what changed, test counts, any deviation from the plan and why.
```

### Prompt A-2 — MailboxHash capture + status enum migration

```
You are executing two tasks from a frozen plan for Keeps, an email-first work-memory product. Read docs/phases/phase-2.5-pipeline-hardening.md fully first — execute tasks A2 and A3 from its Task Breakdown exactly as specified, with acceptance criteria from Deliverables 7 and 12 and the Data & Migrations section.

Task A2: top-level MailboxHash in postmarkInboundSchema (src/email/normalize.ts), mailboxHash on NormalizedEmail, persist to a new inbound_emails.mailbox_hash column (indexed), nudgeReplyPostmarkFixture + correctionPostmarkFixture + questionPostmarkFixture in src/email/fixtures/postmark.ts.

Task A3: remove due_soon/overdue from the loop_status enum using the rename-swap migration SQL given verbatim in Deliverable 12; update src/db/schema.ts and src/agent/schemas.ts; grep for remaining literals; create src/loops/urgency.ts (deriveUrgency) + urgency.test.ts including the @ts-expect-error type guard.

You own the migration file src/db/migrations/0003_phase2_5_hardening.sql — create it with the mailbox_hash ALTER + index AND the enum migration, and leave a clearly marked section comment "-- outbound_emails added in Wave B" (a later agent appends there). Note: drizzle-kit generate may not produce this exact SQL — write the migration by hand following Deliverable 12 and keep schema.ts in sync; verify with pnpm db:migrate against local Postgres.

You own ONLY: src/email/normalize.ts, src/email/inbound-repository.ts (persist mailboxHash), src/email/fixtures/postmark.ts, src/email/inbound.test.ts (mailboxHash flow assertions), src/db/schema.ts, src/agent/schemas.ts, the new migration, src/loops/urgency.ts(+test). Do not touch src/agent/extract-loops.ts or src/workflows/ (other agents own them).

When done: pnpm db:migrate, then pnpm typecheck && pnpm test must pass. Commit ONLY your files with message "Phase 2.5 A2+A3: MailboxHash capture; lifecycle-only loop_status". Report briefly: what changed, migration verified against local PG, any deviation and why.
```

---

## Wave B (after Wave A commits; run B-1 and B-2 in parallel)

### Prompt B-1 — outbound sender + sendNudge

```
You are executing tasks B1 and B3 from the frozen plan docs/phases/phase-2.5-pipeline-hardening.md for Keeps (email-first work-memory product). Read the plan fully first — Deliverables 8, 9, 10 are your spec. Wave A is already merged: classify-intent.ts exists, migration 0003 exists with a marked section for outbound_emails.

B1: create src/email/outbound.ts (OutboundEmail type with htmlBody?, EmailSender interface, DevRecordingSender, buildNudgeReplyTo helper), append the outbound_emails DDL (Deliverable 10) into the marked section of src/db/migrations/0003_phase2_5_hardening.sql, add outboundEmails to src/db/schema.ts, write src/email/outbound.test.ts.

B3: create src/loops/send-nudge.ts + send-nudge.test.ts per Deliverable 9. In src/workflows/functions/process-email.ts, add a step.run("send-private-reply", ...) after nudge creation that calls sendNudge with DevRecordingSender. Make the smallest workflow edit possible — the full router rewrite happens in Wave C by another agent.

You own ONLY: src/email/outbound.ts(+test), src/loops/send-nudge.ts(+test), src/db/schema.ts (outboundEmails addition only), the migration's marked section, src/workflows/functions/process-email.ts (send step only). Do not touch src/loops/service.ts, repository.ts, or resolve-reply-target (parallel agent owns those).

When done: pnpm db:migrate, pnpm typecheck && pnpm test pass. Commit ONLY your files: "Phase 2.5 B1+B3: outbound sender interface, dev transport, sendNudge". Brief report: what changed, deviations.
```

### Prompt B-2 — ordinal map + reply-target resolution

```
You are executing tasks B2 and B4 from the frozen plan docs/phases/phase-2.5-pipeline-hardening.md for Keeps (email-first work-memory product). Read the plan fully first — Deliverables 6 and 7 (resolution order) are your spec. Wave A is merged: NormalizedEmail.mailboxHash exists, nudgeReplyPostmarkFixture exists.

B2: in src/loops/service.ts processInboundEmailForLoops, write ordinalMap (1-based ordinal → loopId, ordered as listed in the reply body) and kind: "private_reply" into nudge metadata; tighten the createPrivateReplyNudge metadata type in the LoopProcessingRepository contract (src/loops/repository.ts); update src/loops/service.test.ts assertions.

B4: create src/loops/resolve-reply-target.ts + test per task B4: resolveReplyTarget resolves (1) mailboxHash ^n_<uuid>$ → nudges by id, (2) fallback In-Reply-To header → outbound_emails.in_reply_to lookup, (3) null on miss; returns the nudge plus loops from metadata.ordinalMap ordered by ordinal. If outbound_emails (a parallel agent is adding it to schema.ts in src/email/outbound work) is not yet in the schema when you start, write resolve-reply-target against the table name via the schema export and coordinate by finishing B2 first — if it is still absent, stub the fallback query behind a clearly named TODO function and note it in your report; the mailboxHash path must be fully implemented and tested regardless.

You own ONLY: src/loops/service.ts, src/loops/repository.ts, src/loops/service.test.ts, src/loops/resolve-reply-target.ts(+test). Do not touch src/email/outbound.ts, send-nudge, schema.ts, migrations, or workflows.

When done: pnpm typecheck && pnpm test pass. Commit ONLY your files: "Phase 2.5 B2+B4: nudge ordinal map, reply-target resolution". Brief report: what changed, whether the In-Reply-To fallback landed or was stubbed, deviations.
```

---

## Wave C (after Wave B commits; single agent)

### Prompt C — route cleanup + intent router

```
You are executing tasks C1, C2, C3 from the frozen plan docs/phases/phase-2.5-pipeline-hardening.md for Keeps (email-first work-memory product). Read the plan fully first — Deliverables 1, 2, 4, 5, 11 and the Testing section are your spec. Waves A and B are merged: classify-intent, mailboxHash, outbound sender, sendNudge, ordinalMap, resolveReplyTarget all exist. If B-2's report noted the In-Reply-To fallback was stubbed, finish it now (outbound_emails is in the schema).

C1: strip inline processing from app/api/email/inbound/route.ts per Deliverable 1.

C2: rewrite src/workflows/functions/process-email.ts as the intent router per Deliverable 2 and task C2 (load step → classifyEmailIntent → switch with capture/command/correction/question/approval branches; persistence guard before capture per Deliverable 11; every branch emits email.classified with intent + branch; every branch produces a private reply through sendNudge).

C3: add the optional preloaded loops argument to applyLoopReplyCommand in src/loops/service.ts per task C3.

Then write src/workflows/functions/process-email.test.ts covering: branch dispatch for all five intents, idempotent re-run (zero new rows, already_processed), and the full reply round-trip (capture → nudge sent → simulated reply fixture with MailboxHash n_<nudgeId> + "dismiss 1" → correct loop dismissed). Finally run the E2E smoke flow from the plan's Testing section against the local stack (dev server + Inngest dev server + Postgres) and record the results.

You own the whole repo this wave; still keep changes minimal and within the plan. When done: pnpm typecheck && pnpm test && pnpm build pass, smoke flow verified. Commit in logical chunks (C1; C2+C3+tests): messages "Phase 2.5 C1: single Inngest path through inbound route" and "Phase 2.5 C2+C3: intent router with nudge-scoped reply commands". Report: smoke results, all Exit Criteria from the plan checked off or listed as failing.
```

---

## After Wave C

Walk the Exit Criteria checklist at the bottom of `phase-2.5-pipeline-hardening.md`. Anything unchecked becomes a follow-up task before Phase 2.6 starts.
