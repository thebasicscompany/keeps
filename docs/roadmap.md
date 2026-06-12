# Keeps Roadmap

Drafted: 2026-06-12

Status: active implementation

> **Note (2026-06-12):** Detailed engineering plans for remaining phases live in `docs/phases/` (see `docs/phases/README.md` for binding architecture rulings AR-1..AR-8). Where a phase plan and this roadmap disagree on implementation detail, the phase plan wins. Known supersessions: nudge scheduling uses a cron sweep, not `step.sleepUntil`-per-loop (AR-5); `due_soon`/`overdue` become derived, not stored, statuses (AR-6); auth is Clerk; a Phase 2.5 (pipeline hardening) and Phase 2.6 (auth + go-live) precede Phase 3.

## Current Status

Last updated: 2026-06-12

### Completed And Verified

- [x] Phase 0 technical skeleton is implemented.
- [x] Next.js app shell is running locally.
- [x] Dev email auth stub can create and verify a user.
- [x] Drizzle/Postgres base schema and migrations exist.
- [x] Inngest endpoint is registered at `/api/inngest`.
- [x] Vercel AI SDK model wrapper exists with deterministic fallback.
- [x] Policy guard blocks external side effects without approval.
- [x] Phase 1 inbound capture is implemented.
- [x] Postmark-shaped inbound payloads normalize into Keeps email records.
- [x] Known senders persist into `inbound_emails`, `email_threads`, and `email_messages`.
- [x] Unknown senders are held in `pending_inbound_emails`.
- [x] Duplicate provider message IDs are deduped.
- [x] Dev signup claims held emails.
- [x] Phase 2 loop extraction and private-reply state is implemented.
- [x] Email body cleanup preserves forwarded content and strips common quoted/signature noise.
- [x] Deterministic extraction handles direct, forwarded, BCC-like, and low-confidence examples.
- [x] Extracted loops persist with required `source_evidence`.
- [x] High-confidence loops auto-track as `open`; low-confidence loops remain `candidate`.
- [x] Pending private replies are stored as `nudges`.
- [x] Reply command parser/service handles `correct`, `confirm`, `dismiss 1`, `remind me Thursday`, and `mark 2 done`.
- [x] Local Inngest dev server invokes `process-email` from `email.received`.
- [x] `process-email` emits `email.classified`, `loops.extracted`, and `loop.created`.
- [x] Local route-to-Inngest smoke test writes loop/evidence/nudge rows from `/api/email/inbound`.
- [x] `pnpm typecheck` passes.
- [x] `pnpm test` passes.
- [x] `pnpm build` passes.

### Local Acceptance Stack

- [x] Docker Postgres container `keeps-postgres` is running on `localhost:55433`.
- [x] App dev server is running on `http://localhost:3000`.
- [x] Inngest dev server is running on `http://localhost:8288`.
- [x] `.env.local` has local non-secret defaults, including `INNGEST_DEV=1`.
- [x] Verified local sender: `arav@example.com`.
- [x] Local DB smoke evidence includes `inbound_emails`, `loops`, `source_evidence`, `loop_events`, and pending `nudges`.

### Not Yet Done

- [ ] Real Postmark inbound email to `agent@keeps.ai`.
- [ ] Postmark webhook configured against a public `/api/email/inbound` URL.
- [ ] DNS/MX setup for `keeps.ai`, unless using Postmark's generated inbound address first.
- [ ] Cloud Inngest keys configured for deployed workflows.
- [ ] Live OpenAI extraction with `generateObject`; deterministic fallback is verified.
- [ ] Outbound private email delivery through Postmark.
- [ ] Reply-command ingestion from actual email replies.
- [ ] Phase 3 nudges, digests, and approval waits.
- [ ] Slack and Google Calendar connectors.

### External Setup Needed Next

- [ ] `POSTMARK_SERVER_TOKEN`
- [ ] Public app URL for Postmark and Inngest callbacks
- [ ] Postmark inbound stream/domain or generated inbound address
- [ ] `KEEPS_INBOUND_WEBHOOK_SECRET` value configured as Postmark custom header
- [ ] `INNGEST_EVENT_KEY`
- [ ] `INNGEST_SIGNING_KEY`
- [ ] `OPENAI_API_KEY` when testing live model extraction

## Working Thesis

Keeps is an email-first work memory for open loops. The first behavior should be extremely easy:

> BCC, forward, or email `agent@keeps.ai` when something should not slip.

Keeps privately extracts loops, nudges the user, and can draft approved actions into connected tools such as Slack and Calendar. It should feel quiet, useful, and work-oriented. The product should not feel like a chatbot that wants attention, and it should not start as a dashboard-first SaaS.

The durable product is a permissioned execution graph. The wedge is private email capture. The end state of the graph is machine-readable as well as human-readable: other AI assistants query Keeps as their organizational memory layer via MCP (Phase 9), which hedges the product against assistant-interface commoditization — if assistants win, they need a context provider, and Keeps is it.

## Product Principles

1. Email is the main UI for V0.
2. Keeps is invisible to everyone except the user unless the user explicitly shares or approves an external action.
3. External side effects require explicit approval in V0.
4. The agent proposes. Keeps policy and user approval decide.
5. Every loop needs source evidence.
6. A lightweight settings page is acceptable. A dashboard habit is not required.
7. Generated private links are the first visual UI for inspection, approval, and insights.
8. Start individual-first. Team graph emerges only through explicit consent.
9. Raw email retention should be conservative and user-controllable.
10. Self-hosting/private-cloud is part of the pitch, not part of the first implementation unless a pilot demands it.

## Core Vocabulary

### Keeps

The product and agent identity.

### Loop

A tracked open item that might otherwise slip. A loop may be a commitment, reminder, ask, waiting-on state, customer promise, follow-up, discount, return, bug, meeting action, or personal work obligation.

Loop is better than task because many items are not project-management tasks. It is better than reminder because some items require evidence, ownership, and status tracking.

### Nudge

A private reminder or surfaced prompt to the user.

### Draft

A proposed outbound action that requires user approval before execution.

### Source

The email, thread, message, calendar event, or connector record that justifies a loop or status update.

### Generated View

An expiring private page created in response to a command such as "what are my insights?" or "show stale loops".

## Architecture Decision Record

### Email Provider

Use Postmark inbound and outbound email for V0.

Rationale:

- Postmark inbound posts parsed email JSON to our webhook.
- It supports inbound routing, message IDs, bodies, headers, stripped replies, attachments, and spam metadata.
- It is simpler than connecting a user's full Gmail or Outlook mailbox.
- BCC and forwarding are enough to test the core habit.

Initial addresses:

- Public capture address: `agent@keeps.ai`
- Optional internal inbound domain: `in.keeps.ai`
- No personal aliases in V0.

Personal aliases such as `arav@keeps.ai` or `keep+arav@keeps.ai` can come later if routing, deliverability, branding, or ownership feel demand it.

### Auth

V0 needs email verification and session auth. The specific provider is still open.

Default recommendation:

- Use Clerk if we want fastest polished auth and organizations later.
- Use Better Auth or Auth.js if we want a lighter self-owned auth surface.
- Use WorkOS if the first pilots demand enterprise SSO earlier than expected.

For now, the roadmap assumes verified email identity, not a specific auth vendor.

### App Surface

Use a Next.js app with three surfaces:

1. Onboarding and signup.
2. Minimal settings: tone, connectors, privacy, delete/export, billing later.
3. Generated private views: reports, approvals, source inspection, loop actions.

The app should not teach users to check a persistent dashboard every morning. The product should push useful email nudges and create private views only when needed.

### Database

Use Postgres.

Likely stack:

- Prisma or Drizzle for schema/migrations.
- AWS RDS Postgres for early hosted deployment (decided 2026-06-12 — existing SST-provisioned instance; replaces the earlier Neon/Supabase/Railway shortlist).
- `pgvector` later only if semantic retrieval becomes necessary.

### Background Jobs

Use Inngest for V0 background workflows.

Keeps needs durable event workflows more than raw long-running compute:

- Inbound email processing.
- Loop extraction and follow-up retries.
- Reminder scheduling.
- Daily digest scheduling.
- Approval waits.
- Connector retries.
- Report generation.

Inngest fits because `step.run` gives retriable steps, `step.sleepUntil` maps to reminders, and `step.waitForEvent` maps to approval flows. Keep this behind a narrow adapter so the workflow backend can move later.

Alternatives:

- Trigger.dev is strong for heavier long-running AI tasks and broader task observability.
- Temporal is the long-term enterprise-grade workflow engine.
- Upstash QStash/Workflow is lightweight and serverless-friendly.

Decision:

- Use Inngest now.
- Do not build a custom queue/scheduler/approval harness.
- Do not couple domain logic directly to Inngest APIs outside workflow files.

### Agent Placement

The agent sits in the Keeps backend worker. It does not live inside Postmark, Nango, Slack, or Calendar.

```txt
Email
  -> Postmark inbound webhook
  -> Keeps API stores normalized email
  -> Inngest event
  -> Keeps worker/agent
  -> Keeps-owned tools
  -> policy/approval gate
  -> Postgres, Postmark, Nango, Slack, Calendar
```

The agent has access to tools such as:

- `extract_loops`
- `create_loop`
- `update_loop_status`
- `schedule_nudge`
- `draft_email_reply`
- `draft_slack_message`
- `create_calendar_reminder`
- `generate_private_report`

The tool implementations enforce:

- user ownership
- connector authorization
- destructive action checks
- idempotency
- audit logs
- approval requirements

### Model Use

Use structured outputs for extraction and classification.

Do not let freeform model text directly mutate state. The model should return typed candidates. Application logic decides how to persist them.

Use Vercel AI SDK Core as the TypeScript model-call layer for V0. It should sit inside deterministic Inngest workflows rather than replacing them. The first live model path should use `generateObject` with the loop extraction schema; tests should keep a deterministic fallback so local verification does not require model credentials.

Initial model tasks:

- classify inbound email intent
- extract loops
- infer due dates and owners
- identify uncertainty
- draft private reply
- draft Slack/calendar action payloads
- summarize generated reports

### Connectors

Use Nango for product-owned connectors.

Rationale:

- Keeps wants a small number of reliable product actions.
- Nango lets us define our own action functions with our own policy and logs.
- It is a better fit than giving the model a broad marketplace of tools.

First connectors:

- Slack
- Google Calendar

Composio remains useful for throwaway demo breadth, but it should not be the default product integration layer unless we intentionally choose agent-native breadth over controlled product actions.

### Safety Boundary

V0 allowed without extra approval:

- storing a loop
- dismissing a loop
- snoozing a loop
- sending private email to the user
- creating a private generated view
- sending a private nudge to the user

V0 requires explicit approval:

- sending Slack messages
- creating calendar events or reminders if user has not explicitly asked in the current command
- sending email to anyone except the user
- sharing a loop with another user
- revealing source evidence to another user

V0 disallowed:

- replying to external email threads
- sending emails to third parties
- silently ingesting the user's full mailbox
- creating team-visible facts from private emails
- training on customer email content

## Event Taxonomy

Initial Inngest events:

- `email.received`
- `email.sender_unknown`
- `email.sender_verified`
- `email.classified`
- `loops.extracted`
- `loop.created`
- `loop.updated`
- `loop.nudge_scheduled`
- `loop.nudge_due`
- `digest.daily_requested`
- `digest.daily_due`
- `report.requested`
- `report.generated`
- `approval.requested`
- `approval.received`
- `connector.connected`
- `connector.action_requested`
- `connector.action_completed`
- `connector.action_failed`

## Data Model Overview

Core V0 tables:

- `users`
- `user_identities`
- `pending_inbound_emails`
- `inbound_emails`
- `email_threads`
- `email_messages`
- `source_evidence`
- `loops`
- `loop_events`
- `nudges`
- `drafts`
- `approval_requests`
- `connector_accounts`
- `connector_actions`
- `generated_reports`
- `audit_log`

Core loop fields:

- `id`
- `created_by_user_id`
- `summary`
- `status`
- `owner_text`
- `requester_text`
- `due_at`
- `next_check_at`
- `confidence`
- `visibility`
- `source_evidence_id`
- `source_quote`
- `last_nudged_at`
- `resolved_at`
- `dismissed_at`

Core status values:

- `candidate`
- `open`
- `waiting_on_me`
- `waiting_on_other`
- `due_soon`
- `overdue`
- `blocked`
- `snoozed`
- `done`
- `dismissed`

## Phase Format

Each phase below is intended to be self-contained. A phase includes:

- purpose
- user-facing outcome
- prerequisite assumptions
- build scope
- design questions
- technical deliverables
- data/events
- agent behavior
- UX surface
- acceptance tests
- non-goals
- exit criteria

## Phase 0: Product Contract And Technical Skeleton

### Purpose

Define exactly what Keeps is allowed to do, then stand up the empty product shell so all later phases have a stable place to land.

### User-Facing Outcome

A user can sign up, verify their email, choose a tone, and see instructions for using `agent@keeps.ai`. The product does not yet need to process real email.

### Prerequisite Assumptions

- The product starts individual-first.
- The first public action is BCC/forward/email to one shared address.
- Slack and Calendar are planned but not required in this phase.
- The UI is sparse and utilitarian.

### Build Scope

Product:

- Write the product contract.
- Define loop vocabulary.
- Define "never without approval" rules.
- Define tone options.

Engineering:

- Scaffold Next.js app.
- Add Postgres.
- Add migrations.
- Add auth provider.
- Add basic app layout.
- Add settings/onboarding route.
- Add Inngest client and local dev endpoint.
- Add Vercel AI SDK model wrapper.
- Add environment validation.

AI:

- Create first loop extraction fixture.
- Create first structured schema for loop candidates.
- Add a local script or test that turns a fixture email into structured candidates.

### Suggested File/Module Shape

- `app/(marketing)/page.tsx`
- `app/onboarding/page.tsx`
- `app/settings/page.tsx`
- `app/api/inngest/route.ts`
- `app/api/email/inbound/route.ts`
- `src/db/schema.ts`
- `src/email/normalize.ts`
- `src/agent/extract-loops.ts`
- `src/agent/schemas.ts`
- `src/workflows/client.ts`
- `src/workflows/functions/process-email.ts`
- `docs/product-contract.md`

### Data And Events

Tables:

- `users`
- `user_identities`
- `audit_log`

Events:

- none required for production behavior
- local fake event may be `email.received`

### Agent Behavior

No live agent behavior yet. Only fixture-based extraction.

The important design is the boundary:

- model output is typed
- persistence is application-owned
- side effects are policy-gated

### UX Surface

Onboarding should contain:

- email verification
- tone selection: `Brief`, `Warm`, `Direct`, `Chief of Staff`
- short usage instructions
- privacy promise

It should not contain a long feature tour.

### Open Design Questions

- Is the product voice called "tone" or "working style"?
- Should "Chief of Staff" be a tone option or is that too loaded?
- Should the first page say "BCC Keeps" or "Send to Keeps"?
- Should signup require a work email, or allow any email for personal testing?
- Should we collect company name in V0?

### Recommended Defaults

- Say "Send to Keeps" as the broad instruction.
- Allow any verified email in alpha.
- Ask for company name only as optional.
- Use "working style" instead of "personality".

### Acceptance Tests

- App runs locally.
- User can verify email and reach onboarding.
- User can select and persist working style.
- Fixture extraction test returns valid structured output.
- No code path can perform an external action without an approval object.

### Non-Goals

- Real inbound email.
- Real reminders.
- Slack/Calendar OAuth.
- Generated insight views.
- Team/workspace model.

### Exit Criteria

Phase 0 is done when the repo can support real inbound email work without redoing the skeleton.

## Phase 1: Email Identity And Inbound Capture

### Purpose

Make `agent@keeps.ai` real. This phase validates the core interaction before the product gets smart.

### User-Facing Outcome

A user can BCC, forward, or directly email Keeps. If they are not signed up, Keeps asks them to sign up. If they are signed up, Keeps privately confirms receipt.

### Prerequisite Assumptions

- Postmark is the inbound and outbound provider.
- Sender email is the identity key.
- Keeps is invisible to other recipients unless the user explicitly puts Keeps in To/CC.
- BCC and forward are both valid capture modes.

### Build Scope

Email:

- Configure inbound domain and mailbox routing.
- Implement Postmark inbound webhook.
- Verify inbound requests.
- Store raw provider payload.
- Normalize sender, recipients, subject, text, HTML, stripped reply, attachments metadata, and message IDs.
- Dedupe inbound messages.
- Identify unknown senders.
- Reply to unknown senders with signup link.
- Hold unknown sender emails for later processing.
- Claim held emails after signup.

Product:

- Add onboarding copy explaining BCC, forward, and direct email.
- Add test email flow in onboarding.
- Add "send a test email" CTA or instructions.

### Data And Events

Tables:

- `pending_inbound_emails`
- `inbound_emails`
- `email_threads`
- `email_messages`
- `audit_log`

Events:

- `email.received`
- `email.sender_unknown`
- `email.sender_verified`

### Agent Behavior

No loop extraction required yet.

The system can send deterministic acknowledgements:

- "I got this. I am not tracking loops yet in this test environment."
- "I can help with this after you verify this email."

### UX Surface

Email reply for unknown sender:

```txt
I can help track this, but I need to verify this email first.

Activate Keeps for {sender_email}: {signup_link}
```

Email reply for known sender:

```txt
Got it. I saved this thread privately.

Next, I will look for loops and follow-up points.
```

### Open Design Questions

- Should unknown emails be processed before signup or only after verification?
- How long should pending unknown-sender emails be retained?
- Should BCC captures and forwarded captures get different acknowledgement copy?
- Do we need plus-address routing in V0?
- Should we support attachments immediately or store attachment metadata only?

### Recommended Defaults

- Hold unknown emails for 7 days.
- Do not run model extraction before verification.
- Store attachment metadata, not attachment content, unless extraction requires it.
- Use one public address, `agent@keeps.ai`.

### Acceptance Tests

- BCC from Gmail reaches the webhook and creates an inbound email.
- Forward from Gmail reaches the webhook and preserves enough quoted context to inspect.
- Direct email reaches the webhook.
- Duplicate webhook delivery does not duplicate rows.
- Unknown sender gets a signup reply.
- After signup, held emails are associated with the verified user.

### Non-Goals

- Full mailbox ingestion.
- Gmail/Outlook OAuth.
- Loop extraction.
- Slack/Calendar actions.
- Thread reply monitoring beyond what the user sends to Keeps.

### Exit Criteria

Phase 1 is done when real emails reliably land in Postgres and users understand how to send work to Keeps.

## Phase 2: Loop Extraction And Private Replies

### Purpose

Turn captured email into useful loop candidates with source evidence.

### User-Facing Outcome

After a user sends Keeps an email, Keeps privately replies with the loops it found and asks for confirmation, correction, or dismissal.

### Prerequisite Assumptions

- Inbound email capture works.
- User identity is verified.
- The source email is private by default.
- The model must produce structured output.

### Build Scope

Email intelligence:

- Normalize email bodies for extraction.
- Strip signatures and quoted reply noise as best effort.
- Preserve source spans or source quotes.
- Detect participants and possible owners.
- Infer explicit commitments separately from inferred next steps.
- Infer due dates and uncertainty.

Agent:

- Intent classifier: capture, command, approval, question, correction.
- Loop extractor with structured output.
- Confidence policy.
- Clarifying-question generation for low confidence.
- Private reply generator.

State:

- Create candidate loops.
- Support confirmation.
- Support dismissal.
- Support snooze.
- Support mark done.
- Persist source evidence.

### Data And Events

Tables:

- `source_evidence`
- `loops`
- `loop_events`
- `nudges`

Events:

- `email.classified`
- `loops.extracted`
- `loop.created`
- `loop.updated`

### Agent Behavior

The agent should output:

- intent
- summary
- candidate loops
- confidence
- owner text
- requester text
- due date
- next check date
- source quote/span
- ambiguity flags
- suggested reply copy

The app should decide:

- whether to create a candidate loop
- whether to ask a clarification question
- whether to send a normal confirmation reply

### UX Surface

Example private reply:

```txt
I found 2 loops.

1. You owe Maya the updated deck by Friday.
2. Acme is waiting on the discount decision before the renewal call.

Reply with:
- correct
- dismiss 1
- remind me Thursday
- mark 2 done
```

For low confidence:

```txt
I may be reading this wrong. Should I track this?

"Can you send the updated plan before the renewal call?"

Reply yes, no, or edit the loop.
```

### Open Design Questions

- Should loops start as `candidate` until user confirms, or auto-create high-confidence loops?
- What confidence threshold is high enough for auto-tracking?
- Should "waiting on someone else" and "I owe someone" be separate loop types?
- How much source quote should we include in email replies?
- Should Keeps use "I found loops" or more human language like "Here is what I will keep an eye on"?

### Recommended Defaults

- Auto-track high-confidence loops but clearly tell the user.
- Keep low-confidence loops as questions.
- Use direct language: "I found 2 loops."
- Include short source quotes only when helpful.
- Store source evidence for every loop.

### Acceptance Tests

- Real forwarded email produces useful loop candidates.
- Real BCC email produces useful loop candidates from the visible message body.
- User can dismiss by reply.
- User can snooze by reply.
- User can mark done by reply.
- Low-confidence examples ask a clarification question.
- Every persisted loop points to source evidence.

### Non-Goals

- Automatic external messages.
- Slack/Calendar actions.
- Team sharing.
- Perfect completion detection.

### Exit Criteria

Phase 2 is done when the first private reply feels useful enough that a user would send Keeps another thread.

## Phase 3: Nudges, Digests, And Approval Workflow

### Purpose

Make Keeps useful over time instead of only at capture time.

### User-Facing Outcome

Keeps reminds the user when loops need attention, sends a useful digest, and can pause on approval before any external action.

### Prerequisite Assumptions

- Loops exist with status and source evidence.
- Users can update loops by email.
- Inngest is available.

### Build Scope

Nudges:

- Schedule reminders with `step.sleepUntil`.
- Recompute due soon and overdue states.
- Avoid repeated annoying nudges.
- Respect snooze.
- Track false-positive dismissal.

Digests:

- Daily digest job.
- User-level digest preferences.
- Digest categories: waiting on me, waiting on others, due soon, stale, recently done.
- Direct email command: "what are my open loops?"
- Direct email command: "what are my insights?"

Approvals:

- Approval request model.
- Approval email template.
- Reply parser for approve/reject/edit.
- Private link approval UI.
- Inngest approval wait via event.

### Data And Events

Tables:

- `nudges`
- `approval_requests`
- `drafts`
- `generated_reports`

Events:

- `loop.nudge_scheduled`
- `loop.nudge_due`
- `digest.daily_due`
- `digest.daily_requested`
- `approval.requested`
- `approval.received`
- `report.requested`

### Agent Behavior

The agent can:

- summarize the most important loops
- draft a nudge
- propose a follow-up
- prioritize risks

The agent cannot:

- send to third parties
- create external connector actions without approval
- infer team visibility

### UX Surface

Digest:

```txt
Today in Keeps

Needs your attention:
1. Acme discount decision is due today.
2. You said you would send Maya the deck by Friday.

Waiting on others:
1. Raj has not replied on the migration plan.

Reply "snooze 1 until Monday", "done 2", or "insights".
```

Approval:

```txt
Ready to send this?

To: Maya in Slack
Message: I will send the updated deck by Friday.

Approve: {approve_link}
Edit: {edit_link}
Cancel: {cancel_link}
```

### Open Design Questions

- Should daily digest be default-on?
- What time should the digest send?
- Should nudges be email-only until Slack is connected?
- Should the digest include personal/non-work loops?
- How aggressive should stale-loop nudging be?
- Should approval links require logged-in session or signed token only?

### Recommended Defaults

- Digest default-on at 8 AM user local time.
- Nudge by email first.
- Approval links use signed expiring token and require login for sensitive source evidence.
- Keep stale-loop nudges conservative.

### Acceptance Tests

- Reminder fires at expected time.
- Snoozed loop does not nudge early.
- Daily digest sends at user local time.
- User can approve/reject from email reply.
- User can approve/reject from private link.
- Approval timeout is handled gracefully.

### Non-Goals

- Slack/Calendar execution.
- Full insight dashboard.
- Team rollups.

### Exit Criteria

Phase 3 is done when Keeps provides ongoing value without the user opening a dashboard.

## Phase 4: Slack And Calendar Commands

### Purpose

Make connector commands demoable and useful while preserving the approval boundary.

### User-Facing Outcome

The user can email Keeps commands such as `@Slack tell Maya I will send the deck Friday` or `@Calendar remind me before the renewal call`, and Keeps drafts or executes approved actions.

### Prerequisite Assumptions

- Approval workflow works.
- Nango connector accounts can be stored per user.
- Slack and Google Calendar are connected through settings.

### Build Scope

Nango:

- Configure Slack OAuth.
- Configure Google Calendar OAuth.
- Store connection IDs.
- Add connector status in settings.
- Handle reconnect and revoked tokens.

Slack:

- Resolve Slack users by email or search fallback.
- Open DM.
- Draft message.
- Send approved message.
- Store Slack action result.

Calendar:

- Create reminder/event.
- Use user timezone.
- Link back to source loop.
- Optional: list upcoming meetings for context.

Commands:

- Parse `@Slack`.
- Parse `@Calendar`.
- Detect missing connector and send connect link.
- Detect ambiguity and ask clarification.

### Data And Events

Tables:

- `connector_accounts`
- `connector_actions`
- `drafts`
- `approval_requests`

Events:

- `connector.connected`
- `connector.action_requested`
- `approval.requested`
- `approval.received`
- `connector.action_completed`
- `connector.action_failed`

### Agent Behavior

The agent can plan connector action drafts:

- destination
- message/body
- reason
- source loop
- approval prompt

The agent cannot directly execute connector side effects. The tool layer checks:

- connector exists
- recipient resolved
- action is allowed
- approval exists where required
- idempotency key has not already executed

### UX Surface

Missing Slack:

```txt
I can draft that Slack, but Slack is not connected yet.

Connect Slack: {connect_link}
```

Ambiguous recipient:

```txt
I found two Mayas in Slack.

1. Maya Chen
2. Maya Patel

Reply "1" or "2".
```

Calendar:

```txt
I can put this on your calendar for Thursday at 9 AM.

Approve: {approve_link}
```

### Open Design Questions

- Should Calendar reminder creation require approval if the user directly requested it?
- Should Slack messages always require approval even if user says "send"?
- How should Keeps resolve people who are in email but not Slack?
- Should `@Calendar remind me` create an event or a task-like reminder?
- Should Keeps DM the user in Slack after Slack is connected, or stay email-first?

### Recommended Defaults

- Slack sends always require approval in V0.
- Calendar reminders can execute after direct explicit command, but still show confirmation.
- Keeps stays email-first. Slack is an action target, not the main UI.
- Recipient ambiguity must be resolved before approval.

### Acceptance Tests

- User connects Slack.
- User connects Google Calendar.
- `@Slack` command creates a draft.
- Approved Slack draft sends exactly once.
- `@Calendar` command creates a calendar event/reminder.
- Missing connector returns connect link.
- Ambiguous recipient asks for clarification.
- All connector actions have audit logs.

### Non-Goals

- Linear/Jira/GitHub connectors.
- Autonomous Slack posting.
- Reading entire Slack workspace history.
- Team-wide Slack bot behavior.

### Exit Criteria

Phase 4 is done when a demo can show email-to-Slack and email-to-Calendar in under two minutes with approvals.

## Phase 5: Generated Insight Views

### Purpose

Replace dashboard dependence with just-in-time visual views.

### User-Facing Outcome

The user can ask Keeps for insights by email and receive a concise reply plus a private link showing their current loops, risk, and source evidence.

### Prerequisite Assumptions

- Loops and nudges exist.
- Generated report links can be protected.
- Basic loop actions exist.

### Build Scope

Reports:

- Generate report records.
- Create expiring signed URLs.
- Render mobile-friendly report pages.
- Show grouped loops.
- Show source evidence when allowed.
- Support row actions: done, dismiss, snooze, draft nudge.

Email commands:

- "what are my insights?"
- "what am I waiting on?"
- "what is stale?"
- "weekly summary"
- "show Acme loops"

Insights:

- waiting on me
- waiting on others
- due soon
- overdue
- stale
- customer/vendor risk
- recently completed

### Data And Events

Tables:

- `generated_reports`
- `report_views` optional
- `loop_events`

Events:

- `report.requested`
- `report.generated`
- `report.viewed`
- `loop.updated`

### Agent Behavior

The agent can:

- summarize the report
- rank loops by likely importance
- explain why something is at risk
- draft suggested nudges

The deterministic layer should:

- fetch loops
- apply access checks
- build report scope
- persist report
- enforce token expiry

### UX Surface

Email response:

```txt
You have 8 open loops.

Most important:
1. Acme discount decision is due today.
2. Migration plan has been waiting on Raj for 6 days.
3. Deck follow-up is due Friday.

Private view: {report_link}
```

Generated view:

- compact header
- grouped loop sections
- source chips
- action buttons
- no marketing copy
- no nested cards

### Open Design Questions

- Should report links expire after 24 hours, 7 days, or user-configured duration?
- Should source evidence require re-auth even if the report link is signed?
- Should generated views be shareable later?
- Should the report feel like an inbox, table, or memo?
- Is "insights" the right command word, or should we teach "status"?

### Recommended Defaults

- Links expire in 7 days.
- Sensitive source evidence requires logged-in session.
- Report is a memo-like operational view, not a BI dashboard.
- Teach both "insights" and "status".

### Acceptance Tests

- User emails "what are my insights?"
- Keeps replies with summary and private link.
- Link opens a scoped report.
- Expired link stops working.
- User can act on loops from report.
- Report actions update the same state as email commands.

### Non-Goals

- Persistent dashboard navigation.
- Team reports.
- Advanced analytics.
- Admin reporting.

### Exit Criteria

Phase 5 is done when users can inspect and manage loops visually without needing a permanent dashboard habit.

## Phase 6: Reliability, Evaluation, And Trust Hardening

### Purpose

Make Keeps dependable enough for real pilot users and sensitive work emails.

### User-Facing Outcome

Keeps feels trustworthy. It makes fewer noisy mistakes, gives users control over retained data, and recovers gracefully from provider failures.

### Prerequisite Assumptions

- Core email, loop, nudge, approval, and first connector flows work.
- We have real or realistic pilot emails for evaluation.

### Build Scope

Evaluation:

- Build fixture suite from synthetic and anonymized real examples.
- Label expected loops.
- Track extraction precision.
- Track low-confidence handling.
- Track false-positive nudges.
- Track draft approval/edit rate.

Observability:

- Inngest run dashboards.
- Application error monitoring.
- Model call logs with redaction controls.
- Connector action logs.
- Email deliverability logs.

Trust:

- Delete email and derived loops.
- Export user data.
- Retention settings.
- Raw email retention policy.
- Audit log view in settings.
- Privacy copy for onboarding and pilot pitch.

Reliability:

- Idempotency for inbound email and connector actions.
- Retry policies.
- Dead-letter/manual review queue.
- Provider webhook replay handling.

### Data And Events

Tables:

- `eval_cases`
- `eval_runs`
- `audit_log`
- `data_deletion_requests`

Events:

- `eval.run_requested`
- `email.processing_failed`
- `connector.action_failed`
- `data.delete_requested`
- `data.delete_completed`

### Agent Behavior

The agent should be evaluated on:

- did it extract real commitments?
- did it avoid inferred noise?
- did it cite evidence?
- did it ask clarification when ambiguous?
- did it avoid overconfident language?

### UX Surface

Settings additions:

- privacy controls
- delete all data
- export data
- connector disconnect
- raw email retention preference

Internal ops:

- failed email processing queue
- eval dashboard or CLI report
- manual review flags

### Open Design Questions

- What raw email retention should be default: 30 days, 90 days, or until user deletes?
- Should we store redacted model prompts?
- Should pilot evals include human review in-product or offline?
- What is the minimum acceptable precision before adding more users?
- Should users see confidence, or is that too technical?

### Recommended Defaults

- Retain raw email for 30 days by default in alpha.
- Keep derived loop/source quotes until user deletes.
- Store model metadata and structured output; avoid storing full prompts unless needed for debugging.
- Show confidence only as plain language when it changes UX.

### Acceptance Tests

- Inbound duplicate processing remains idempotent.
- Connector retry does not double-send.
- Failed workflow is visible and recoverable.
- User can delete a source email and derived loops.
- Eval suite runs locally and in CI.
- Extraction quality can be measured across fixtures.

### Non-Goals

- Enterprise compliance certifications.
- Full self-hosted deployment.
- Formal admin console.
- Team visibility.

### Exit Criteria

Phase 6 is done when the product is reliable enough for real design-partner usage without constant manual babysitting.

## Phase 7: Individual To Team Transition

### Purpose

Let Keeps evolve from private work memory into a permissioned team execution graph without feeling surveillant.

### User-Facing Outcome

A user can say someone else is working with them, invite that person, and optionally share specific loops. Private emails remain private by default.

### Prerequisite Assumptions

- Individual product is useful.
- Users ask to coordinate with teammates.
- We have privacy controls from Phase 6.

### Build Scope

Workspace:

- Workspace model.
- Same-domain suggestion.
- Explicit teammate invite.
- Membership states.
- Role basics: member, admin.

Visibility:

- Private loop.
- Shared loop.
- Workspace loop.
- Source evidence access rules.
- Redacted shared loop summaries.

Team graph:

- People.
- Organizations/customers/vendors.
- Projects/tags.
- Waiting-on relationships.
- Aggregate rollups.

Team UX:

- "John is working with me on this."
- "Share this loop with John."
- "Show team loops for Acme."
- Weekly operator rollup.

### Data And Events

Tables:

- `workspaces`
- `workspace_memberships`
- `workspace_invites`
- `loop_visibility_grants`
- `people`
- `organizations`
- `projects`
- `loop_relationships`

Events:

- `workspace.invite_created`
- `workspace.member_joined`
- `loop.shared`
- `loop.visibility_changed`
- `team_report.requested`

### Agent Behavior

The agent can suggest:

- "This looks related to John. Want to share it?"
- "This appears to be about Acme."
- "Maya may be the owner."

The agent cannot:

- auto-share private loops
- reveal source emails to workspace members without permission
- infer manager visibility from domain membership alone

### UX Surface

Email:

```txt
I can track this privately.

It also looks like John is involved. Do you want to share this loop with John?

Reply:
- share with John
- keep private
```

Generated team report:

- aggregate risks
- shared loops only
- source evidence only where permitted
- clear private/shared labeling

### Open Design Questions

- Does same-domain signup create a suggested workspace or require explicit company creation?
- Should one user be able to create `company.com` workspace before others join?
- What is the default visibility when multiple signed-up users appear in the same email thread?
- Should shared loop summaries hide source quotes by default?
- Is "workspace" the right user-facing word?

### Recommended Defaults

- Same-domain creates suggestions, not automatic workspace sharing.
- First user can create workspace, but no other user's data joins automatically.
- Shared source evidence is opt-in.
- Use "team" in UX, "workspace" in implementation.

### Acceptance Tests

- User can invite teammate.
- Teammate accepts and joins workspace.
- Private loops remain private after workspace creation.
- User can share a loop with teammate.
- Shared report only includes visible loops.
- Source evidence is hidden unless explicitly granted.

### Non-Goals

- Manager surveillance dashboard.
- Enterprise org hierarchy.
- Company-wide ingestion.
- Slack workspace-wide reading.

### Exit Criteria

Phase 7 is done when two people can coordinate through Keeps without breaking the product's privacy promise.

## Phase 8: Pilot Packaging And First Sales Motion

### Purpose

Package Keeps for real design partners and learn whether the wedge earns repeated use and budget.

### User-Facing Outcome

Design partners can onboard, use Keeps with real work, get support, and understand the trust story.

### Prerequisite Assumptions

- Individual product is useful.
- Slack and Calendar work.
- Generated insights work.
- Basic trust and deletion controls exist.

### Build Scope

Pilot operations:

- Pilot onboarding checklist.
- Support and feedback channel.
- Instrumentation for activation and retention.
- Weekly pilot review export.
- Manual override/admin tooling for failed emails and stuck workflows.

Business:

- Pilot pricing page or one-page proposal.
- Terms/privacy draft.
- Private deployment pitch.
- Design partner success criteria.
- Case-study capture process.

Product:

- Friction report: where users stop.
- Quality report: extraction precision and useful nudges.
- Value report: saved loops, approved drafts, repeated commands.

### Data And Events

Tables:

- `pilot_accounts`
- `feedback_items`
- `usage_metrics_daily`
- `support_notes`

Events:

- `pilot.user_activated`
- `pilot.weekly_report_due`
- `feedback.received`

### Agent Behavior

The agent should be conservative in pilots:

- ask clarification when unsure
- avoid external action without approval
- keep private replies concise
- make source evidence easy to inspect

### UX Surface

Pilot materials:

- one-page "How to use Keeps"
- examples of BCC, forward, direct command
- Slack/Calendar setup
- privacy/trust note
- support contact

### Open Design Questions

- Which first ICP should we recruit: founders/operators, customer success, agency operators, or personal executive workflows?
- Should pilots pay from day one?
- What is the smallest price that still tests budget seriousness?
- What is the "changed a decision" moment we are trying to observe?
- What are the top three pilot metrics?

### Recommended Defaults

- Start with 5 to 10 design partners.
- Prefer people with many meetings and scattered obligations.
- Charge at least a pilot fee once the product is stable enough to use.
- Track activation as 3 captured threads in first week.

### Acceptance Tests

- 5 to 10 pilot users can use Keeps with real work email.
- At least 60 percent capture 3 threads in week one.
- At least 50 percent ask for a digest or insight more than once.
- At least one pilot says Keeps prevented a missed loop.
- At least one pilot asks for team/shared graph features.

### Non-Goals

- Enterprise sales process.
- Full self-hosting.
- Broad connector catalog.
- Mobile app.

### Exit Criteria

Phase 8 is done when we know whether Keeps is a repeated habit, a nice demo, or needs a sharper ICP.

## Cross-Phase Risk Register

### Risk: Users Do Not Remember To BCC Or Forward

Early signal:

- low number of captured emails per activated user

Mitigation:

- onboarding examples
- daily email asking "anything to keep today?"
- calendar/meeting prep nudges later
- browser or Gmail extension only if email habit fails

### Risk: Extraction Feels Noisy

Early signal:

- dismissals are high
- users complain reminders are wrong

Mitigation:

- higher confidence threshold
- more clarification questions
- tighter loop schema
- eval set from real examples

### Risk: Generated Views Become A Dashboard By Accident

Early signal:

- product depends on users opening app daily

Mitigation:

- email-first commands
- expiring report links
- digest links into focused views, not global dashboard

### Risk: Connector Commands Are More Demo Than Utility

Early signal:

- people connect Slack/Calendar but rarely approve actions

Mitigation:

- focus on calendar reminders first
- improve drafts
- add Linear only after Slack/Calendar have usage

### Risk: Team Features Feel Like Surveillance

Early signal:

- users hesitate to invite teammates
- users ask what managers can see

Mitigation:

- explicit sharing
- private by default
- source evidence permissions
- team rollups only over shared loops

## Phase 9: Company Graph MCP Server

### Purpose

Expose the permissioned commitment graph to external AI assistants and agents via MCP, making Keeps the organization's memory layer rather than only a nudge interface. This is the hedge against assistant commoditization: Keeps stops competing with Poke-style assistants and starts supplying them.

### User-Facing Outcome

A user (later: a team admin) connects their AI tools — Claude, ChatGPT at work, IDE agents — to their Keeps graph. Those assistants can then answer "what did we promise this customer?", "what's open with this person before my 2pm?", or "what did we decide about pricing in March?" with citations to source evidence, subject to exactly the same permissions the human has granted.

### Prerequisite Assumptions

- Phase 7 team graph and sharing permissions exist (a machine client is modeled as a member with scoped grants).
- Loops reference first-class entities (people, companies) rather than free-text counterparties — promote entities to their own table no later than Phase 7; earlier is cheap and keeps this phase unblocked.
- Phase 6 trust controls (retention, deletion, audit) are live.

### Build Scope

MCP server:

- Remote MCP server (streamable HTTP) with OAuth client authorization; mint/revoke per-client connections.
- Read-only tools first: `search_commitments`, `list_open_loops`, `get_person_brief`, `get_company_brief`, `get_thread_evidence`.
- Permission enforcement identical to the human-facing surface — no machine-only bypass path.
- Audit log of every agent query and which loops/evidence it touched.
- Rate limits per client.

Later (separate decision, not this phase by default):

- Write tools (`create_loop`, `dismiss_loop`, `snooze_loop`) behind the same approval policy as connectors: the external agent proposes, Keeps policy and user approval decide.

### Data And Events

Tables:

- `api_clients` (client id, owner, scopes, status)
- `graph_query_audit` (client, tool, args hash, loops touched, timestamp)

No new domain tables; the graph itself is the existing loops/entities/evidence model.

### Agent Behavior

The graph answers; it never acts. Every response carries source-evidence references so the downstream assistant can cite where a commitment came from. Unanswerable queries return "not in graph" rather than model speculation.

### UX Surface

- Settings page: connect/revoke AI clients, choose scopes (which loop collections a client may read).
- Audit view: what each connected client asked and saw.

### Open Design Questions

- MCP auth flavor: OAuth dynamic client registration vs pre-registered clients.
- Scope granularity for machine clients: per-collection grants vs mirroring per-loop sharing.
- Whether the MCP server is a paid API tier (pricing the graph separately from the assistant).

### Recommended Defaults

- Read-only at launch; write tools only after pilot demand.
- Evidence citations mandatory in every tool response.
- A machine client is a member with scoped grants — one permission model, no parallel system.

### Acceptance Tests

- An external assistant connected over MCP answers a commitments question with correct source citations.
- The same client cannot read any loop outside its granted scope (verified by test fixture).
- Revoking a client takes effect immediately; subsequent calls fail authorization.
- Every query appears in `graph_query_audit`.

## Build Order Summary

1. Product contract and skeleton.
2. Real inbound email.
3. Loop extraction and private replies.
4. Nudges, digests, approvals.
5. Slack and Calendar commands.
6. Generated insight views.
7. Reliability and trust hardening.
8. Individual-to-team transition.
9. Pilot packaging.
10. Company graph MCP server.

If speed matters, Phase 5 and Phase 6 can overlap. Do not start Phase 7 until the individual product shows repeated usage. Phase 9 (MCP) waits for the team graph and permissions, but its cheap prerequisite — first-class entity rows instead of free-text counterparties — should land by Phase 7 at the latest.

## Open Questions To Resolve Before Phase 0 Build

- Auth provider: Clerk, Better Auth/Auth.js, or WorkOS?
- Hosting: Vercel + managed Postgres, Railway, or another stack?
- ORM: Prisma or Drizzle?
- AI SDK shape: direct `generateObject` for extraction first, with tool calling later only behind Keeps-owned policy gates.
- Raw email retention default.
- Exact working style options.
- Whether Calendar reminder creation after explicit direct command needs approval.
- First design partner ICP.

## References

- Postmark inbound webhook: https://postmarkapp.com/developer/webhooks/inbound-webhook
- Inngest steps: https://www.inngest.com/docs/learn/inngest-steps
- Inngest sleep until: https://www.inngest.com/docs/reference/functions/step-sleep-until
- Inngest wait for event: https://www.inngest.com/docs/reference/typescript/v4/functions/step-wait-for-event
- Trigger.dev introduction: https://trigger.dev/docs/introduction
- Temporal timers: https://docs.temporal.io/develop/typescript/workflows/timers
- Upstash Workflow: https://upstash.com/docs/workflow/getstarted
- Nango auth: https://nango.dev/docs/guides/auth/auth-guide
- Nango tool calling: https://nango.dev/docs/guides/functions/tool-calling
- Slack OAuth: https://docs.slack.dev/authentication/installing-with-oauth
- Slack chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage
- Google Calendar create events: https://developers.google.com/workspace/calendar/api/guides/create-events
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI Agents guardrails and approvals: https://developers.openai.com/api/docs/guides/agents/guardrails-approvals
- Vercel AI SDK structured data: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- Vercel AI SDK agents overview: https://ai-sdk.dev/docs/agents/overview
