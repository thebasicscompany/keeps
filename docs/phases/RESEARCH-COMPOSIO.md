# RESEARCH-COMPOSIO.md — Composio TypeScript SDK surface for Phase 4 (Slack & Calendar connectors)

> Wave 0 research deliverable. Verified 2026-06-13 against the **current** Composio TS SDK (`@composio/core@0.10.0`), the live docs at docs.composio.dev, and **read-only probes of the live Composio account** (the `backend`/`prd` Doppler `COMPOSIO_API_KEY`). All API surface below is verified, not from memory. Downstream Wave B/C/D agents code FROM THIS DOC.
>
> Secrets discipline: this doc contains **no API key**. Auth-config ids, connected-account ids, toolkit slugs, entity (userId) values, and statuses are operational identifiers, not secrets, and are reported below so implementers can target the right config.

---

## Decisions for implementers (read this first)

| Decision | Value |
|---|---|
| **Package** | `@composio/core@0.10.0` (npm `latest`). `composio-core` is **DEPRECATED** ("Package no longer supported") — do **not** install it. |
| **Install** | `pnpm add @composio/core` (no extra provider package needed for raw action execution — `tools.execute` works on the core client; provider packages like `@composio/vercel` are only for LLM tool-calling, which we do **not** need). |
| **Client** | `new Composio({ apiKey: env.COMPOSIO_API_KEY })`, instantiated server-side as a singleton. |
| **Entity strategy** | Use the **Keeps internal user UUID** as Composio's `userId`. **Confirmed valid + already in use** in this account (live: connected accounts under userIds like `d7f505a5-…`, `aa9dd140-…`, `0b86dc25-…`). In v3 the term is `userId` (the entity model). Store it as `composio_entity_id` for clarity. |
| **Slack auth config** | `ac_GqhvFeSbsPsv` (toolkit `slack`, ENABLED, Composio-managed OAuth, 156 connections). |
| **Google Calendar auth config** | `ac_j7dp3poETzpU` (toolkit `googlecalendar`, ENABLED, Composio-managed OAuth, 17 connections). |
| **Slack DM slugs** | `SLACK_FIND_USER_BY_EMAIL_ADDRESS` → user id, then `SLACK_SEND_MESSAGE` (or `SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL`) with `channel = <userId|D…>`. Optional explicit `SLACK_OPEN_DM` to get the `D…` channel first. |
| **Calendar slug** | `GOOGLECALENDAR_CREATE_EVENT` (`calendar_id: "primary"`). |
| **Execute API** | `composio.tools.execute(SLUG, { userId, arguments, connectedAccountId? })` → returns `{ data, successful, error }` (**does not throw on action failure** — check `successful`). |
| **Webhook verdict** | Composio **DOES** emit connection-lifecycle webhooks (Svix-style: `webhook-id` / `webhook-timestamp` / `webhook-signature` headers, HMAC-SHA256). Verify with `composio.triggers.verifyWebhook(...)`. **However** a hard `revoked` push event is NOT guaranteed for every revocation path — see Q6. **Build both** the webhook handler AND a status-poll sweep on the AR-5 cadence. |
| **Revocation detection at execute time** | Executing against a non-ACTIVE account fails with `successful:false`; also poll `connectedAccounts.get(id).status` (`ACTIVE` / `EXPIRED` / `REVOKED` / `INACTIVE` / `INITIATED` / `FAILED`) and the human-readable `status_reason`. |
| **Idempotency** | Composio has **no execute-side idempotency key**. Keeps' own execute-once layer (`connector_actions` SELECT FOR UPDATE) is the source of truth. Don't rely on Composio dedupe. |

---

## Q1 — Package name + version

- **Current package:** `@composio/core`, current major **`0.10.0`** (npm dist-tag `latest`, verified `npm view @composio/core version` → `0.10.0`).
- **Deprecated package:** `composio-core` (last `0.5.39`) → npm reports `deprecated: "Package no longer supported."` **Do not use.** Anything you find online referencing `composio-core`, `OpenAIToolSet`, `Entity`, `entityId`, or `executeAction` is the **old (v1)** SDK and does not apply.
- **Install:**
  ```sh
  pnpm add @composio/core
  ```
- **Sub-packages:** none required for our use. `@composio/client` (low-level REST) and `@composio/json-schema-to-zod` are transitive deps of core. Provider adapters (`@composio/vercel`, `@composio/openai`, …) are only needed when you hand Composio tools to an LLM for tool-calling — **Keeps does not**; we call specific action slugs directly, so core alone suffices.
- Note: `@composio/core` pulls `openai@^6` and `pusher-js` as transitive deps — harmless, but be aware of the install footprint.

Sources: npm `@composio/core` (`latest=0.10.0`); npm `composio-core` (deprecated); <https://docs.composio.dev/docs/migration-guide/new-sdk>.

---

## Q2 — Client construction (server-side)

Instantiate once and reuse (Composio holds connection/state). Put this in `src/connectors/composio.ts`.

```ts
import { Composio } from "@composio/core";
import { env } from "@/config/env"; // add COMPOSIO_API_KEY + COMPOSIO_WEBHOOK_SECRET

let _composio: Composio | null = null;

/** Singleton Composio client. Server-only — never import into client components. */
export function getComposio(): Composio {
  if (!_composio) {
    _composio = new Composio({ apiKey: env.COMPOSIO_API_KEY });
  }
  return _composio;
}
```

- The constructor accepts `{ apiKey }`. If omitted, the SDK reads `process.env.COMPOSIO_API_KEY`. **Pass it explicitly** (Keeps centralizes env in `src/config/env.ts`).
- Auth is sent as the `x-api-key` header to `https://backend.composio.dev` (confirmed live).
- Do **not** pass a `provider` — that's only for LLM tool-calling adapters.

Source: <https://docs.composio.dev/type-script/core-classes/composio>.

---

## Q3 — Entity / user model

- v3 terminology is **`userId`** (a free-form string you choose; it is the "entity" that owns connected accounts). The old v1 `Entity`/`entityId` concept is gone.
- **Keeps strategy (confirmed valid):** pass the **Keeps internal user UUID** as `userId` on every `connectedAccounts.initiate`, `connectedAccounts.list`, and `tools.execute` call. The live account already uses UUID userIds (e.g. `d7f505a5-917d-4f5e-9fd8-d2b6c4fcf170` has ACTIVE gmail+drive; `aa9dd140-…` has linkedin/gcal; `0b86dc25-…` has many slack accounts). So a Keeps UUID maps cleanly to a Composio userId — **no transformation needed**.
- Persist on `connector_accounts`: `composio_entity_id` = the Keeps user UUID (what we send as `userId`), `composio_connected_account_id` = the `ca_…` id Composio returns (the thing you pass to `tools.execute` as `connectedAccountId` and to `connectedAccounts.get/delete`).
- One userId can have **many** connected accounts per toolkit (the live data shows dozens of slack `ca_…` rows under one userId, mostly stale). Treat the **most recent ACTIVE** `ca_…` per (userId, toolkit) as canonical; reconcile on the connect webhook / hydration step.

Source: <https://docs.composio.dev/docs/authenticating-tools>; live probe of `/api/v3/connected_accounts`.

---

## Q4 — Connect flow (initiate → redirect → ACTIVE), list, disconnect

### Initiate a connection (server action, Clerk-gated)
```ts
const composio = getComposio();

// Slack:        authConfigId = "ac_GqhvFeSbsPsv"
// Google Cal:   authConfigId = "ac_j7dp3poETzpU"
const conn = await composio.connectedAccounts.initiate(
  keepsUserUuid,          // userId (the entity = Keeps user UUID)
  authConfigId,           // the toolkit's auth config id (table above)
  {
    callbackUrl: `${env.APP_ORIGIN}/settings/connectors?toolkit=slack`,
  },
);

// Send the browser here to do the OAuth dance (managed by Composio):
return { redirectUrl: conn.redirectUrl, connectionRequestId: conn.id };
```
- This is a **redirect-URL** flow (Composio-managed OAuth). There is **no separate hosted Connect-UI widget you must embed** like Nango's `@nangohq/frontend`; you just `window.location = redirectUrl` (or open it). Composio hosts the consent screen and bounces back to `callbackUrl`.
- `conn.id` is the connection-request id; `conn.redirectUrl` is the OAuth URL.

### Wait for ACTIVE
Two options — **do not block an Inngest step on this**; prefer webhook/poll. For the settings page or a short poll:
```ts
// From the request object:
const account = await conn.waitForConnection(120_000); // ms timeout
// Or by id (e.g. after a page reload):
const account = await composio.connectedAccounts.waitForConnection(conn.id, 60_000);
console.log(account.id, account.status); // "ca_…", "ACTIVE"
```

### List / get / delete
```ts
// List a user's accounts, filtered:
const { items } = await composio.connectedAccounts.list({
  userIds: [keepsUserUuid],
  authConfigIds: ["ac_GqhvFeSbsPsv"],   // optional
  statuses: ["ACTIVE"],                  // optional
});

// Get one (status check / hydration):
const acct = await composio.connectedAccounts.get(connectedAccountId);
// acct.status, acct.status_reason, acct.user_id, acct.toolkit.slug, acct.auth_config.id

// Disconnect (permanent):
await composio.connectedAccounts.delete(connectedAccountId);
```
- **Statuses observed live:** `ACTIVE`, `INITIATED`, `EXPIRED`, `REVOKED`, `FAILED`, `INACTIVE`. Only `ACTIVE` can execute tools.
- **Caveat (from docs):** deleting a connected account removes Composio's credentials but does **not** necessarily revoke the upstream token at Slack/Google — it may live until natural expiry. For Keeps "disconnect", `delete()` is correct; surface it to the user as "Keeps will no longer act on your behalf."
- Connected-account detail (verified live) carries useful fields: `status`, `status_reason` (human string, e.g. `"Revoked via admin tool"`, `"Connection initiation did not complete within 10 minutes"`), `is_disabled`, `user_id`, `toolkit.slug`, `auth_config.id`, `created_at`, `updated_at`, plus `requested_scopes`/`requested_user_scopes`. Use these to fill `external_account_*` columns in C3 hydration.

Sources: <https://docs.composio.dev/docs/authenticating-tools>; <https://docs.composio.dev/docs/connected-accounts>; live `/api/v3/connected_accounts/{id}`.

---

## Q5 — Executing actions

### Canonical execute call
```ts
const res = await composio.tools.execute(SLUG, {
  userId: keepsUserUuid,
  arguments: { /* action-specific, snake_case */ },
  connectedAccountId, // optional but RECOMMENDED: pin to the exact ca_… we approved
});
// res shape: { data: {...}, successful: boolean, error: string | null }
```
- **Always pass `connectedAccountId`** (the `ca_…` we recorded at approval time) so a user with multiple stale accounts can't accidentally fire through the wrong one. If omitted, Composio resolves by `(userId, toolkit)`.
- **Universal response wrapper (verified on the live tool schema):** every tool returns `{ data, successful, error }`. The upstream API payload (Slack/Google JSON) lives under **`res.data`**. `successful` is the gate; `error` is a string when it failed.

### Slack — send a DM to a person (by email)

Composio exposes 133 Slack tools. The relevant slugs (verified live):

| Purpose | Slug | Required args |
|---|---|---|
| Look up user by email | `SLACK_FIND_USER_BY_EMAIL_ADDRESS` | `email` (string) |
| (optional) open DM channel | `SLACK_OPEN_DM` | user id(s) |
| Send message | `SLACK_SEND_MESSAGE` *(alias of `SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL`)* | `channel` (string) |
| List users (fallback) | `SLACK_LIST_ALL_USERS` / `SLACK_FIND_USERS` | — |

`SLACK_SEND_MESSAGE` arg notes (verified): only **`channel`** is required. For message body, **prefer `markdown_text`** (the `text` and `blocks` fields are marked DEPRECATED in the live schema). `channel` accepts a channel id, a `D…` DM channel id, **or a user id** (Slack's `chat.postMessage` opens the 1:1 DM when you pass a user id as `channel`). Other useful optional args: `thread_ts`, `as_user`, `unfurl_links`.

**Recommended `resolveSlackUser` + `executeSlackDm` flow:**
```ts
// 1) resolve recipient by email
const lookup = await composio.tools.execute("SLACK_FIND_USER_BY_EMAIL_ADDRESS", {
  userId, connectedAccountId,
  arguments: { email: recipientEmail },
});
if (!lookup.successful) {
  // not_found / users_not_found → return "recipient not on this Slack workspace"
}
// Slack payload under lookup.data (typically lookup.data.user.id, lookup.data.user.profile…)
const slackUserId = lookup.data?.user?.id;

// (ambiguity: SLACK_FIND_USER_BY_EMAIL is exact-match 1 user; for name-based resolution
//  use SLACK_FIND_USERS / SLACK_LIST_ALL_USERS and apply the AR recipient-ambiguity gate.)

// 2) send the DM (passing the user id as `channel` opens the 1:1 DM)
const send = await composio.tools.execute("SLACK_SEND_MESSAGE", {
  userId, connectedAccountId,
  arguments: { channel: slackUserId, markdown_text: messageBody },
});
if (!send.successful) throw new ConnectorExecutionError(send.error);
// success payload under send.data: { ok: true, ts: "...", channel: "D…", message: {...} }
```
> **Verify the exact `data` nesting at integration time** by running one real lookup/send against Arav's ACTIVE account (the Slack `ok`/`ts`/`channel`/`user.id` keys mirror Slack's own API, but Composio sometimes nests under `data.response_data` — see the Calendar wrapper below; do a single live probe before hard-coding the path). If you want to be explicit, do `SLACK_OPEN_DM` first to obtain the `D…` channel, then send to that channel id.

### Google Calendar — insert an event on primary

Slug: **`GOOGLECALENDAR_CREATE_EVENT`**. Verified input schema (snake_case):

| Arg | Type | Notes |
|---|---|---|
| `start_datetime` | string **(required)** | **Naive** local datetime `YYYY-MM-DDTHH:MM:SS` — **no `Z`, no offset.** |
| `timezone` | string | IANA tz (e.g. `America/New_York`). **Required when** datetime has no offset — always send it for Keeps (we have `users.timezone`). |
| `event_duration_hour` | integer | 0–24. |
| `event_duration_minutes` | integer | 0–59 **only** (never ≥60 — bump the hour field instead). |
| `summary` | string | Event title. |
| `description` | string | Optional, may contain HTML. |
| `location` | string | Free-form. |
| `attendees` | array<string> | Attendee **emails**. |
| `calendar_id` | string | Use `"primary"`. |
| `send_updates` | boolean | Default true — sends invites to attendees. |
| `create_meeting_room` | boolean | True → adds a Google Meet link. |
| `visibility`, `transparency`, `recurrence`, `guests_can_modify`, … | — | Optional. |

**Reminder overrides (popup N minutes before):** `GOOGLECALENDAR_CREATE_EVENT` does **not** expose a dedicated `reminders`/`overrides` argument in the live input schema. Options for the "popup N min before" requirement:
1. Create the event, then `GOOGLECALENDAR_PATCH_EVENT` / `GOOGLECALENDAR_UPDATE_EVENT` to set `reminders.overrides` if those slugs accept it (probe their input schema first), **or**
2. Accept Google's default calendar reminders for v1 and treat custom popup-minutes as a follow-up. **Flag to the planner:** custom reminder overrides are not first-class on CREATE_EVENT — confirm the desired behavior before B2 hard-commits.

```ts
const res = await composio.tools.execute("GOOGLECALENDAR_CREATE_EVENT", {
  userId, connectedAccountId,
  arguments: {
    calendar_id: "primary",
    summary: title,
    start_datetime: "2026-06-20T15:00:00", // naive, user-local
    timezone: userIanaTz,                  // e.g. "America/Los_Angeles"
    event_duration_hour: 0,
    event_duration_minutes: 30,
    attendees: attendeeEmails,             // optional
    send_updates: true,
  },
});
```

**Calendar response shape (verified from the live tool's `output_parameters`):**
```
{
  successful: boolean,
  error: string | null,
  data: { response_data: { /* full Google Calendar event resource */ } }
}
```
So the created event lives at **`res.data.response_data`** — read `res.data.response_data.id` (event id) and `res.data.response_data.htmlLink` (event URL) for the confirmation email. (Note the nesting: `data.response_data`, not `data` directly. Double-check Slack's nesting the same way.)

Sources: live `/api/v3/tools/{slug}` schemas for `SLACK_FIND_USER_BY_EMAIL_ADDRESS`, `SLACK_SEND_MESSAGE`, `GOOGLECALENDAR_CREATE_EVENT`; <https://docs.composio.dev/docs/tools-direct/executing-tools>; <https://docs.composio.dev/toolkits/slack>.

---

## Q6 — Webhooks (connection lifecycle)

**Verdict: Composio DOES emit connection-lifecycle webhooks**, but treat the revoked/expired push as **best-effort** — also build a poll sweep.

- Composio has two webhook families: **trigger** webhooks (toolkit event triggers) and **project event** webhooks (system notifications, including connected-account lifecycle). Connection events are project events, e.g. **`composio.connected_account.expired`** (fires when OAuth connections expire) and related `composio.connected_account.*` (created / active / deleted / failed). The exact full enum is **not enumerated in public docs**; subscribe broadly to `composio.connected_account.*` in the dashboard webhook config and switch on the event `type` string in the handler.
- **Caveat that drives the design:** the docs explicitly note `composio.trigger.disabled` fires **only for platform-initiated disables**, NOT when you disable/delete an account yourself or revoke upstream. And deleting an account doesn't revoke upstream tokens. So **a user revoking Keeps' access directly at Slack/Google may not produce a timely Composio webhook.** → **Build the status-poll sweep** (per the Phase-4 handoff: poll `connectedAccounts.get(id).status` on the AR-5 sweep cadence and mark non-ACTIVE accounts as needing reconnect). The webhook is the fast path; the sweep is the guarantee.

### Headers & signature (Svix-style, HMAC-SHA256)
Every webhook request carries:
- `webhook-id`
- `webhook-timestamp`
- `webhook-signature`  (format `v1,<base64sig>`)

Secret = `COMPOSIO_WEBHOOK_SECRET` (from dashboard → Project Settings → Webhook; may be `whsec_…` base64).

**Preferred — SDK verifier:**
```ts
const result = await getComposio().triggers.verifyWebhook({
  id: headers["webhook-id"],
  payload: rawBody,                      // RAW string body, not parsed
  signature: headers["webhook-signature"],
  timestamp: headers["webhook-timestamp"],
  secret: env.COMPOSIO_WEBHOOK_SECRET,
});
// result.payload (parsed), result.version, result.rawPayload
```

**Manual HMAC fallback (Svix scheme — sign `id.timestamp.body`):**
```ts
import crypto from "node:crypto";

function verifyComposioWebhook(id: string, ts: string, rawBody: string, sigHeader: string) {
  // If secret is "whsec_<b64>", strip the prefix and base64-decode the key:
  const raw = env.COMPOSIO_WEBHOOK_SECRET.startsWith("whsec_")
    ? Buffer.from(env.COMPOSIO_WEBHOOK_SECRET.slice(6), "base64")
    : Buffer.from(env.COMPOSIO_WEBHOOK_SECRET);
  const signedContent = `${id}.${ts}.${rawBody}`;
  const expected = crypto.createHmac("sha256", raw).update(signedContent).digest("base64");
  // header is space-delimited list of "v1,<sig>" — accept if any matches
  const ok = sigHeader.split(" ").some((p) => {
    const sig = p.includes(",") ? p.split(",")[1] : p;
    return sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!ok) throw new Error("invalid composio webhook signature");
  return JSON.parse(rawBody);
}
```
> Next.js App Router: read the **raw** body (`await req.text()`) before `JSON.parse` — signature is over the exact bytes. Enforce the 5-minute timestamp tolerance.

**V3 payload shape:** `{ type: "composio.connected_account.<...>", data: {...}, metadata: { trigger_slug, ... } }` (older payloads carried `trigger_name`/`connection_id`/`payload`/`log_id`). Switch on `type`; read the `ca_…` id and `userId` from `data` to upsert `connector_accounts`.

Sources: <https://docs.composio.dev/docs/webhook-verification>; <https://docs.composio.dev/docs/using-triggers>; <https://docs.composio.dev/docs/connected-accounts>; Svix signature scheme.

---

## Q7 — Error model & revoked-connection detection

- **`tools.execute` does NOT throw on action failure.** It resolves to `{ successful: false, error: "<message>", data: ... }`. The SDK throws only for client-level problems (bad API key → auth error, network, malformed request). **So: always branch on `successful`, and wrap the call in try/catch for transport errors.**
  ```ts
  let res;
  try {
    res = await composio.tools.execute(slug, { userId, connectedAccountId, arguments });
  } catch (e) {
    // transport/client error (network, 401 bad key, 4xx malformed) — retryable vs fatal
    throw new ConnectorTransportError(e);
  }
  if (!res.successful) {
    // action-level failure (revoked conn, Slack "not_in_channel", Google 4xx, etc.)
    throw new ConnectorActionFailed(res.error, res.data);
  }
  ```
- **Revoked/expired connection at execute time:** executing against a non-ACTIVE `ca_…` fails (the docs state "INACTIVE accounts cannot execute tools; execution will fail until status changes"). It surfaces as `successful:false` (or a thrown 4xx referencing the connection) — the message references the connection/auth, not a Slack/Google API error. **To detect reliably, don't parse the error string;** on any execute failure for a connector action, call `composio.connectedAccounts.get(connectedAccountId)` and check `status`. If `status !== "ACTIVE"` (verified live values: `EXPIRED`, `REVOKED`, `INACTIVE`, `FAILED`) → mark the `connector_account` as needing reconnect, emit `connector.auth_error`/`connector.revoked`, and trigger the reconnect email. The `status_reason` field gives a human explanation (live examples: `"Revoked via admin tool"`, `"Connection initiation did not complete within 10 minutes"`).
- This is the same signal the **poll sweep** uses, so share one `assertAccountActive(ca)` helper between the execute path and the sweep.

Sources: <https://docs.composio.dev/docs/migration-guide/new-sdk>; <https://docs.composio.dev/docs/connected-accounts>; live `status`/`status_reason` probe.

---

## Q8 — Rate limits / idempotency

- **No Composio-side idempotency key on `execute`.** Calling `tools.execute` twice = two upstream calls. **Keeps' execute-once layer is the only guarantee:** the `connector_actions` row + `SELECT … FOR UPDATE` (load → if completed/executing return cached → else mark executing, call Composio, persist result, COMMIT). Same approval event delivered twice ⇒ exactly one `tools.execute`. Do not weaken this assuming Composio dedupes — it does not.
- **Rate limits:** Composio applies plan-level API rate limits; on `429`/transport errors the call **throws** (caught above) — make the SEND-ONLY Inngest step retryable, but only when the `connector_actions` row is still `executing`/unstarted (the FOR-UPDATE guard prevents a retry from double-sending an already-completed action). Upstream Slack/Google rate limits surface as `successful:false` with the provider's error in `res.data`/`res.error`.
- Pin **toolkit versions** for reproducibility if drift becomes an issue (the SDK supports `toolkitVersions` at construction; live toolkit schemas carry a `version` like `20260612_00`). Not required for v1 of Phase 4 — note for later.

Sources: <https://docs.composio.dev/docs/tools-direct/executing-tools>; <https://docs.composio.dev/docs/migration-guide/toolkit-versioning>.

---

## Live account state (read-only probe, 2026-06-13)

> From `https://backend.composio.dev/api/v3` using the `backend`/`prd` Composio API key (Doppler). No secret values are reproduced here.

**Auth configs (Composio-managed OAuth, ENABLED):**

| Toolkit | Auth config id | Connections |
|---|---|---|
| `slack` | `ac_GqhvFeSbsPsv` (name `slack-c852uk`) | 156 |
| `googlecalendar` | `ac_j7dp3poETzpU` (name `googlecalendar-d9jzyp`) | 17 |

(Account also has gmail, googledrive, notion, linkedin, linear, googlesheets, zeplin, etc. configured — not relevant to Phase 4.)

**Entity (userId) pattern in use:** a mix of **Keeps-style UUIDs** (`d7f505a5-917d-4f5e-9fd8-d2b6c4fcf170`, `aa9dd140-def8-4e8e-9955-4acc04e11fea`, `0b86dc25-38a2-48e4-956b-e2cbf5555ef4`, `139e7cdc-7060-49c8-a04f-2afffddbd708`) and some legacy email/string userIds (`aravb09@gmail.com`, `basil-user`, `freehand-local-user`). **Confirms the Keeps-UUID-as-userId strategy works.**

**Connected-account statuses relevant to Phase 4 (probe sample, limit 100):**
- **Google Calendar:** 1 ACTIVE under `aravb09@gmail.com` (`ca_fsAQmruTO8i3`), 1 ACTIVE under `freehand-local-user` (`ca_bIT9etLWYjAl`), 1 REVOKED under UUID `aa9dd140-…` (`ca_x5zf0VBqsYYW`, `status_reason: "Revoked via admin tool"`), and many EXPIRED.
- **Slack:** **no ACTIVE Slack connection found in the probe sample** — all sampled Slack accounts (≈30+, mostly under UUID `0b86dc25-…`) are `EXPIRED` (`status_reason: "Connection initiation did not complete within 10 minutes"`). → **Action item for the live wave: Arav must (re)authorize Slack** for his Keeps user UUID against `ac_GqhvFeSbsPsv` before B1/D-wave Slack smoke tests. Google Calendar already has a working ACTIVE example to model against.

**Verification value:** the live REVOKED and EXPIRED rows give downstream agents real fixtures for the AR reconnect path, and confirm the `{ status, status_reason, is_disabled }` detection fields exist.

---

## Quick reference — slugs the connector transports use

```
Slack:
  SLACK_FIND_USER_BY_EMAIL_ADDRESS   args: { email }                      → data.user.id
  SLACK_OPEN_DM                      args: { user_ids|users }   (optional) → DM channel D…
  SLACK_SEND_MESSAGE                 args: { channel, markdown_text }      → data: { ok, ts, channel }
  SLACK_FIND_USERS / SLACK_LIST_ALL_USERS  (name-based / ambiguity fallback)

Google Calendar:
  GOOGLECALENDAR_CREATE_EVENT
    args: { calendar_id:"primary", summary, start_datetime (naive),
            timezone (IANA), event_duration_hour, event_duration_minutes,
            attendees?[], send_updates? }
    → data.response_data.{ id, htmlLink, ... }

Auth config ids: Slack ac_GqhvFeSbsPsv · Google Calendar ac_j7dp3poETzpU
```

---

## Open items to confirm at integration time (don't hard-code blind)
1. **Exact `data` nesting for Slack responses** — run one live `SLACK_FIND_USER_BY_EMAIL_ADDRESS` + `SLACK_SEND_MESSAGE` and confirm whether the Slack payload is at `data.*` or `data.response_data.*` (Calendar uses `data.response_data`). One probe settles it.
2. **Calendar reminder overrides** — CREATE_EVENT has no `reminders` arg; decide default-reminders vs. a follow-up PATCH for "popup N min before."
3. **Webhook event-type enum** — subscribe to `composio.connected_account.*` and log the first few real `type` strings to lock the switch; build the poll sweep regardless (revocation push is best-effort).
4. **Slack ACTIVE connection** — none in the live probe; Arav re-auths Slack for his Keeps UUID before Slack smoke tests.
