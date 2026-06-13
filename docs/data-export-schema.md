# Keeps Data Export Schema

This document describes the structure of a Keeps JSON data export produced by
`buildUserExport` in `src/workflows/functions/generate-data-export.ts`.

A data export is triggered by a POST to `/api/data/export`. The assembler runs
asynchronously in the `generate-data-export` Inngest function and delivers the
result via email (the `send-export-email` function).

---

## Top-level shape

```json
{
  "exportedAt": "2026-06-13T12:00:00.000Z",
  "userId": "<uuid>",
  "user": { ... },
  "email_threads": [ ... ],
  "inbound_emails": [ ... ],
  "email_messages": [ ... ],
  "source_evidence": [ ... ],
  "loops": [ ... ],
  "loop_events": [ ... ],
  "nudges": [ ... ],
  "approval_requests": [ ... ],
  "drafts": [ ... ],
  "connector_actions": [ ... ],
  "generated_reports": [ ... ]
}
```

---

## Top-level keys

### `exportedAt`
ISO 8601 timestamp when the export was assembled.

### `userId`
The internal Keeps user UUID the export belongs to.

### `user`
Non-sensitive columns from the `users` table for the requesting user.

Included: `id`, `email`, `displayName`, `companyName`, `workingStyle`, `status`,
`timezone`, `digestEnabled`, `digestSendHour`, `rawEmailRetentionDays`,
`outboundEmailState`, `createdAt`, `updatedAt`, `verifiedAt`.

**Excluded**: `isAdmin` (internal admin flag, not meaningful to end-users).

### `email_threads`
All rows from `email_threads` for this user. Contains thread metadata
(`id`, `threadKey`, `subject`, timestamps).

### `inbound_emails`
All rows from `inbound_emails` for this user.

**Retention note**: When an email has been scrubbed by the retention cron
(`scrubbed_at` is set), the following fields are exported as `null` and
`_scrubbed: true` is added to the row:
- `rawPayload`
- `textBody`
- `htmlBody`
- `strippedTextReply`
- `normalizedPayload`
- `attachmentMetadata`
- `headers`

The row itself (id, timestamps, sender metadata) is always present.

### `email_messages`
All rows from `email_messages` for this user.

**Retention note**: When a message has been scrubbed (`scrubbed_at` is set),
`textBody`, `htmlBody`, and `strippedTextReply` are exported as `null` and
`_scrubbed: true` is added to the row.

### `source_evidence`
All rows from `source_evidence` for this user. Contains extracted quotes,
offsets, and source metadata. Quote text is always preserved (the retention
cron intentionally leaves `source_evidence.quote` intact for loop integrity).

### `loops`
All rows from `loops` for this user. Contains status, kind, summary,
confidence, participants, due dates, and nudge bookkeeping fields.

### `loop_events`
All rows from `loop_events` for this user. Each row records a state transition
(created, confirmed, dismissed, snoozed, done, nudged, etc.) with optional
`commandText` and `metadata`.

### `nudges`
All rows from `nudges` for this user. Contains nudge type, status, channel,
subject, body, schedule, and metadata.

### `approval_requests`
All rows from `approval_requests` for this user. Contains action kind, status,
expiry, decision metadata, and timestamps.

**Note**: `tokenHash` is included (it is a bcrypt hash of the one-time approval
token, not the token itself, and is not reversible into a usable credential).

### `drafts`
All rows from `drafts` for this user. Contains `actionKind`, `payload`
(action-specific parameters), and `requiresLogin`.

### `connector_actions`
All rows from `connector_actions` for this user.

**Connector token exclusion**: The following fields are stripped recursively from
`payload`, `result`, and `error` JSON columns to prevent credential leakage:

| Stripped key | Reason |
|---|---|
| `token` | Generic OAuth/API token |
| `access_token` | OAuth access token |
| `refresh_token` | OAuth refresh token |
| `secret` | Generic secret |
| `api_key` / `apiKey` | API key |
| `password` | Password |
| `credential` / `credentials` | Credential objects |
| `auth_token` / `authToken` | Auth token |
| `composioConnectedAccountId` | Composio OAuth session identifier |
| `composioEntityId` | Composio entity identifier |

The `connectorAccountId` FK (a UUID referencing the connector_accounts row) is
kept as a structural reference — it is not itself an OAuth credential.

**Not included**: `connector_accounts` rows are **not exported** because they
contain `composioConnectedAccountId` and `composioEntityId` — the OAuth session
identifiers that allow programmatic access to the connected provider accounts.
These fields identify the live Composio OAuth session and must never leave the
Keeps backend.

### `generated_reports`
All rows from `generated_reports` for this user.

**Token exclusion**: `tokenHash` is stripped from every report row — the hash
is a one-way value used to verify report view tokens and is not useful in an
export.

---

## Delivery

### With Vercel Blob (`BLOB_READ_WRITE_TOKEN` set)
The export JSON is uploaded to a **private** Vercel Blob with an unguessable
pathname (`exports/<userId>/<random-uuid>.json`). The user receives an email
with a signed download URL valid for **24 hours**.

### Without Vercel Blob (local dev / fallback)
The export JSON is embedded inline in the `data.export_completed` Inngest event
and delivered via email body. The HTML email truncates the JSON preview at 8,000
characters; the full export is in the plain-text body.

---

## Retention note

Keeps may scrub raw email bodies after the user's configured retention period
(see `rawEmailRetentionDays` on the user row). When bodies have been scrubbed,
the export correctly reflects the scrubbed state — body fields are `null` and
`_scrubbed: true` is present. Loop summaries, source quotes, and structural
metadata are always preserved regardless of scrubbing.
