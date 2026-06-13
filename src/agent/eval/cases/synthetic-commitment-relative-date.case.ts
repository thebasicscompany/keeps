/**
 * synthetic-commitment-relative-date
 *
 * "I will X by WEEKDAY" — the extractor resolves the weekday to an ISO datetime
 * with uncertainty="relative". Tests:
 *   - loopKind: commitment
 *   - basis: explicit_commitment
 *   - relative due date (weekday name)
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-commitment-relative-date",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-003",
    mailboxHash: null,
    from: { email: "riley@example.com", name: "Riley" },
    to: [{ email: "taylor@example.com", name: "Taylor" }],
    cc: [],
    subject: "Design mockups",
    textBody: "Taylor, I will share the design mockups by Wednesday.",
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
        // Extractor: "You will share the design mockups by Wednesday."
        summary: "You will share the design mockups by Wednesday.",
        kind: "commitment",
        ownerText: "Riley",
        requesterText: "Taylor",
        dueDateText: "Wednesday",
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
