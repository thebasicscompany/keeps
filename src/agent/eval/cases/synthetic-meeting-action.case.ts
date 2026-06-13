/**
 * synthetic-meeting-action
 *
 * "We need to X" — the meeting_action / inferred_next_step pattern. Tests:
 *   - loopKind: meeting_action
 *   - basis: inferred_next_step
 *   - missing due date
 *   - intent: capture
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-meeting-action",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-006",
    mailboxHash: null,
    from: { email: "jamie@example.com", name: "Jamie" },
    to: [{ email: "chris@example.com", name: "Chris" }],
    cc: [],
    subject: "Post-meeting notes",
    textBody: "Chris, We need to schedule the onboarding call.",
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
        // Extractor sentenceCase("schedule the onboarding call") → "Schedule the onboarding call."
        summary: "Schedule the onboarding call.",
        kind: "meeting_action",
        ownerText: "We",
        requesterText: "Jamie",
        dueDateText: null,
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
