/**
 * synthetic-question
 *
 * A trailing-question email with no "can you / could you / please / need to /
 * waiting on" — hits the trailing-question intent rule. Tests:
 *   - intent: question
 *   - expectedLoops: [] (pure question → no actionable loops extracted
 *     deterministically; the body ends with "?" and extractor produces no loops
 *     from this body because no action patterns match)
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-question",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-013",
    mailboxHash: null,
    from: { email: "eli@example.com", name: "Eli" },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Status check",
    textBody: "Did the vendor confirm the delivery date?",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "question",
    expectedLoops: [],
  },
};

export default evalCase satisfies EvalCase;
