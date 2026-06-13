/**
 * synthetic-reminder-keep-track
 *
 * "Please keep track of X" — the reminder pattern. Tests:
 *   - loopKind: reminder
 *   - basis: inferred_next_step
 *   - missing due date
 *   - intent: capture
 *
 * NOTE: "Please keep track of X" also fires the "can you/could you/please X"
 * ask-pattern, so the extractor produces TWO loops. Both are labeled here so
 * precision does not take a hit on this case.
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-reminder-keep-track",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-007",
    mailboxHash: null,
    from: { email: "avery@example.com", name: "Avery" },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Reminder",
    textBody: "Please keep track of the vendor invoice approval.",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "capture",
    expectedLoops: [
      {
        // Primary pattern: "Track the vendor invoice approval." (reminder, confidence 0.62)
        summary: "Track the vendor invoice approval.",
        kind: "reminder",
        ownerText: "Avery",
        requesterText: "",
        dueDateText: null,
        confidenceBand: "medium",
        expectsClarifyingQuestion: false,
      },
      {
        // Secondary pattern: "can you/could you/please X" also fires here.
        // Extractor: "Follow up on request: keep track of the vendor invoice approval."
        // (ask, confidence 0.66 → medium)
        summary: "Follow up on request: keep track of the vendor invoice approval.",
        kind: "ask",
        ownerText: "Keeps",
        requesterText: "Avery",
        dueDateText: null,
        confidenceBand: "medium",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
