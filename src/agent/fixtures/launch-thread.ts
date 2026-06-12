import type { NormalizedEmail } from "@/email/normalize";

export const launchThreadFixture: NormalizedEmail = {
  provider: "fixture",
  providerMessageId: "fixture-launch-thread-001",
  from: {
    email: "arav@example.com",
    name: "Arav",
  },
  to: [
    {
      email: "maya@example.com",
      name: "Maya",
    },
  ],
  cc: [],
  subject: "Launch copy and pricing",
  textBody:
    "Maya, I will send the updated deck by Friday.\n\nCan you confirm the final launch copy?\n\nAcme is waiting on the discount decision before the renewal call.",
  htmlBody: null,
  strippedTextReply: null,
  headers: {},
  attachmentCount: 0,
  attachments: [],
  receivedAt: "2026-06-12T09:00:00.000Z",
};
