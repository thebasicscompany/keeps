/**
 * synthetic-waiting-on
 *
 * "ENTITY is waiting on X before Y" — the waiting_on pattern. Tests:
 *   - loopKind: waiting_on
 *   - basis: inferred_next_step
 *   - relative due date ("before Y")
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-waiting-on",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-005",
    mailboxHash: null,
    from: { email: "priya@example.com", name: "Priya" },
    to: [{ email: "liam@example.com", name: "Liam" }],
    cc: [],
    subject: "Renewal call",
    textBody: "Liam, Acme is waiting on the discount decision before the renewal call.",
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
        // Extractor: "Acme is waiting on the discount decision before the renewal call."
        summary: "Acme is waiting on the discount decision before the renewal call.",
        kind: "waiting_on",
        ownerText: "",
        requesterText: "Acme",
        dueDateText: "before the renewal call",
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
