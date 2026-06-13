/**
 * synthetic-inferred-approval-condition
 *
 * "I can approve X after Y" — the conditional-approval inferred_next_step pattern.
 * Tests:
 *   - loopKind: commitment
 *   - basis: inferred_next_step  (the extractor uses inferred_next_step for this pattern)
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-inferred-approval-condition",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-014",
    mailboxHash: null,
    from: { email: "dana@example.com", name: "Dana" },
    to: [{ email: "pat@example.com", name: "Pat" }],
    cc: [],
    subject: "Expense approval",
    textBody: "Pat, I can approve the travel expenses after you submit the receipts.",
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
        // Extractor: "You can approve the travel expenses after you submit the receipts."
        summary: "You can approve the travel expenses after you submit the receipts.",
        kind: "commitment",
        ownerText: "Dana",
        requesterText: "Pat",
        dueDateText: null,
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
