/**
 * synthetic-empty-body
 *
 * An email with an empty body. The deterministic extractor finds no patterns and
 * produces zero loops (and a clarifying question). Tests:
 *   - empty-body edge case
 *   - expectedLoops: [] (nothing to extract)
 *   - intent: capture (capture-default rule)
 *   - recall = null (no expected loops) → excluded from recall aggregate
 *   - precision = null (no predictions) → excluded from precision aggregate
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-empty-body",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-009",
    mailboxHash: null,
    from: { email: "noreply@example.com", name: null },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Empty",
    textBody: "",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "capture",
    expectedLoops: [],
  },
};

export default evalCase satisfies EvalCase;
