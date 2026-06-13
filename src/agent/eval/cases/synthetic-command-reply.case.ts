/**
 * synthetic-command-reply
 *
 * A "dismiss N" command reply — the command-prefix intent rule. Tests:
 *   - intent: command
 *   - expectedLoops: [] (command emails don't produce new loops)
 *   - No loops expected, so precision/recall for this case are null (excluded
 *     from aggregate) — the case validates intent classification only.
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-command-reply",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-010",
    mailboxHash: null,
    from: { email: "user@example.com", name: "User" },
    to: [{ email: "keeps@example.com", name: "Keeps" }],
    cc: [],
    subject: "Re: Weekly digest",
    textBody: "dismiss 3",
    htmlBody: null,
    strippedTextReply: null,
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "command",
    expectedLoops: [],
  },
};

export default evalCase satisfies EvalCase;
