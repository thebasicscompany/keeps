/**
 * synthetic-commitment-absolute-date
 *
 * A plain "I will X by DATE" email — the deterministic extractor's strongest
 * pattern (confidence 0.84). Tests:
 *   - loopKind: commitment
 *   - basis: explicit_commitment
 *   - absolute due date (specific day-name → relative resolver returns a weekday)
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-commitment-absolute-date",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-001",
    mailboxHash: null,
    from: { email: "sender@example.com", name: "Alex" },
    to: [{ email: "recipient@example.com", name: "Jordan" }],
    cc: [],
    subject: "Project deliverable",
    textBody: "Jordan, I will send the final report by Friday.",
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
        // Extractor produces: "You will send the final report by Friday."
        summary: "You will send the final report by Friday.",
        kind: "commitment",
        ownerText: "Alex",
        requesterText: "Jordan",
        dueDateText: "Friday",
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
