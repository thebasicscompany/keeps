/**
 * synthetic-approval-reply
 *
 * An "approve" reply — the approval-prefix intent rule. Tests:
 *   - intent: approval
 *   - expectedLoops: [] (approval confirms an existing loop; no new extraction)
 *   - No loops expected → precision/recall null for this case (excluded from
 *     aggregate), validates intent only.
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-approval-reply",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-011",
    mailboxHash: null,
    from: { email: "user@example.com", name: "User" },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Re: Connector action pending",
    textBody: "approve",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "approval",
    expectedLoops: [],
  },
};

export default evalCase satisfies EvalCase;
