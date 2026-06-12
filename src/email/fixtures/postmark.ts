import type { PostmarkInboundPayload } from "@/email/normalize";

const defaultAddress = {
  Email: "arav@example.com",
  Name: "Arav",
  MailboxHash: "",
};

export const directPostmarkFixture: PostmarkInboundPayload = {
  MessageID: "postmark-direct-001",
  MailboxHash: "",
  From: "Arav <arav@example.com>",
  FromFull: defaultAddress,
  To: "agent@keeps.ai",
  ToFull: [
    {
      Email: "agent@keeps.ai",
      Name: "Keeps",
      MailboxHash: "",
    },
  ],
  Cc: "",
  CcFull: [],
  Bcc: "",
  Subject: "Follow up on launch blockers",
  TextBody: "Please keep track of the migration review and the vendor pricing follow-up.",
  HtmlBody: "<p>Please keep track of the migration review and the vendor pricing follow-up.</p>",
  StrippedTextReply: "",
  Date: "2026-06-12T04:30:00.000Z",
  Headers: [
    {
      Name: "Message-ID",
      Value: "<direct-001@example.com>",
    },
  ],
  Attachments: [],
};

export const bccLikePostmarkFixture: PostmarkInboundPayload = {
  ...directPostmarkFixture,
  MessageID: "postmark-bcc-001",
  To: "Sam <sam@example.com>",
  ToFull: [
    {
      Email: "sam@example.com",
      Name: "Sam",
      MailboxHash: "",
    },
  ],
  Subject: "Discount approval",
  TextBody: "Sam, I can approve the discount after finance confirms the margin.",
  HtmlBody: "<p>Sam, I can approve the discount after finance confirms the margin.</p>",
  Headers: [
    {
      Name: "Message-ID",
      Value: "<bcc-001@example.com>",
    },
  ],
};

export const forwardLikePostmarkFixture: PostmarkInboundPayload = {
  ...directPostmarkFixture,
  MessageID: "postmark-forward-001",
  Subject: "Fwd: Partner renewal",
  TextBody: [
    "Can you keep this from slipping?",
    "",
    "---------- Forwarded message ---------",
    "From: Jordan <jordan@example.com>",
    "Date: Thu, Jun 11, 2026 at 5:15 PM",
    "Subject: Partner renewal",
    "To: Arav <arav@example.com>",
    "",
    "We need to send the renewal packet by Tuesday and confirm the discount cap.",
  ].join("\n"),
  HtmlBody: "",
  StrippedTextReply: "Can you keep this from slipping?",
  Headers: [
    {
      Name: "Message-ID",
      Value: "<forward-001@example.com>",
    },
    {
      Name: "References",
      Value: "<partner-renewal-root@example.com> <forward-001@example.com>",
    },
  ],
};

export const nudgeReplyPostmarkFixture: PostmarkInboundPayload = {
  ...directPostmarkFixture,
  MessageID: "postmark-nudge-reply-001",
  MailboxHash: "n_00000000-0000-0000-0000-000000000001",
  To: "agent+n_00000000-0000-0000-0000-000000000001@keeps.ai",
  ToFull: [
    {
      Email: "agent+n_00000000-0000-0000-0000-000000000001@keeps.ai",
      Name: "Keeps",
      MailboxHash: "n_00000000-0000-0000-0000-000000000001",
    },
  ],
  Subject: "Re: Keeps loops",
  TextBody: "dismiss 1",
  HtmlBody: "<p>dismiss 1</p>",
  StrippedTextReply: "dismiss 1",
  Headers: [
    {
      Name: "Message-ID",
      Value: "<nudge-reply-001@example.com>",
    },
    {
      Name: "In-Reply-To",
      Value: "<dev-00000000-0000-0000-0000-000000000001@keeps.local>",
    },
  ],
};

export const correctionPostmarkFixture: PostmarkInboundPayload = {
  ...directPostmarkFixture,
  MessageID: "postmark-correction-001",
  Subject: "Re: Keeps loops",
  TextBody: "correct: the vendor pricing follow-up is owned by Sam, not me",
  HtmlBody: "<p>correct: the vendor pricing follow-up is owned by Sam, not me</p>",
  StrippedTextReply: "correct: the vendor pricing follow-up is owned by Sam, not me",
  Headers: [
    {
      Name: "Message-ID",
      Value: "<correction-001@example.com>",
    },
  ],
};

export const questionPostmarkFixture: PostmarkInboundPayload = {
  ...directPostmarkFixture,
  MessageID: "postmark-question-001",
  Subject: "Re: Keeps loops",
  TextBody: "what are my open loops?",
  HtmlBody: "<p>what are my open loops?</p>",
  StrippedTextReply: "what are my open loops?",
  Headers: [
    {
      Name: "Message-ID",
      Value: "<question-001@example.com>",
    },
  ],
};
