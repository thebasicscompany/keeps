/**
 * synthetic-ask-request
 *
 * A "Can you X?" email — the deterministic extractor's "can you / could you /
 * please" pattern. Tests:
 *   - loopKind: ask
 *   - basis: explicit_commitment
 *   - intent: capture (not a question per intent rules because "can you" is present)
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-ask-request",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-004",
    mailboxHash: null,
    from: { email: "casey@example.com", name: "Casey" },
    to: [{ email: "drew@example.com", name: "Drew" }],
    cc: [],
    subject: "Budget approval",
    textBody: "Drew, can you approve the budget proposal before the board meeting.",
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
        // Extractor: "Follow up on request: approve the budget proposal before the board meeting."
        summary: "Follow up on request: approve the budget proposal before the board meeting.",
        kind: "ask",
        ownerText: "Drew",
        requesterText: "Casey",
        dueDateText: null,
        confidenceBand: "medium",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
