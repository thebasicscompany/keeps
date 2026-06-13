# Idempotency in Keeps

Keeps applies four distinct idempotency layers so that Postmark webhook re-deliveries,
Inngest at-least-once replay, and concurrent DB transactions never produce duplicate
rows, duplicate emails, or double-executed connector actions.

---

## Layer 1 — Inbound webhook deduplication

### Guarantee

A Postmark inbound webhook re-delivered with the same `MessageID` is absorbed
silently: only ONE `inbound_emails` row is ever persisted, and only ONE
`email.received` event is emitted to Inngest.

### Enforcing code

| Component | Location | Mechanism |
|-----------|----------|-----------|
| DB unique index | `src/db/schema.ts` line 292 — `providerMessageIdx: uniqueIndex("inbound_emails_provider_message_unique").on(table.provider, table.providerMessageId)` | Postgres rejects a second INSERT with the same `(provider, providerMessageId)`. |
| In-memory check (service layer) | `src/email/inbound.ts` — `createInboundEmailForUser` port returns `{ duplicate: true }` when the `(provider, providerMessageId)` key already exists. | Drizzle repository mirrors the constraint; tests use an in-memory fake that enforces the same key check. |
| Event suppression | `src/email/inbound.ts` — `handlePostmarkInboundEmail` only calls `sendEvent` with `"email.received"` when `stored.duplicate === false`. | Second delivery calls `sendEvent` zero times. |
| Pending path | `src/db/schema.ts` line 368 — `providerMessageIdx: uniqueIndex("pending_inbound_emails_provider_message_unique").on(table.provider, table.providerMessageId)` | Unknown-sender emails are also deduped before they enter the claim queue. |

### How a replay is absorbed

1. Postmark POSTs the same payload twice.
2. `handlePostmarkInboundEmail` (`src/email/inbound.ts`) calls `repository.createInboundEmailForUser`.
3. The Drizzle repository (`src/email/inbound-repository.ts`) attempts an INSERT;
   Postgres raises a unique-constraint violation on `inbound_emails_provider_message_unique`.
4. The repository catches the violation and returns `{ duplicate: true }`.
5. `handlePostmarkInboundEmail` returns `{ status: "duplicate" }` and skips `sendEvent`.
6. The route handler (`app/api/email/inbound/route.ts` line 69) responds `202` with
   `status: "duplicate"` — Postmark sees a successful response and stops retrying.

### Regression test

`src/email/inbound.test.ts` — "dedupes duplicate provider webhook deliveries" (service level).
`app/api/email/inbound/route.test.ts` — "double-POST: same Postmark payload twice emits only one email.received and persists one row" (HTTP level, added by Phase 6 A5).

---

## Layer 2 — Workflow (process-email) idempotency

### Guarantee

The `process-email` Inngest function executes at most once per unique
`inboundEmailId`, even if Inngest delivers `email.received` multiple times
(at-least-once guarantee).

### Enforcing code

| Component | Location | Mechanism |
|-----------|----------|-----------|
| Inngest idempotency key | `src/workflows/functions/process-email.ts` line 81 — `idempotency: "event.data.inboundEmailId"` | Inngest deduplicates executions sharing the same `inboundEmailId` for the TTL window (24 h default). |

### How a replay is absorbed

Inngest hashes `event.data.inboundEmailId` before enqueuing the run. A second
`email.received` event carrying the same `inboundEmailId` is detected by
Inngest's dedup store before the function body executes; the second run is
discarded and no steps fire.

---

## Layer 3 — Outbound nudge idempotency

### Guarantee

A nudge email is sent exactly once, even if the `send-nudge` step retries
(e.g. transient Postmark error) or the `process-email` workflow re-runs after
an Inngest failure.

### Enforcing code

| Component | Location | Mechanism |
|-----------|----------|-----------|
| Status re-read guard | `src/loops/send-nudge.ts` line 84 — `if (nudge.status === "sent") { return { status: "already_sent", ... }; }` | `sendNudge` reloads the nudge row and bails out immediately if it has already been marked `sent`. |
| Stable nudge id | `src/loops/send-nudge.ts` line 90 — `nudgeId: nudge.id` used as the mailbox hash (`n_${nudge.id}`) and Reply-To path. | The nudge UUID is the stable identity across retries; it is created once and reused. |
| No Inngest-level key on send-nudge | `src/workflows/functions/send-nudge.ts` lines 271-277 — intentionally omits `idempotency:` on the `send-nudge` Inngest function. | Comment explains: a global key would suppress legitimate future nudges for the same loop. In-function `checkNudge` re-validation is the authoritative guard instead. |
| `checkNudge` re-validation | `src/workflows/functions/send-nudge.ts` lines 76-108 — reloads the loop, re-checks `isEligibleForNudge`, re-counts the daily cap. | Sweep emission is a hint; this check is authoritative (Deliverable 5 requirement). |
| process-email self-healing step | `src/workflows/functions/process-email.ts` lines 123-136 — `find-unsent-replies` step collects pending nudge ids; each `send-private-reply-{nudgeId}` step calls `sendNudge` with the stable nudge id. | On retry the step is memoized by Inngest; `sendNudge` returns `already_sent` if the step re-runs after a confirmed send. |
| outbound_emails unique index | `src/db/schema.ts` lines 517-519 — `providerMessageIdx: uniqueIndex("outbound_emails_provider_message_unique").on(table.provider, table.providerMessageId)` | Postmark providerMessageId deduplicates the outbound_emails ledger. |

### How a replay is absorbed

1. Step `send-private-reply-{nudgeId}` fires (or re-fires on retry).
2. `sendNudge` (`src/loops/send-nudge.ts`) calls `repository.findSendableNudge(nudgeId)`.
3. If `nudge.status === "sent"`, returns `already_sent` immediately — no Postmark call.
4. If the nudge is still `pending` (first run or retry before the status flip), the
   email is sent and `store.markNudgeSent` flips the row to `sent`.
5. Concurrent retries are serialized at the DB row level; only the winner that
   successfully records the sent status proceeds.

---

## Layer 4 — Connector action execute-once

### Guarantee

A connector action (Slack DM, calendar event) is executed by the external provider
at most once, even if Inngest delivers `approval.received` multiple times or the
execute step retries.

### Enforcing code

| Component | Location | Mechanism |
|-----------|----------|-----------|
| idempotency_key unique index | `src/db/schema.ts` lines 612-613 — `idempotencyKeyIdx: uniqueIndex("connector_actions_idempotency_key_unique").on(table.idempotencyKey)` | Postgres rejects a second `connector_actions` INSERT with the same key. |
| Key construction | `src/workflows/functions/handle-connector-command.ts` line 309 — `idempotencyKey: \`connector:${input.provider}:${request.id}\`` | The approval request UUID (a one-time token per user intent) is the unique anchor; the key is deterministic and stable across retries. |
| Inngest workflow idempotency | `src/workflows/functions/handle-connector-command.ts` line 385 — `idempotency: "event.data.inboundEmailId"` | Prevents two `handle-connector-command` executions for the same inbound email from both reaching the execute step. |
| FOR UPDATE execute-once lock | `src/connectors/execute.ts` — `executeConnectorAction` reads the row with `FOR UPDATE`, re-checks `status !== "pending"` inside the lock, and returns the cached result if already `completed`/`failed`. | Serializes concurrent retries at Postgres level; only one transaction calls the provider. |

### How a replay is absorbed

1. Inngest re-delivers `approval.received` (at-least-once).
2. The `execute-connector-action` step in `handle-connector-command` calls
   `executeConnectorAction({ connectorActionId })`.
3. `executeConnectorAction` acquires a row-level `FOR UPDATE` lock on `connector_actions`.
4. If `status` is already `completed` or `failed`, returns the cached result immediately
   without calling Composio.
5. If `status` is still `pending` (first run), calls the provider, writes the result,
   and flips `status` to `completed`.
6. Concurrent re-deliveries block on the lock and observe `completed` on acquisition —
   they return the cached result.

### Existing regression test

`src/connectors/__tests__/e2e-slack-idempotent.test.ts` — DB-gated (`describe.skipIf(!TEST_DATABASE_URL)`) —
drives `executeConnectorAction` concurrently twice, asserts `callCount === 1` and
exactly one `completed` row.

---

## Summary table

| Layer | Trigger | Absorbing mechanism | Idempotency key |
|-------|---------|---------------------|-----------------|
| 1. Inbound webhook | Postmark re-delivery | `inbound_emails_provider_message_unique` unique index + service-layer duplicate check | `(provider, providerMessageId)` |
| 2. Workflow execution | Inngest at-least-once `email.received` | `idempotency: "event.data.inboundEmailId"` in `createFunction` | `inboundEmailId` UUID |
| 3. Outbound nudge | Step retry / workflow rerun | `nudge.status === "sent"` re-read guard + `outbound_emails` unique index | `nudgeId` UUID |
| 4. Connector action | `approval.received` at-least-once / step retry | `connector_actions_idempotency_key_unique` + FOR UPDATE execute-once | `connector:{provider}:{approvalRequestId}` |
