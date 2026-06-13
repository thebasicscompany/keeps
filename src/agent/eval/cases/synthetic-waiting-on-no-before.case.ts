/**
 * synthetic-waiting-on-no-before
 *
 * "ENTITY is waiting on X" with no "before" clause — missing due date variant
 * of the waiting_on pattern. Tests:
 *   - loopKind: waiting_on
 *   - basis: inferred_next_step
 *   - missing due date (no "before" clause)
 *   - intent: capture
 *
 * NOTE: The waiting_on regex requires the entity to start with an uppercase letter
 * ([A-Z][A-Za-z0-9& ]{1,40}), so the body begins the entity with a capital.
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "synthetic-waiting-on-no-before",
  normalized: {
    provider: "fixture",
    providerMessageId: "synthetic-015",
    mailboxHash: null,
    from: { email: "reese@example.com", name: "Reese" },
    to: [{ email: "blake@example.com", name: "Blake" }],
    cc: [],
    subject: "Engineering blocker",
    textBody: "Blake, Engineering is waiting on the API spec from the product team.",
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
        // Extractor regex: /\b([A-Z][A-Za-z0-9& ]{1,40})\s+is waiting on\s+([^.\n]+?)(?:\s+before\s+([^.\n]+?))?(?=[.\n])/g
        // match[1] = "Engineering", match[2] = "the API spec from the product team"
        // summary: "Engineering is waiting on the API spec from the product team."
        summary: "Engineering is waiting on the API spec from the product team.",
        kind: "waiting_on",
        ownerText: "",
        requesterText: "Engineering",
        dueDateText: null,
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
