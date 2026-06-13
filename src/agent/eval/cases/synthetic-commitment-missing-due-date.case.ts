/**
 * synthetic-commitment-missing-due-date
 *
 * An "I'll X" with no due date. Tests:
 *   - loopKind: commitment
 *   - basis: explicit_commitment
 *   - missing due date (dueDateText null)
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-commitment-missing-due-date",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-002",
    mailboxHash: null,
    from: { email: "morgan@example.com", name: "Morgan" },
    to: [{ email: "sam@example.com", name: "Sam" }],
    cc: [],
    subject: "Follow-up on contract",
    textBody: "Sam, I'll review the contract and get back to you.",
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
        // Extractor produces: "You will review the contract and get back to you."
        // (no "by" clause → missing_due_date path, confidence 0.72)
        summary: "You will review the contract and get back to you.",
        kind: "commitment",
        ownerText: "Morgan",
        requesterText: "Sam",
        dueDateText: null,
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
