/**
 * synthetic-low-confidence-slipping
 *
 * "keep this from slipping" with no other extractable patterns — triggers the
 * low-confidence fallback (confidence 0.42 → band "low"). Tests:
 *   - loopKind: reminder
 *   - basis: inferred_next_step
 *   - expectsClarifyingQuestion: true (extractor asks when all loops are low-conf)
 *   - confidenceBand: low
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-low-confidence-slipping",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-008",
    mailboxHash: null,
    from: { email: "quinn@example.com", name: "Quinn" },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Northstar partnership",
    textBody: "Heads up — just want to keep this from slipping on our partnership discussion with Northstar.",
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
        // Extractor: "Track the referenced follow-up." (confidence 0.42 → "low")
        summary: "Track the referenced follow-up.",
        kind: "reminder",
        ownerText: "Quinn",
        requesterText: "",
        dueDateText: null,
        confidenceBand: "low",
        expectsClarifyingQuestion: true,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
