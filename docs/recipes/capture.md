# Getting email into Keeps

Keeps reads only the mail you explicitly route to it. This document describes each way to do that.

---

## BCC or forward at write time

**BCC**: when composing an email, add `agent@keeps.email` to the BCC field. The message is captured once it is sent.

**Forward**: if you received an email you want captured, forward it to `agent@keeps.email`. That single message is saved.

Both methods capture the one message. No further messages in the conversation are picked up unless you take one of the actions below.

---

## CC once, the whole thread is covered

Add `agent@keeps.email` to CC on any message in a thread. From that point, subsequent replies from other participants on that same thread are captured automatically — you do not need to CC Keeps again.

This works because email threads carry a shared reference chain in their headers. Only participants already on the thread can trigger further captures; there is no way for an unrelated party to attach their mail to your thread.

---

## Gmail filter auto-forward (user-owned)

You can route a class of mail automatically by creating a Gmail filter that forwards matching messages to `agent@keeps.email`.

**Steps:**

1. Open Gmail Settings → **See all settings** → **Filters and Blocked Addresses** → **Create a new filter**.
2. Set your matching criteria (for example, `From: vendor@example.com`).
3. Click **Create filter**, then check **Forward it to** and enter `agent@keeps.email`.

**Confirming the forwarding address:** Gmail requires a one-time confirmation before it will forward to any new address. The confirmation email is sent to `agent@keeps.email`, which means it arrives at our inbound webhook and is stored as a row in `pending_inbound_emails`. During onboarding, the Keeps team retrieves the confirmation link from that row and completes the verification on your behalf. Self-serve visibility into that step will be added in a later release.

Once confirmed, every message matching your filter is forwarded automatically — no further action needed on individual emails.

---

## The consent boundary

Keeps never reads mail you did not explicitly route to it.

Explicit capture is a consent boundary, not a friction bug to engineer away. The capture aperture grows only through deliberate user acts — CCing the agent on a thread, creating a forwarding filter, connecting a calendar — whose coverage then continues automatically. Keeps does not silently widen what it reads beyond what those acts cover.

This matters in trust-sensitive environments: colleagues and counterparties whose messages end up in Keeps do so because you, as a participant on that thread, chose to capture it.
