import { z } from "zod";

const postmarkAddressSchema = z.object({
  Email: z.string().email(),
  Name: z.string().optional().default(""),
  MailboxHash: z.string().optional().default(""),
});

const postmarkAttachmentSchema = z.object({
  Name: z.string(),
  ContentType: z.string(),
  ContentLength: z.number(),
  ContentID: z.string().optional(),
});

export const postmarkInboundSchema = z.object({
  MessageID: z.string().min(1),
  MailboxHash: z.string().optional().default(""),
  From: z.string().min(1),
  FromFull: postmarkAddressSchema,
  To: z.string().default(""),
  ToFull: z.array(postmarkAddressSchema).default([]),
  Cc: z.string().default(""),
  CcFull: z.array(postmarkAddressSchema).default([]),
  Bcc: z.string().optional().default(""),
  Subject: z.string().default(""),
  TextBody: z.string().default(""),
  HtmlBody: z.string().default(""),
  StrippedTextReply: z.string().optional().default(""),
  Date: z.string().optional(),
  Headers: z
    .array(
      z.object({
        Name: z.string(),
        Value: z.string(),
      }),
    )
    .default([]),
  Attachments: z
    .array(postmarkAttachmentSchema)
    .default([]),
});

export type PostmarkInboundPayload = z.infer<typeof postmarkInboundSchema>;

export type NormalizedEmailAddress = {
  email: string;
  name: string | null;
};

export type NormalizedAttachment = {
  name: string;
  contentType: string;
  contentLength: number;
  contentId: string | null;
};

export type NormalizedEmail = {
  provider: "postmark" | "fixture";
  providerMessageId: string;
  mailboxHash: string | null;
  from: NormalizedEmailAddress;
  to: NormalizedEmailAddress[];
  cc: NormalizedEmailAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  strippedTextReply: string | null;
  headers: Record<string, string>;
  attachmentCount: number;
  attachments: NormalizedAttachment[];
  receivedAt: string | null;
};

export function normalizePostmarkInbound(payload: unknown): NormalizedEmail {
  const parsed = postmarkInboundSchema.parse(payload);

  return {
    provider: "postmark",
    providerMessageId: parsed.MessageID,
    mailboxHash: parsed.MailboxHash || null,
    from: normalizeAddress(parsed.FromFull),
    to: parsed.ToFull.map(normalizeAddress),
    cc: parsed.CcFull.map(normalizeAddress),
    subject: parsed.Subject,
    textBody: parsed.TextBody,
    htmlBody: parsed.HtmlBody || null,
    strippedTextReply: parsed.StrippedTextReply || null,
    headers: Object.fromEntries(parsed.Headers.map((header) => [header.Name.toLowerCase(), header.Value])),
    attachmentCount: parsed.Attachments.length,
    attachments: parsed.Attachments.map(normalizeAttachment),
    receivedAt: parsed.Date ?? null,
  };
}

export function normalizeAddress(address: z.infer<typeof postmarkAddressSchema>): NormalizedEmailAddress {
  return {
    email: address.Email.toLowerCase(),
    name: address.Name.trim() || null,
  };
}

export function normalizeAttachment(attachment: z.infer<typeof postmarkAttachmentSchema>): NormalizedAttachment {
  return {
    name: attachment.Name,
    contentType: attachment.ContentType,
    contentLength: attachment.ContentLength,
    contentId: attachment.ContentID ?? null,
  };
}
