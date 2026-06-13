# Keeps Product Contract

Drafted: 2026-06-12

## Promise

Keeps is a private work memory for open loops. A user can BCC, forward, or directly email `agent@keeps.ai` when something should not slip. Keeps privately extracts loops, nudges the user, and drafts approved actions into connected tools.

## V0 User Contract

Keeps can:

- receive emails sent, forwarded, or BCC'd by the user
- parse those emails for possible loops
- privately reply to the verified sender
- create private loops for the sender
- nudge the sender about loops
- create private generated views
- draft Slack or Calendar actions after connectors are enabled

Keeps cannot in V0:

- respond to other people on an email thread
- send third-party emails
- send Slack messages without approval
- create shared team facts without explicit sharing
- read the user's full mailbox by default
- make private source evidence visible to another user
- train models on customer email content

## External Action Rule

Any action outside the user's private Keeps account is treated as sensitive.

Sensitive actions require an `approval_request` record before execution:

- sending Slack messages
- sending email to anyone other than the user
- creating shared loops
- creating or editing external tasks
- revealing source evidence to another user

Calendar reminders were approval-gated in Phase 0. **Phase 4 loosened this** (see `docs/phases/phase-4-slack-calendar-connectors.md`): gating is now by *reversibility*. A direct `@Calendar` command for a self-only event (no attendees) is reversible — it uses a **confirmation window** (a "cancel within 15 minutes" email; it is added unless cancelled) rather than a hard approval. Anything that touches another person — a Slack DM, or a calendar event *with attendees* — stays hard-approval-gated.

## Vocabulary

### Loop

A tracked open item that might otherwise slip. A loop may be a commitment, ask, waiting-on state, discount, return, bug, customer promise, meeting action, or personal work obligation.

### Nudge

A private reminder sent to the user.

### Draft

A proposed external action that the user must approve before execution.

### Source

The evidence behind a loop: usually an email, message, or span of text.

### Working Style

The user's preferred tone for Keeps.

Initial options:

- `brief`: terse, minimal, direct
- `warm`: concise but softer
- `direct`: clear, explicit, work-oriented
- `chief_of_staff`: structured, proactive, operator-like

## Privacy Defaults

- A forwarded or BCC'd email is private to the verified sender.
- Same-domain users do not automatically share data.
- Team/workspace behavior requires explicit invitation and confirmation.
- Raw email retention should be conservative and user-configurable before pilots.

## Phase 0 Boundaries

Phase 0 may include:

- app shell
- local dev email verification
- working style selection
- database schema
- workflow stubs
- extraction fixture
- placeholder inbound email route

Phase 0 does not include:

- production auth
- real inbound processing
- Postmark production setup
- Slack/Calendar OAuth
- real external sends
- production loop extraction
