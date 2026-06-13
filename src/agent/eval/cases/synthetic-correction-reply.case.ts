/**
 * synthetic-correction-reply
 *
 * A "correct" prefixed reply — the correction-prefix intent rule. Tests:
 *   - intent: correction
 *   - expectedLoops: [] (correction updates an existing loop; no new extraction)
 *   - No loops expected → precision/recall null for this case (excluded from
 *     aggregate), validates intent classification only.
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-correction-reply",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-012",
    mailboxHash: null,
    from: { email: "user@example.com", name: "User" },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Re: Loop update",
    textBody: "correct — the deadline is Thursday, not Friday.",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "correction",
    expectedLoops: [],
  },
};

export default evalCase satisfies EvalCase;
