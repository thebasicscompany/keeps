/**
 * real-example.case.ts
 *
 * SCAFFOLD — demonstrates the format a scrubbed real pilot email takes.
 * This file uses SYNTHETIC content that mimics the structure of a real
 * founder-to-founder email; it is NOT derived from any real user message.
 *
 * HOW TO ADD REAL CASES:
 *   Follow the PII scrubbing procedure in src/agent/eval/README.md (section
 *   "PII scrubbing: turning real pilot emails into anonymized cases").
 *   The remaining ~15 anonymized real cases are HUMAN-GATED: Arav must supply
 *   and scrub them per that procedure before they can be committed here.
 *
 * WHAT THIS CASE SHOWS:
 *   - A realistic two-loop email (one commitment with date + one ask)
 *   - cc field populated (common in real threads)
 *   - strippedTextReply used (Postmark strips the quoted history in replies)
 *   - receivedAt set to a fixed synthetic timestamp so due-date resolution is
 *     deterministic when the harness runs offline
 */

import type { EvalCase } from "@/agent/eval/types";

const evalCase: EvalCase = {
  id: "real-example-scaffold",
  normalized: {
    provider: "fixture",
    providerMessageId: "real-example-001",
    mailboxHash: null,
    from: { email: "person-a@example.com", name: "Person A" },
    to: [{ email: "person-b@example.com", name: "Person B" }],
    cc: [{ email: "person-c@example.com", name: "Person C" }],
    subject: "Northstar partnership next steps",
    // textBody mirrors what the Postmark inbound hook receives for a reply thread.
    // strippedTextReply (below) is what the extractor actually uses (quoted history removed).
    textBody: [
      "Person B,",
      "",
      "I will send the updated partnership terms by Thursday.",
      "",
      "Can you confirm the revised pricing with Person C before the call?",
      "",
      "-- ",
      "Person A",
      "",
      "On Mon, Jun 9, 2026 at 9:00 AM Person B wrote:",
      "> Let's sync on the Northstar deal.",
    ].join("\n"),
    htmlBody: null,
    // strippedTextReply: Postmark strips the quoted "> ..." history.
    strippedTextReply: [
      "Person B,",
      "",
      "I will send the updated partnership terms by Thursday.",
      "",
      "Can you confirm the revised pricing with Person C before the call?",
    ].join("\n"),
    headers: {},
    attachmentCount: 0,
    attachments: [],
    receivedAt: "2026-06-10T09:00:00.000Z",
  },
  label: {
    intent: "capture",
    expectedLoops: [
      {
        // "I will send the updated partnership terms by Thursday."
        // → commitment, explicit_commitment, confidence 0.84 (high)
        summary: "You will send the updated partnership terms by Thursday.",
        kind: "commitment",
        ownerText: "Person A",
        requesterText: "Person B",
        dueDateText: "Thursday",
        confidenceBand: "high",
        expectsClarifyingQuestion: false,
      },
      {
        // "Can you confirm the revised pricing with Person C before the call?"
        // → ask, explicit_commitment, confidence 0.66 (medium)
        summary: "Follow up on request: confirm the revised pricing with Person C before the call.",
        kind: "ask",
        ownerText: "Person B",
        requesterText: "Person A",
        dueDateText: null,
        confidenceBand: "medium",
        expectsClarifyingQuestion: false,
      },
    ],
  },
};

export default evalCase satisfies EvalCase;
